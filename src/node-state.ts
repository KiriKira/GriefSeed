import { createHash } from "node:crypto";
import { NodeBudget } from "./node-budget";
import { NodePush } from "./node-push";
import { NodeRTC } from "./node-rtc";
import { NodeStore } from "./node-store";
import { NodeAuth, type Principal } from "./node-auth";
import {
  type Data,
  requireThat,
  validate,
  string,
  integer,
  array,
  record,
  uuid,
  canonical,
  normaliseIDs,
  hash,
  iso,
  cursor,
  parseCursor,
  NodeError,
} from "./node-protocol";
import { json, error, readJson, HttpInputError } from "./http";
import type { Env } from "./index";
const extensions = [
  "sim_radio",
  "sim_country",
  "mesh",
  "client_ping_v1",
  "rtc_control_ws_v1",
  "cold_standby_v1",
];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const result = (body: unknown, status = 200) => ({ body, status });
/** HTTP domain adapter. All mutating route work below is synchronous inside one SQLite transaction. */
export class NodeState {
  readonly store: NodeStore;
  readonly auth: NodeAuth;
  readonly rtc: NodeRTC;
  readonly push: NodePush;
  readonly budget: NodeBudget;
  constructor(
    sql: SqlStorage,
    storage: DurableObjectStorage,
    private env: Env,
    private ice: (p: Principal) => Promise<Data>,
  ) {
    this.store = new NodeStore(sql, storage);
    this.auth = new NodeAuth(this.store, env);
    this.budget = new NodeBudget(this.store);
    this.push = new NodePush(this.store, env, (p) => this.auth.recheck(p));
    this.rtc = new NodeRTC(this.store, (g, s, r) => this.checkSIM(g, s, r));
  }
  sweep() {
    this.store.storage.transactionSync(() => {
      this.expire();
      this.rtc.sweep();
      this.budget.cleanup();
    });
  }
  nextDeadline(): number | null {
    const times: number[] = [];
    for (const row of this.store.sql
      .exec<{
        body: string;
      }>(
        "SELECT body FROM node_records WHERE kind='call' AND json_extract(body,'$.state') NOT IN ('ended','unknown') LIMIT 1024",
      )
      .toArray()) {
      const call = record(JSON.parse(row.body));
      times.push(Number(call._gateway_seen) + 20_000);
      if (call.candidate_until && !call.winner_client_id)
        times.push(Date.parse(string(call.candidate_until)));
      if (call.direction === "outgoing" || call.winner_client_id)
        times.push(Number(call._client_seen) + 20_000);
      if (call.state !== "active")
        times.push(Date.parse(string(call.expires_at)));
    }
    const legDeadline = this.store.sql
      .exec<{
        next: number | null;
      }>(
        "SELECT MIN(CASE WHEN json_extract(body,'$.phase')='negotiated' THEN json_extract(body,'$.authorized') ELSE MIN(json_extract(body,'$.authorized'),json_extract(body,'$.negotiation')) END) next FROM node_records WHERE kind='leg' AND json_extract(body,'$.phase')<>'closed'",
      )
      .one().next;
    if (legDeadline !== null) times.push(legDeadline);
    const outbox = this.store.sql
      .exec<{
        next: number | null;
      }>("SELECT MIN(next_try) AS next FROM node_outbox")
      .one().next;
    if (outbox !== null) times.push(outbox);
    const sms = this.store.sql
      .exec<{
        next: number | null;
      }>(
        "SELECT MIN((julianday(json_extract(body,'$.expires_at'))-2440587.5)*86400000) AS next FROM node_records WHERE kind='command' AND json_extract(body,'$.state')='queued'",
      )
      .one().next;
    if (sms !== null) times.push(sms);
    return times.length ? Math.min(...times) : null;
  }
  private gateway(id: string): Data {
    const value = this.store.get("gateway", id);
    requireThat(value, "NOT_FOUND", 404);
    return value;
  }
  private guardGateway(p: Principal, id: string) {
    requireThat(p.role === "gateway" && p.id === id, "GATEWAY_REQUIRED", 403);
  }
  private client(p: Principal) {
    requireThat(p.role === "client", "CLIENT_REQUIRED", 403);
  }
  private ownsSIM(id: string, gateway: string): Data {
    const sim = this.store.get("sim", id);
    requireThat(sim && sim.gateway_id === gateway, "SIM_MAPPING_CONFLICT", 409);
    return sim;
  }
  private checkSIM(gateway: string, simId: string, revision: number): Data {
    const sim = this.ownsSIM(simId, gateway);
    const g = this.gateway(gateway);
    requireThat(
      g.mapping_revision === revision &&
        sim.mapping_revision === revision &&
        sim.state === "active" &&
        sim.identity_verified === true,
      "SIM_MAPPING_CONFLICT",
      409,
    );
    return sim;
  }
  private changeMessage(message: Data, type = "message.state_changed"): void {
    this.store.put(
      "message",
      string(message.message_id),
      string(message.gateway_id),
      message,
    );
    const event = {
      event_id: crypto.randomUUID(),
      type,
      occurred_at: iso(),
      message,
    };
    this.store.feed(event);
    this.store.sql.exec(
      "INSERT INTO node_outbox(id,device,kind,payload) VALUES (?,?,?,?)",
      event.event_id,
      "clients",
      "wake",
      canonical(event),
    );
  }
  private expire(): void {
    for (const command of this.store.select(
      "command",
      "json_extract(body,'$.state')='queued'",
    ))
      if (
        command.state === "queued" &&
        Date.parse(string(command.expires_at)) <= Date.now()
      ) {
        command.state = "expired";
        this.store.put(
          "command",
          string(command.command_id),
          string(command.gateway_id),
          command,
        );
        const message = this.store.get("message", string(command.message_id));
        if (message) {
          message.status = "expired";
          this.changeMessage(message);
        }
      }
  }
  async fetch(request: Request, supplied?: Principal): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      const body =
        (method === "POST" || method === "PUT") &&
        !path.startsWith("/v1/devices/self/push-endpoint")
          ? record(normaliseIDs(await readJson(request, 512 * 1024)))
          : {};
      if (path === "/v1/pairings/claim" && method === "POST") {
        this.budget.consume(
          "pair:" +
            String(request.headers.get("CF-Connecting-IP") || "unknown"),
          100,
          3600_000,
        );
        return json(await this.auth.claim(body));
      }
      if (path === "/v1/auth/refresh" && method === "POST") {
        this.budget.consume(
          "refresh:" +
            String(request.headers.get("CF-Connecting-IP") || "unknown"),
          300,
          3600_000,
        );
        if (supplied) this.auth.recheck(supplied);
        return json(
          await this.auth.refresh(
            body,
            request.headers.get("Idempotency-Key"),
            supplied?.id,
          ),
        );
      }
      const p = supplied || (await this.auth.authenticate(request));
      this.auth.recheck(p);
      const critical =
        (/^\/v1\/rtc\/control\/calls\/[0-9a-f-]+\/operations$/.test(path) &&
          ["ended", "declined", "hangup", "cancel"].includes(
            String(body.kind),
          )) ||
        (/^\/v1\/rtc\/legs\/[0-9a-f-]+$/.test(path) && body.kind === "close") ||
        path === "/v1/auth/revoke" ||
        (method === "GET" &&
          /^\/v1\/rtc\/control\/calls\/[0-9a-f-]+$/.test(path));
      const configured = Number(this.env.DEVICE_DAILY_BUDGET || "100000");
      requireThat(
        Number.isSafeInteger(configured) && configured >= 100,
        "INVALID_BUDGET",
        503,
      );
      this.budget.consume(
        (critical ? "end:" : "device:") + p.id,
        critical ? 1000 : configured,
        86400_000,
      );
      this.sweep();
      if (path.startsWith("/v1/devices/self/push-endpoint")) {
        const response = await this.push.route(request, p);
        this.auth.recheck(p);
        if (response) return response;
      }
      if (path === "/v1/rtc/ice-servers" && method === "GET") {
        const ice = await this.ice(p);
        this.auth.recheck(p);
        return json(ice);
      }
      const bodyHash = await hash(canonical(body));
      const output = this.store.storage.transactionSync(() => {
        this.auth.recheck(p);
        this.expire();
        if (path === "/v1/auth/revoke" && method === "POST") {
          validate("RefreshRequest", body);
          this.auth.revoke(
            p,
            createHash("sha256")
              .update(string(body.refresh_token))
              .digest("base64url"),
          );
          const relay = createHash("sha256")
            .update("node-relay:" + p.id)
            .digest("base64url");
          this.store.sql.exec(
            "UPDATE tokens SET revoked=COALESCE(revoked,?) WHERE id=? AND kind=?",
            Date.now(),
            relay,
            "node",
          );
          this.store.sql.exec(
            "UPDATE credentials SET pending=1,next_try=0 WHERE token_id=? AND expires>?",
            relay,
            Date.now(),
          );
          this.store.remove("ice-cache", p.id);
          return { body: null, status: 204 };
        }
        if (path === "/v1/clients" && method === "GET") {
          this.client(p);
          return result({
            items: this.store.sql
              .exec<{
                id: string;
                role: string;
                name: string;
                platform: string;
                state: string;
              }>("SELECT * FROM node_devices WHERE role=?", "client")
              .toArray()
              .map((d) => ({
                id: d.id,
                name: d.name,
                platform: d.platform,
                state: d.state,
                is_self: d.id === p.id,
                live:
                  this.store.sql
                    .exec(
                      "SELECT id FROM node_sessions WHERE device=? AND refresh_expires>?",
                      d.id,
                      Date.now(),
                    )
                    .toArray().length > 0,
              })),
          });
        }
        if (path === "/v1/gateways" && method === "GET")
          return result({
            items: this.store
              .list("gateway")
              .filter((g) => p.role === "client" || g.gateway_id === p.id)
              .map((g) => {
                const d = this.store.sql
                  .exec<{
                    name: string;
                    state: string;
                  }>(
                    "SELECT name,state FROM node_devices WHERE id=?",
                    string(g.gateway_id),
                  )
                  .one();
                return {
                  gateway_id: g.gateway_id,
                  device_name: d.name,
                  online:
                    d.state === "active" &&
                    Number(g.last_seen) > Date.now() - 90_000,
                  last_seen_at: g.last_seen ? iso(Number(g.last_seen)) : null,
                  mapping_revision: g.mapping_revision,
                  sequence: g.sequence || null,
                  protocol_version: g.protocol_version || null,
                  app_version: g.app_version || null,
                  root: g.root ?? null,
                  battery_percent: g.battery_percent ?? null,
                  charging: g.charging ?? null,
                  install_id: g.install_id ?? null,
                  rtc_call_control_ready:
                    this.store.get("rtc-capability", string(g.gateway_id))
                      ?.enabled === true &&
                    Number(
                      this.store.get("rtc-capability", string(g.gateway_id))
                        ?.seen,
                    ) >
                      Date.now() - 90_000,
                };
              }),
          });
        const simPath = path.match(/^\/v1\/gateways\/([^/]+)\/sims$/);
        if (simPath && method === "GET") {
          const id = uuid(simPath[1]);
          if (p.role === "gateway") this.guardGateway(p, id);
          return result({
            mapping_revision: this.gateway(id).mapping_revision,
            sims: this.store.list("sim", id),
          });
        }
        const heartbeat = path.match(/^\/v1\/gateways\/([^/]+)\/heartbeat$/);
        if (heartbeat && method === "POST")
          return result(this.heartbeat(p, uuid(heartbeat[1]), body, bodyHash));
        const binding = path.match(/^\/v1\/gateways\/([^/]+)\/sim-bindings$/);
        if (binding && method === "POST") {
          const id = uuid(binding[1]);
          this.guardGateway(p, id);
          const operation = uuid(body.operation_id);
          const phase = string(body.phase);
          return this.store.replay(
            `sim:${id}:${phase}`,
            operation,
            bodyHash,
            () => result(this.bindSIM(id, body)),
          );
        }
        if (path === "/v1/messages" && method === "POST") {
          this.client(p);
          validate("CreateMessage", body);
          const key = request.headers.get("Idempotency-Key");
          requireThat(
            key && key.length >= 16 && key.length <= 128,
            "IDEMPOTENCY_KEY_REQUIRED",
          );
          return this.store.replay(`message:${p.id}`, key, bodyHash, () =>
            result(this.createMessage(body), 201),
          );
        }
        if (path === "/v1/messages" && method === "GET") {
          this.client(p);
          const limit = Math.min(
            100,
            Math.max(1, Number(url.searchParams.get("limit")) || 50),
          );
          const after = url.searchParams.get("cursor");
          let boundary: Data | undefined;
          if (after) {
            try {
              const text = atob(after.replace(/-/g, "+").replace(/_/g, "/"));
              const split = text.lastIndexOf("|");
              const created = text.slice(0, split),
                id = uuid(text.slice(split + 1));
              requireThat(
                split > 0 && Number.isFinite(Date.parse(created)),
                "INVALID_CURSOR",
              );
              boundary = { created_at: created, message_id: id };
            } catch {
              throw new NodeError(400, "INVALID_CURSOR");
            }
          }
          const sim = url.searchParams.get("sim_id");
          if (sim)
            requireThat(this.store.get("sim", uuid(sim)), "NOT_FOUND", 404);
          const where: string[] = [];
          const args: (string | number | null)[] = [];
          if (sim) {
            where.push("json_extract(body,'$.sim_id')=?");
            args.push(sim);
          }
          if (boundary) {
            where.push(
              "(julianday(json_extract(body,'$.created_at')),id)<(julianday(?),?)",
            );
            args.push(string(boundary.created_at), string(boundary.message_id));
          }
          const all = this.store.select(
            "message",
            where.join(" AND "),
            args,
            "julianday(json_extract(body,'$.created_at')) DESC,id DESC",
            limit + 1,
          );
          const items = all.slice(0, limit);
          return result({
            items,
            next_cursor:
              all.length > limit
                ? this.messageCursor(items[items.length - 1])
                : null,
            resync_required: false,
          });
        }
        const message = path.match(/^\/v1\/messages\/([^/]+)$/);
        if (message && method === "GET") {
          this.client(p);
          const found = this.store.get("message", uuid(message[1]));
          requireThat(found, "NOT_FOUND", 404);
          return result(found);
        }
        const command = path.match(
          /^\/v1\/gateways\/([^/]+)\/commands(?:\/([^/]+)\/claim)?$/,
        );
        if (command) {
          const gateway = uuid(command[1]);
          this.guardGateway(p, gateway);
          if (command[2] && method === "POST")
            return result(this.claim(gateway, uuid(command[2]), body));
          if (!command[2] && method === "GET") {
            const limit = Math.min(
              100,
              Math.max(1, Number(url.searchParams.get("limit")) || 100),
            );
            const after = url.searchParams.get("cursor");
            const args: (string | number | null)[] = [gateway];
            let where =
              "device=? AND json_extract(body,'$.state') IN ('queued','accepted_by_gateway','dispatching')";
            if (after) {
              const decoded = this.decodePageCursor(after);
              where +=
                " AND (julianday(json_extract(body,'$.created_at')),id)>(julianday(?),?)";
              args.push(decoded.time, decoded.id);
            }
            const all = this.store.select(
              "command",
              where,
              args,
              "julianday(json_extract(body,'$.created_at')),id",
              limit + 1,
            );
            const items = all.slice(0, limit);
            return result({
              commands: items,
              next_cursor:
                all.length > limit
                  ? this.pageCursor(
                      string(items[items.length - 1].created_at),
                      string(items[items.length - 1].command_id),
                    )
                  : null,
            });
          }
        }
        const events = path.match(/^\/v1\/gateways\/([^/]+)\/events:batch$/);
        if (events && method === "POST") {
          this.guardGateway(p, uuid(events[1]));
          return result(this.events(p, body));
        }
        if (path === "/v1/events" && method === "GET") {
          this.client(p);
          const last = parseCursor(url.searchParams.get("cursor"));
          const limit = Math.min(
            100,
            Math.max(1, Number(url.searchParams.get("limit")) || 50),
          );
          const rows = this.store.sql
            .exec<{
              cursor: number;
              event: string;
            }>(
              "SELECT * FROM node_feed WHERE cursor>? ORDER BY cursor LIMIT ?",
              last,
              limit + 1,
            )
            .toArray();
          const items = rows.slice(0, limit).map((row) => {
            const event = record(JSON.parse(row.event));
            const snapshot = record(event.message);
            return {
              ...event,
              cursor: cursor(row.cursor),
              message: this.store.get("message", string(snapshot.message_id)),
            };
          });
          return result({
            items,
            next_cursor:
              rows.length > limit ? cursor(rows[limit - 1].cursor) : null,
            resync_required: false,
          });
        }
        if (path === "/v1/events/ack" && method === "POST") {
          this.client(p);
          const sequence = parseCursor(string(body.durable_cursor));
          const max =
            this.store.sql
              .exec<{
                max: number | null;
              }>("SELECT MAX(cursor) AS max FROM node_feed")
              .one().max || 0;
          requireThat(sequence <= max, "INVALID_CURSOR");
          const old = this.store.get("receipt", p.id);
          const retained = Math.max(Number(old?.cursor || 0), sequence);
          const response = {
            durable_cursor: cursor(retained),
            confirmed_at: iso(),
            events_retained: true,
          };
          this.store.put("receipt", p.id, p.id, {
            cursor: retained,
            ...response,
          });
          return result(response);
        }
        if (path === "/v1/devices/self/reception") {
          this.client(p);
          const old = this.store.get("reception", p.id) || {
            version: 1,
            incoming_enabled: false,
            sms_enabled: true,
            revision: 0,
          };
          if (method === "GET") return result(old);
          if (method === "PUT") {
            validate("ReceptionUpdate", body);
            requireThat(
              body.expected_revision === old.revision,
              "RECEPTION_REVISION_CONFLICT",
              409,
            );
            const next = {
              version: 2,
              incoming_enabled: body.incoming_enabled ?? old.incoming_enabled,
              sms_enabled: body.sms_enabled ?? old.sms_enabled,
              revision: Number(old.revision) + 1,
            };
            this.store.put("reception", p.id, p.id, next);
            if (old.sms_enabled === false && next.sms_enabled === true)
              this.store.sql.exec(
                "INSERT INTO node_outbox(id,device,kind,payload) VALUES (?,?,?,?)",
                crypto.randomUUID(),
                p.id,
                "wake",
                canonical({ reception_resumed: true }),
              );
            return result(next);
          }
        }
        if (path === "/v1/devices/self/rtc-capability" && method === "POST") {
          requireThat(
            p.role === "gateway" &&
              body.version === 1 &&
              Object.keys(body).length === 1,
            "INVALID_RTC_CAPABILITY",
          );
          return result({ version: 1, media_transport: "webrtc" });
        }
        if (path === "/v1/calls" && method === "GET") {
          const limit = Math.min(
            100,
            Math.max(1, Number(url.searchParams.get("limit")) || 50),
          );
          const after = url.searchParams.get("cursor");
          const args: (string | number | null)[] = [p.id, p.id, p.id];
          let where =
            "(device=? OR json_extract(body,'$.client_id')=? OR EXISTS (SELECT 1 FROM json_each(json_extract(body,'$._participants')) WHERE key=?))";
          if (after) {
            const decoded = this.decodePageCursor(after);
            where +=
              " AND (julianday(json_extract(body,'$.created_at')),id)<(julianday(?),?)";
            args.push(decoded.time, decoded.id);
          }
          const all = this.store.select(
            "call",
            where,
            args,
            "julianday(json_extract(body,'$.created_at')) DESC,id DESC",
            limit + 1,
          );
          const items = all.slice(0, limit);
          return result({
            items: items.map((call) => this.rtc.snapshot(p, call)),
            next_cursor:
              all.length > limit
                ? this.pageCursor(
                    string(items[items.length - 1].created_at),
                    string(items[items.length - 1].call_id),
                  )
                : null,
            resync_required: false,
          });
        }
        const rtc = this.rtc.route(p, path, method, body);
        if (rtc) return rtc;
        throw new NodeError(404, "NOT_FOUND");
      });
      if (output.status === 204) return new Response(null, { status: 204 });
      if ("iceFor" in output) {
        const ice = await this.ice(p);
        this.auth.recheck(p);
        // Recheck the call/media authority after the external credential request.
        const current = this.store.storage.transactionSync(() =>
          this.rtc.route(p, path, "GET", {}),
        );
        requireThat(current, "RTC_FORBIDDEN", 403);
        return json({ ...record(current.body), ...ice }, current.status);
      }
      return json(output.body, output.status);
    } catch (failure) {
      if (failure instanceof HttpInputError)
        return error(failure.code, failure.status);
      return failure instanceof NodeError
        ? failure.status === 429
          ? json(
              {
                error: {
                  code: failure.code,
                  message: failure.code,
                  retryable: true,
                },
              },
              429,
              {
                "Retry-After": String(
                  Math.max(
                    1,
                    Math.ceil((86400_000 - (Date.now() % 86400_000)) / 1000),
                  ),
                ),
              },
            )
          : error(failure.code, failure.status)
        : error("NODE_UNAVAILABLE", 503);
    }
  }
  private pageCursor(time: string, id: string): string {
    return btoa(time + "|" + id)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  private decodePageCursor(value: string): { time: string; id: string } {
    try {
      const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
      const [time, id] = decoded.split("|");
      requireThat(
        Number.isFinite(Date.parse(time)) &&
          this.pageCursor(time, uuid(id)) === value,
        "INVALID_CURSOR",
      );
      return { time, id };
    } catch {
      throw new NodeError(400, "INVALID_CURSOR");
    }
  }
  private messageCursor(m: Data): string {
    return this.pageCursor(string(m.created_at), string(m.message_id));
  }
  private heartbeat(
    p: Principal,
    id: string,
    body: Data,
    digest: string,
  ): Data {
    this.guardGateway(p, id);
    validate("HeartbeatRequest", body);
    const old = this.gateway(id);
    const seq = integer(body.sequence);
    const invalidated: string[] = [];
    requireThat(
      seq >= Number(old.sequence),
      "HEARTBEAT_SEQUENCE_CONFLICT",
      409,
    );
    if (seq === old.sequence) {
      requireThat(old.heartbeat_hash === digest, "IDEMPOTENCY_CONFLICT", 409);
      old.last_seen = Date.now();
      this.store.put("gateway", id, id, old);
      const cap = this.store.get("rtc-capability", id);
      if (cap) {
        cap.seen = Date.now();
        this.store.put("rtc-capability", id, id, cap);
      }
      return { ...record(old.heartbeat_response), server_time: iso() };
    }
    if (seq > Number(old.sequence)) {
      const states = array(body.sim_states);
      const seen = new Set<string>();
      for (const state of states) {
        const simId = uuid(state.sim_id);
        requireThat(!seen.has(simId), "INVALID_SIM_STATES");
        seen.add(simId);
        const sim = this.ownsSIM(simId, id);
        if (
          state.mapping_revision !== old.mapping_revision ||
          state.identity_verified !== true
        ) {
          sim.state = "unverified";
          sim.identity_verified = false;
          invalidated.push(simId);
        }
        sim.service_state = state.service_state;
        if (state.radio) {
          const radio = record(state.radio);
          if (
            radio.network_operator !== null &&
            radio.network_operator !== undefined
          )
            requireThat(
              string(radio.network_operator).trim().length > 0 &&
                !/[\x00-\x1f\x7f]/.test(string(radio.network_operator)),
              "INVALID_RADIO",
            );
          sim.radio = {
            signal_level: null,
            network_type: null,
            network_operator: null,
            roaming: null,
            country_iso: null,
            ...radio,
            updated_at: iso(),
          };
        }
        this.store.put("sim", simId, id, sim);
      }
      for (const sim of this.store.list("sim", id))
        if (!seen.has(string(sim.sim_id))) {
          if (sim.state === "active") {
            sim.identity_verified = false;
            sim.state = "unverified";
            invalidated.push(string(sim.sim_id));
          }
          sim.radio = null;
          this.store.put("sim", string(sim.sim_id), id, sim);
        }
      if (body.install_id !== undefined) {
        const install = uuid(body.install_id);
        requireThat(
          !old.install_id || old.install_id === install,
          "INSTALL_ID_CONFLICT",
          409,
        );
        old.install_id = install;
      }
      Object.assign(old, {
        sequence: seq,
        heartbeat_hash: digest,
        last_seen: Date.now(),
        protocol_version: 1,
        app_version: body.app_version,
        root: body.root,
        battery_percent: body.battery_percent ?? null,
        charging: body.charging ?? null,
      });
      if (invalidated.length) {
        old.mapping_revision = Number(old.mapping_revision) + 1;
        for (const sim of this.store.list("sim", id)) {
          sim.mapping_revision = old.mapping_revision;
          this.store.put("sim", string(sim.sim_id), id, sim);
        }
      }
      this.store.put("gateway", id, id, old);
      const cap = this.store.get("rtc-capability", id);
      if (cap) {
        cap.seen = Date.now();
        this.store.put("rtc-capability", id, id, cap);
      }
    }
    const response = {
      server_time: iso(),
      online: true,
      stale_after_seconds: 90,
      mapping_revision: old.mapping_revision,
      invalidated_sim_ids: invalidated,
      extensions,
    };
    old.heartbeat_response = response;
    this.store.put("gateway", id, id, old);
    return response;
  }
  private bindSIM(id: string, body: Data): Data {
    const gateway = this.gateway(id);
    const operation = uuid(body.operation_id);
    if (body.phase === "propose") {
      validate("SimProposalRequest", body);
      const mappings = array(body.mappings);
      requireThat(
        mappings.length >= 1 && mappings.length <= 2,
        "INVALID_SIM_MAPPINGS",
      );
      const slots = new Set<number>();
      const ids = new Set<string>();
      const output: Data[] = [];
      const revision = Number(gateway.mapping_revision) + 1;
      for (const m of mappings) {
        const slot = integer(m.slot_index);
        requireThat(
          slot >= 0 &&
            slot <= 1 &&
            !slots.has(slot) &&
            string(m.label).trim().length > 0,
          "INVALID_SIM_MAPPINGS",
        );
        slots.add(slot);
        requireThat(
          !(m.existing_sim_id && m.proposed_sim_id),
          "INVALID_SIM_MAPPINGS",
        );
        const simId = m.existing_sim_id
          ? uuid(m.existing_sim_id)
          : m.proposed_sim_id
            ? uuid(m.proposed_sim_id)
            : crypto.randomUUID();
        requireThat(!ids.has(simId), "INVALID_SIM_MAPPINGS");
        ids.add(simId);
        const existing = this.store.get("sim", simId);
        if (m.existing_sim_id) {
          requireThat(
            m.same_sim_verified === true && existing?.gateway_id === id,
            "INVALID_SIM_MAPPINGS",
          );
        } else {
          requireThat(
            !m.same_sim_verified && !existing,
            "INVALID_SIM_MAPPINGS",
          );
        }
        const sim = {
          sim_id: simId,
          gateway_id: id,
          slot_index: slot,
          label: m.label,
          carrier_name: m.carrier_name ?? null,
          phone_number: m.phone_number ?? null,
          state: "pending_local_confirmation",
          mapping_revision: revision,
          identity_verified: false,
          service_state: null,
          radio: null,
        };
        this.store.put("sim", simId, id, sim);
        output.push({
          sim_id: simId,
          slot_index: slot,
          state: sim.state,
          mapping_revision: revision,
        });
      }
      for (const sim of this.store.list("sim", id))
        if (!ids.has(string(sim.sim_id))) {
          sim.state = "removed";
          sim.identity_verified = false;
          sim.mapping_revision = revision;
          this.store.put("sim", string(sim.sim_id), id, sim);
        }
      gateway.mapping_revision = revision;
      this.store.put("gateway", id, id, gateway);
      this.store.put("proposal", operation, id, { revision, ids: [...ids] });
      return {
        operation_id: operation,
        phase: "proposed",
        mapping_revision: revision,
        mappings: output,
      };
    }
    requireThat(body.phase === "confirm", "INVALID_PHASE");
    validate("SimConfirmationRequest", body);
    const proposal = this.store.get("proposal", operation);
    requireThat(
      proposal && proposal.revision === gateway.mapping_revision,
      "SIM_MAPPING_CONFLICT",
      409,
    );
    const confirmations = array(body.confirmations);
    const expected = new Set(proposal.ids as string[]);
    requireThat(confirmations.length === expected.size, "INVALID_SIM_MAPPINGS");
    const output: Data[] = [];
    for (const c of confirmations) {
      const simId = uuid(c.sim_id);
      requireThat(expected.delete(simId), "INVALID_SIM_MAPPINGS");
      const sim = this.ownsSIM(simId, id);
      requireThat(sim.slot_index === c.slot_index, "SIM_MAPPING_CONFLICT", 409);
      sim.state = c.confirmed ? "active" : "unverified";
      sim.identity_verified = c.confirmed === true;
      this.store.put("sim", simId, id, sim);
      output.push({
        sim_id: simId,
        slot_index: sim.slot_index,
        state: sim.state,
        mapping_revision: sim.mapping_revision,
      });
    }
    return {
      operation_id: operation,
      phase: "confirmed",
      mapping_revision: gateway.mapping_revision,
      mappings: output,
    };
  }
  private createMessage(body: Data): Data {
    requireThat(
      this.store.sql
        .exec<{
          n: number;
        }>(
          "SELECT COUNT(*) n FROM node_records WHERE kind='command' AND json_extract(body,'$.state') IN ('queued','accepted_by_gateway','dispatching')",
        )
        .one().n < 1024,
      "COMMAND_CAPACITY",
      409,
    );
    requireThat(
      new TextEncoder().encode(string(body.text)).length <= 16384 &&
        !string(body.text).includes("\0"),
      "INVALID_MESSAGE",
    );
    const gateway = uuid(body.gateway_id);
    const simId = uuid(body.sim_id);
    this.checkSIM(gateway, simId, integer(body.mapping_revision));
    const id = body.message_id ? uuid(body.message_id) : crypto.randomUUID();
    requireThat(!this.store.get("message", id), "MESSAGE_ID_CONFLICT", 409);
    const created = iso();
    const expires = iso(Date.now() + integer(body.ttl_seconds) * 1000);
    const commandId = crypto.randomUUID();
    const command = {
      command_id: commandId,
      message_id: id,
      gateway_id: gateway,
      sim_id: simId,
      mapping_revision: body.mapping_revision,
      to: body.to,
      text: body.text,
      created_at: created,
      expires_at: expires,
      state: "queued",
      payload_sha256: "",
    };
    const fields = [
      commandId,
      id,
      gateway,
      simId,
      String(body.mapping_revision),
      string(body.to),
      string(body.text),
      expires.replace(/\.000Z$/, "Z"),
    ];
    command.payload_sha256 = sha(fields.join("\0"));
    const message = {
      message_id: id,
      command_id: commandId,
      gateway_id: gateway,
      sim_id: simId,
      mapping_revision: body.mapping_revision,
      direction: "outbound",
      from: null,
      to: body.to,
      text: body.text,
      status: "queued",
      part_count: null,
      created_at: created,
      expires_at: expires,
      parts: [],
    };
    this.store.put("command", commandId, gateway, command);
    this.changeMessage(message, "message.created");
    return {
      message_id: id,
      command_id: commandId,
      status: "queued",
      created_at: created,
      expires_at: expires,
    };
  }
  private claim(gateway: string, id: string, body: Data): Data {
    const command = this.store.get("command", id);
    requireThat(command && command.gateway_id === gateway, "NOT_FOUND", 404);
    requireThat(
      body.payload_sha256 === command.payload_sha256,
      "IDEMPOTENCY_CONFLICT",
      409,
    );
    if (command.state === "queued") {
      requireThat(
        Date.parse(string(command.expires_at)) > Date.now(),
        "COMMAND_EXPIRED",
        409,
      );
      this.checkSIM(
        gateway,
        string(command.sim_id),
        integer(command.mapping_revision),
      );
      command.state = "accepted_by_gateway";
      this.store.put("command", id, gateway, command);
      const message = this.store.get("message", string(command.message_id))!;
      message.status = command.state;
      this.changeMessage(message);
    }
    if (command.state === "expired")
      throw new NodeError(409, "COMMAND_EXPIRED");
    requireThat(
      command.state === "accepted_by_gateway" ||
        command.state === "dispatching",
      "COMMAND_NOT_CLAIMABLE",
      409,
    );
    return command;
  }
  private events(p: Principal, body: Data): Data {
    const events = array(body.events);
    requireThat(
      events.length >= 1 && events.length <= 50,
      "INVALID_EVENT_BATCH",
    );
    let last = 0;
    const acks: Data[] = [];
    for (const event of events) {
      validate("GatewayEvent", event);
      requireThat(event.gateway_id === p.id, "INVALID_GATEWAY_EVENT");
      const sequence = integer(event.sequence);
      requireThat(sequence > last, "INVALID_EVENT_SEQUENCE");
      last = sequence;
      const id = uuid(event.event_id);
      const digest = sha(canonical(event));
      const existing = this.store.sql
        .exec<{
          hash: string;
          cursor: number;
        }>(
          "SELECT * FROM node_gateway_events WHERE gateway=? AND id=?",
          p.id,
          id,
        )
        .toArray()[0];
      if (existing) {
        requireThat(existing.hash === digest, "IDEMPOTENCY_CONFLICT", 409);
        acks.push({
          event_id: id,
          event_cursor: cursor(existing.cursor),
          duplicate: true,
        });
        continue;
      }
      requireThat(
        !this.store.sql
          .exec(
            "SELECT id FROM node_gateway_events WHERE gateway=? AND sequence=?",
            p.id,
            sequence,
          )
          .toArray().length,
        "IDEMPOTENCY_CONFLICT",
        409,
      );
      const payload = record(event.payload);
      let message: Data;
      if (event.type === "sms.received") {
        requireThat(
          new TextEncoder().encode(string(payload.text)).length <= 16384 &&
            !string(payload.text).includes("\0") &&
            !/[\r\n\0]/.test(string(payload.from)),
          "INVALID_GATEWAY_EVENT",
        );
        const messageId = uuid(payload.message_id);
        const old = this.store.get("message", messageId);
        requireThat(!old, "IDEMPOTENCY_CONFLICT", 409);
        if (event.sim_id !== null && event.sim_id !== undefined)
          this.ownsSIM(uuid(event.sim_id), p.id);
        message = {
          message_id: messageId,
          command_id: null,
          gateway_id: p.id,
          sim_id: event.sim_id ?? null,
          mapping_revision: event.mapping_revision ?? null,
          direction: "inbound",
          from: payload.from,
          to: null,
          text: payload.text,
          status: "received",
          part_count: payload.parts,
          created_at: event.occurred_at,
          expires_at: null,
          parts: [],
        };
      } else {
        const command = this.store.get("command", uuid(payload.command_id));
        requireThat(
          command &&
            command.gateway_id === p.id &&
            command.message_id === payload.message_id &&
            command.sim_id === event.sim_id &&
            command.mapping_revision === event.mapping_revision,
          "COMMAND_BINDING_CONFLICT",
          409,
        );
        message = this.store.get("message", string(command.message_id))!;
        if (event.type === "sms.dispatching") {
          const count = integer(payload.part_count);
          requireThat(count >= 1 && count <= 255, "INVALID_GATEWAY_EVENT");
          requireThat(
            message.part_count === null || message.part_count === count,
            "IDEMPOTENCY_CONFLICT",
            409,
          );
          requireThat(command.state !== "queued", "COMMAND_NOT_CLAIMED", 409);
          if (
            ["delivered", "failed", "expired", "submitted"].includes(
              string(command.state),
            )
          ) {
            requireThat(message.part_count !== null, "COMMAND_TERMINAL", 409);
          } else {
            if (message.part_count === null) {
              message.part_count = count;
              message.parts = Array.from(
                { length: count },
                (_, part_index) => ({
                  part_index,
                  state: "dispatching",
                  result_code: null,
                  error: null,
                }),
              );
            }
            if (command.state === "accepted_by_gateway")
              command.state = "dispatching";
            if (message.status === "accepted_by_gateway")
              message.status = "dispatching";
          }
        } else if (event.type === "sms.command_state") {
          const next = string(payload.state);
          requireThat(
            ["failed", "expired", "unknown"].includes(next),
            "INVALID_COMMAND_STATE",
          );
          const current = string(message.status);
          const done = ["delivered", "failed", "expired"];
          if (
            !done.includes(current) &&
            !done.includes(string(command.state)) &&
            !(
              next !== "unknown" &&
              (message.part_count !== null ||
                !["queued", "accepted_by_gateway"].includes(current))
            ) &&
            !(
              next === "unknown" && ["submitted", "delivered"].includes(current)
            )
          ) {
            command.state = next;
            message.status = next;
          }
        } else if (event.type === "sms.part_state") {
          const parts = array(message.parts);
          const index = integer(payload.part_index);
          requireThat(
            index >= 0 &&
              message.part_count !== null &&
              index < Number(message.part_count),
            "EVENT_ORDER_REQUIRED",
            409,
          );
          const part = parts.find((part) => part.part_index === index);
          requireThat(part, "EVENT_ORDER_REQUIRED", 409);
          const next = string(payload.state);
          const transitions: Record<string, string[]> = {
            dispatching: [
              "submitted",
              "delivered",
              "failed",
              "expired",
              "unknown",
            ],
            unknown: ["submitted", "delivered", "failed"],
            submitted: ["delivered", "failed"],
          };
          if (transitions[string(part.state)]?.includes(next)) {
            part.state = next;
            part.result_code = payload.result_code ?? null;
            part.error = payload.error ?? null;
          } else if (part.state === next) {
            part.result_code ??= payload.result_code ?? null;
            part.error ??= payload.error ?? null;
          }
          message.parts = parts;
          const states = parts.map((p) => string(p.state));
          const every = (s: string) => states.every((v) => v === s);
          const status = every("delivered")
            ? "delivered"
            : states.includes("dispatching")
              ? "dispatching"
              : states.includes("unknown")
                ? "unknown"
                : states.includes("failed")
                  ? "failed"
                  : every("expired")
                    ? "expired"
                    : states.includes("expired")
                      ? "failed"
                      : states.every((s) =>
                            ["submitted", "delivered"].includes(s),
                          )
                        ? "submitted"
                        : "dispatching";
          message.status = status;
          command.state = status;
        } else throw new NodeError(400, "UNSUPPORTED_EVENT_TYPE");
        this.store.put("command", string(command.command_id), p.id, command);
      }
      this.changeMessage(
        message,
        event.type === "sms.received"
          ? "message.received"
          : "message.state_changed",
      );
      const max = this.store.sql
        .exec<{ max: number }>("SELECT MAX(cursor) AS max FROM node_feed")
        .one().max;
      this.store.sql.exec(
        "INSERT INTO node_gateway_events VALUES (?,?,?,?,?)",
        p.id,
        id,
        sequence,
        digest,
        max,
      );
      acks.push({ event_id: id, event_cursor: cursor(max), duplicate: false });
    }
    return { acks };
  }
}
