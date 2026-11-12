import {
  type Data,
  requireThat,
  string,
  integer,
  array,
  record,
  uuid,
  validate,
  iso,
  canonical,
  NodeError,
} from "./node-protocol";
import { NodeStore } from "./node-store";
import type { Principal } from "./node-auth";
import { createHash } from "node:crypto";
const sha = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const conflict = (ok: unknown) => requireThat(ok, "CALL_STATE_CONFLICT", 409);
const terminal = (call: Data) =>
  call.state === "ended" || call.state === "unknown";
type Reply = { body: unknown; status: number; iceFor?: string };
export class NodeRTC {
  constructor(
    private store: NodeStore,
    private checkSIM: (gateway: string, sim: string, revision: number) => Data,
  ) {}
  private save(call: Data) {
    this.store.put("call", string(call.call_id), string(call.gateway_id), call);
  }
  private bump(call: Data, state: string, reason?: string) {
    call.state = state;
    call.state_revision = Number(call.state_revision) + 1;
    if (reason) call.reason = reason;
    this.save(call);
    this.wake(call);
  }
  private wake(call: Data) {
    this.store.sql.exec(
      "INSERT INTO node_outbox(id,device,kind,payload) VALUES (?,?,?,?)",
      crypto.randomUUID(),
      string(call.gateway_id),
      "call",
      canonical({
        call_id: call.call_id,
        participants: call._participants,
        expires_at: call.expires_at,
      }),
    );
  }
  private end(call: Data, reason: string) {
    call._ended_at = Date.now();
    this.bump(call, "ended", reason);
    this.store.remove("slot", string(call.gateway_id));
  }
  private requestEnd(call: Data, reason: string) {
    call.end_requested = true;
    if (call.direction === "outgoing" && !call.dispatched)
      this.end(call, reason);
    else this.bump(call, string(call.state), reason);
  }
  private visible(p: Principal, call: Data) {
    requireThat(
      call.gateway_id === p.id ||
        (call.direction === "outgoing"
          ? call.client_id === p.id
          : Object.hasOwn(record(call._participants), p.id)),
      "CALL_NOT_FOUND",
      404,
    );
  }
  private read(p: Principal, id: string): Data {
    const call = this.store.get("call", id);
    requireThat(call, "CALL_NOT_FOUND", 404);
    this.visible(p, call);
    return call;
  }
  currentCalls(p: Principal): Data[] {
    const calls = this.store.select(
      "call",
      "(json_extract(body,'$.state')<>'ended' OR json_extract(body,'$._ended_at')>?) AND (device=? OR json_extract(body,'$.client_id')=? OR EXISTS (SELECT 1 FROM json_each(json_extract(body,'$._participants')) WHERE key=?))",
      [Date.now() - 900_000, p.id, p.id, p.id],
      "(json_extract(body,'$.state')='ended'),julianday(json_extract(body,'$.created_at')) DESC",
      32,
    );
    return calls.map((call) => this.snapshot(p, call));
  }
  snapshot(p: Principal, call: Data): Data {
    this.visible(p, call);
    const out: Data = {};
    for (const [key, value] of Object.entries(call))
      if (!key.startsWith("_") && value !== null) out[key] = value;
    if (p.role === "client" && call.direction === "incoming") {
      out.client_id = p.id;
      const participant = record(record(call._participants)[p.id]);
      if (participant.state === "ended") {
        out.state = "ended";
        out.reason = participant.reason;
        delete out.remaining_ms;
      }
    }
    if (!terminal(call) && call.state !== "active" && out.state !== "ended")
      out.remaining_ms = Math.max(
        0,
        Date.parse(string(call.expires_at)) - Date.now(),
      );
    return out;
  }
  private legFor(call: string, client: string): Data | undefined {
    return this.store.select(
      "leg",
      "device=? AND json_extract(body,'$.binding.client_id')=?",
      [call, client],
      "id",
      1,
    )[0];
  }
  private negotiated(call: Data, client: string): boolean {
    const leg = this.legFor(string(call.call_id), client);
    return (
      !!leg && leg.phase === "negotiated" && Number(leg.authorized) > Date.now()
    );
  }
  private mediaAllowed(p: Principal, leg: Data): Data {
    const binding = record(leg.binding);
    const call = this.read(p, string(binding.call_id));
    requireThat(
      p.id === binding.client_id || p.id === binding.gateway_id,
      "RTC_FORBIDDEN",
      403,
    );
    requireThat(!terminal(call) && !call.end_requested, "RTC_FORBIDDEN", 403);
    if (call.direction === "incoming") {
      const participant = record(
        record(call._participants)[string(binding.client_id)],
      );
      requireThat(
        participant.state !== "ended" &&
          (!call.winner_client_id ||
            call.winner_client_id === binding.client_id),
        "RTC_FORBIDDEN",
        403,
      );
    }
    this.checkSIM(
      string(call.gateway_id),
      string(call.sim_id),
      integer(call.mapping_revision),
    );
    const gateway = this.store.get("gateway", string(call.gateway_id));
    requireThat(
      gateway && Number(gateway.last_seen) > Date.now() - 90_000,
      "RTC_FORBIDDEN",
      403,
    );
    return call;
  }
  sweep(): void {
    for (const row of this.store.sql
      .exec<{
        body: string;
      }>(
        "SELECT body FROM node_records WHERE kind='call' AND json_extract(body,'$.state') NOT IN ('ended','unknown')",
      )
      .toArray()) {
      const call = record(JSON.parse(row.body));
      if (terminal(call)) continue;
      const expired =
        (call.state !== "active" &&
          Date.parse(string(call.expires_at)) <= Date.now()) ||
        Number(call._gateway_seen) < Date.now() - 20_000 ||
        ((call.direction === "outgoing" || !!call.winner_client_id) &&
          Number(call._client_seen) < Date.now() - 20_000);
      if (
        !expired &&
        call.direction === "incoming" &&
        !call.winner_client_id &&
        call.candidate_client_id &&
        Date.parse(string(call.candidate_until)) <= Date.now()
      ) {
        const participant = record(
          record(call._participants)[string(call.candidate_client_id)],
        );
        if (participant.state !== "ended") participant.state = "ringing";
        delete call.candidate_client_id;
        delete call.candidate_until;
        this.bump(call, "ringing");
      }
      if (expired) {
        if (call.direction === "outgoing" && !call.dispatched)
          this.end(call, "control_lease_expired");
        else {
          call.end_requested = true;
          this.bump(call, "unknown", "control_lease_expired");
        }
      }
    }
    this.store.sql.exec(
      "UPDATE node_records SET body=json_set(body,'$.phase','closed','$.reason','expired','$.revision',json_extract(body,'$.revision')+1) WHERE kind='leg' AND json_extract(body,'$.phase')<>'closed' AND (json_extract(body,'$.authorized')<=? OR (json_extract(body,'$.phase')<>'negotiated' AND json_extract(body,'$.negotiation')<=?))",
      Date.now(),
      Date.now(),
    );
  }

  route(
    p: Principal,
    path: string,
    method: string,
    body: Data,
  ): Reply | undefined {
    this.sweep();
    if (path === "/v1/rtc/control/capability" && method === "POST") {
      validate("RTCControlCapability", body);
      const cap = {
        ...body,
        seen: Date.now(),
        sleep_until: body.sleep_seconds
          ? iso(Date.now() + Number(body.sleep_seconds) * 1000)
          : null,
      };
      this.store.put("rtc-capability", p.id, p.id, cap);
      return {
        body: {
          version: 1,
          call_control: "rtc",
          enabled: body.enabled,
          ...(cap.sleep_until ? { sleep_until: cap.sleep_until } : {}),
        },
        status: 200,
      };
    }
    if (path === "/v1/rtc/control/incoming-policy" && method === "GET") {
      requireThat(p.role === "gateway", "CALL_FORBIDDEN", 403);
      return {
        body: { version: 1, incoming_subscribers: this.candidates().length },
        status: 200,
      };
    }
    if (
      ["/v1/rtc/control/calls", "/v1/rtc/control/incoming"].includes(path) &&
      method === "POST"
    ) {
      const incoming = path.endsWith("/incoming");
      validate(incoming ? "RTCIncomingCall" : "RTCOutgoingCall", body);
      requireThat(
        incoming
          ? p.role === "gateway" && p.id === body.gateway_id
          : p.role === "client",
        "CALL_FORBIDDEN",
        403,
      );
      const identity = { ...body };
      delete identity.remaining_ring_ms;
      const scope = "rtc:" + p.id;
      const operation = uuid(body.operation_id);
      const id = uuid(body.call_id);
      const old = this.store.sql
        .exec<{
          hash: string;
          response: string;
        }>(
          "SELECT * FROM node_operations WHERE scope=? AND id=?",
          scope,
          operation,
        )
        .toArray()[0];
      if (old) {
        conflict(old.hash === sha(identity));
        return { body: JSON.parse(old.response), status: 200 };
      }
      const gateway = uuid(body.gateway_id);
      this.checkSIM(gateway, uuid(body.sim_id), integer(body.mapping_revision));
      const g = this.store.get("gateway", gateway);
      requireThat(
        g && Number(g.last_seen) > Date.now() - 90_000,
        "GATEWAY_OFFLINE",
        409,
      );
      const cap = this.store.get("rtc-capability", gateway);
      requireThat(
        cap?.enabled === true && Number(cap.seen) > Date.now() - 90_000,
        "CALLING_NOT_READY",
        409,
      );
      requireThat(!this.store.get("slot", gateway), "GATEWAY_BUSY", 409);
      requireThat(
        this.store.sql
          .exec<{
            n: number;
          }>(
            "SELECT COUNT(*) n FROM node_records WHERE kind='call' AND json_extract(body,'$.state')<>'ended'",
          )
          .one().n < 32,
        "CALL_CAPACITY",
        409,
      );
      conflict(!this.store.get("call", id));
      const clients = incoming ? this.candidates() : [p.id];
      requireThat(
        clients.length > 0,
        body.remaining_ring_ms
          ? "NO_INCOMING_SUBSCRIBERS"
          : "GATEWAY_UNAVAILABLE",
        503,
      );
      const participants: Data = {};
      clients.forEach(
        (client) => (participants[client] = { state: "ringing" }),
      );
      const created = Date.now();
      const call: Data = {
        version: 1,
        call_control: "rtc",
        call_id: id,
        gateway_id: gateway,
        client_id: incoming ? "00000000-0000-0000-0000-000000000000" : p.id,
        sim_id: body.sim_id,
        mapping_revision: body.mapping_revision,
        direction: incoming ? "incoming" : "outgoing",
        state: incoming ? "ringing" : "reserved",
        state_revision: 1,
        from: body.from || null,
        to: body.to,
        created_at: iso(created),
        expires_at: iso(
          created +
            (incoming ? Number(body.remaining_ring_ms || 25000) : 30000),
        ),
        end_requested: false,
        dispatched: false,
        global_decline: incoming && cap?.global_decline === true,
        decline_requested: false,
        _participants: participants,
        _gateway_seen: created,
        _client_seen: created,
      };
      this.store.put("slot", gateway, gateway, { call_id: id });
      this.save(call);
      this.wake(call);
      const output = this.snapshot(p, call);
      this.store.sql.exec(
        "INSERT INTO node_operations VALUES (?,?,?,?,?)",
        scope,
        operation,
        sha(identity),
        201,
        canonical(output),
      );
      return { body: output, status: 201 };
    }
    if (
      (path === "/v1/rtc/control/calls" || path === "/v1/calls") &&
      method === "GET"
    ) {
      const calls = this.currentCalls(p).map(
        (snapshot) => this.store.get("call", string(snapshot.call_id))!,
      );
      if (path === "/v1/rtc/control/calls")
        for (const call of calls) {
          this.seen(p, call);
          this.save(call);
        }
      return {
        body:
          path === "/v1/calls"
            ? {
                items: calls.map((c) => this.snapshot(p, c)),
                next_cursor: null,
                resync_required: false,
              }
            : {
                version: 1,
                calls: calls.map((c) => this.snapshot(p, c)),
                poll_after_ms: 750,
              },
        status: 200,
      };
    }
    const callPath = path.match(
      /^\/v1\/(?:rtc\/control\/calls|calls)\/([^/]+)$/,
    );
    if (callPath && method === "GET") {
      const call = this.read(p, uuid(callPath[1]));
      this.seen(p, call);
      this.save(call);
      return { body: this.snapshot(p, call), status: 200 };
    }
    const op = path.match(/^\/v1\/rtc\/control\/calls\/([^/]+)\/operations$/);
    if (op && method === "POST") {
      validate("RTCControlOperation", body);
      const id = uuid(op[1]);
      const call = this.read(p, id);
      const scope = "rtc:" + p.id;
      return this.store.replay(
        scope,
        uuid(body.operation_id),
        sha({ call_id: id, ...body }),
        () => {
          const kind = string(body.kind);
          const gateway = p.role === "gateway" && p.id === call.gateway_id;
          const client = p.role === "client";
          const cellularEnd = kind === "ended" || kind === "declined";
          conflict(
            call.state !== "ended" &&
              (call.state !== "unknown" || (gateway && cellularEnd)) &&
              body.revision === call.state_revision,
          );
          if (
            call.state !== "active" &&
            Date.parse(string(call.expires_at)) <= Date.now()
          )
            conflict(
              cellularEnd || ["hangup", "cancel", "reject"].includes(kind),
            );
          switch (kind) {
            case "start":
              conflict(
                client &&
                  call.direction === "outgoing" &&
                  call.state === "reserved",
              );
              this.bump(call, "connecting");
              break;
            case "accept": {
              conflict(
                client &&
                  call.direction === "incoming" &&
                  !call.winner_client_id &&
                  !call.end_requested,
              );
              if (
                call.candidate_client_id &&
                call.candidate_client_id !== p.id &&
                Date.parse(string(call.candidate_until)) > Date.now()
              )
                throw new NodeError(409, "GATEWAY_BUSY");
              call.candidate_client_id = p.id;
              call.candidate_until = iso(
                Math.min(
                  Date.now() + 20_000,
                  Date.parse(string(call.expires_at)),
                ),
              );
              record(record(call._participants)[p.id]).state = "connecting";
              call._client_seen = Date.now();
              this.bump(call, "connecting");
              break;
            }
            case "release":
              conflict(
                client &&
                  call.direction === "incoming" &&
                  call.candidate_client_id === p.id &&
                  !call.winner_client_id,
              );
              delete call.candidate_client_id;
              delete call.candidate_until;
              record(record(call._participants)[p.id]).state = "ringing";
              this.bump(call, "ringing");
              break;
            case "winner": {
              conflict(
                gateway &&
                  call.direction === "incoming" &&
                  !call.winner_client_id &&
                  body.candidate_client_id === call.candidate_client_id &&
                  !!call.candidate_client_id &&
                  Date.parse(string(call.candidate_until)) > Date.now(),
              );
              conflict(this.negotiated(call, string(call.candidate_client_id)));
              call.winner_client_id = call.candidate_client_id;
              call.client_id = call.candidate_client_id;
              for (const [id, participant] of Object.entries(
                record(call._participants),
              )) {
                const value = record(participant);
                value.state = id === call.client_id ? "accepted" : "ended";
                if (id !== call.client_id) value.reason = "answered_elsewhere";
              }
              this.bump(call, "connecting");
              break;
            }
            case "dispatch":
              conflict(
                gateway &&
                  call.direction === "outgoing" &&
                  call.state === "connecting" &&
                  !call.dispatched &&
                  this.negotiated(call, string(call.client_id)),
              );
              call.dispatched = true;
              this.bump(call, "dialing");
              break;
            case "ringing":
              conflict(gateway && call.dispatched && call.state === "dialing");
              this.bump(call, "ringing");
              break;
            case "active": {
              conflict(
                gateway &&
                  (call.direction === "outgoing"
                    ? call.dispatched
                    : !!call.winner_client_id) &&
                  this.negotiated(call, string(call.client_id)),
              );
              const leg = this.legFor(id, string(call.client_id));
              conflict(leg?.cellular_active === true);
              call.answered_at = iso();
              this.bump(call, "active");
              break;
            }
            case "reject": {
              conflict(
                client &&
                  call.direction === "incoming" &&
                  !call.winner_client_id,
              );
              Object.assign(record(record(call._participants)[p.id]), {
                state: "ended",
                reason: "declined",
              });
              if (call.candidate_client_id === p.id) {
                delete call.candidate_client_id;
                delete call.candidate_until;
              }
              if (
                Object.values(record(call._participants)).some(
                  (part) => record(part).state !== "ended",
                )
              )
                this.bump(call, "ringing");
              else this.requestEnd(call, "declined");
              break;
            }
            case "decline_all":
              conflict(
                client &&
                  call.direction === "incoming" &&
                  call.global_decline &&
                  !call.winner_client_id &&
                  call.candidate_client_id !== p.id,
              );
              call.decline_requested = true;
              this.bump(call, string(call.state));
              break;
            case "cancel":
            case "hangup":
              requireThat(
                client &&
                  (call.direction === "outgoing" ||
                    call.winner_client_id === p.id ||
                    call.candidate_client_id === p.id),
                "CALL_FORBIDDEN",
                403,
              );
              conflict(kind !== "cancel" || call.state !== "active");
              this.requestEnd(call, kind);
              break;
            case "answered_elsewhere":
              conflict(
                gateway &&
                  call.direction === "incoming" &&
                  !call.winner_client_id,
              );
              this.end(call, kind);
              break;
            case "declined":
              conflict(
                gateway &&
                  call.direction === "incoming" &&
                  !call.winner_client_id,
              );
              this.end(call, "declined");
              break;
            case "ended":
              requireThat(gateway, "CALL_FORBIDDEN", 403);
              this.end(call, "cellular_ended");
              break;
            default:
              throw new NodeError(400, "INVALID_CALL_OPERATION");
          }
          this.seen(p, call);
          this.save(call);
          return { body: this.snapshot(p, call), status: 200 };
        },
      );
    }
    return this.media(p, path, method, body);
  }
  private seen(p: Principal, call: Data) {
    if (p.id === call.gateway_id) call._gateway_seen = Date.now();
    else if (
      call.direction === "outgoing" ||
      call.candidate_client_id === p.id ||
      call.winner_client_id === p.id
    )
      call._client_seen = Date.now();
  }
  private candidates(): string[] {
    return this.store.sql
      .exec<{ id: string }>(
        "SELECT id FROM node_devices WHERE role=? AND state=?",
        "client",
        "active",
      )
      .toArray()
      .filter(({ id }) => {
        if (
          !this.store.sql
            .exec(
              "SELECT id FROM node_sessions WHERE device=? AND refresh_expires>?",
              id,
              Date.now(),
            )
            .toArray().length
        )
          return false;
        const reception = this.store.get("reception", id);
        if (reception?.version === 2)
          return reception.incoming_enabled === true;
        const cap = this.store.get("rtc-capability", id);
        return (
          cap?.enabled === true &&
          (Number(cap.seen) > Date.now() - 90_000 ||
            (cap.sleep_until &&
              Date.parse(string(cap.sleep_until)) > Date.now()))
        );
      })
      .map((row) => row.id);
  }
  private media(
    p: Principal,
    path: string,
    method: string,
    body: Data,
  ): Reply | undefined {
    const media = path.match(/^\/v1\/calls\/([^/]+)\/media(\/active)?$/);
    if (media) {
      const call = this.read(p, uuid(media[1]));
      conflict(!terminal(call) && !call.end_requested);
      let client = p.id;
      if (p.role === "gateway")
        client = string(
          call.direction === "incoming"
            ? call.winner_client_id || call.candidate_client_id || ""
            : call.client_id,
        );
      if (!client && p.role === "gateway" && method === "GET")
        return { body: { media_transport: "pending" }, status: 200 };
      requireThat(client, "RTC_NOT_SELECTED", 409);
      let leg = this.legFor(string(call.call_id), client);
      if (media[2] && method === "POST") {
        requireThat(p.role === "gateway", "RTC_FORBIDDEN", 403);
        conflict(
          leg &&
            body.leg_id === record(leg.binding).leg_id &&
            leg.phase === "negotiated",
        );
        this.mediaAllowed(p, leg!);
        leg!.cellular_active = true;
        this.store.put(
          "leg",
          string(record(leg!.binding).leg_id),
          string(call.call_id),
          leg!,
        );
        return { body: { cellular_active: true }, status: 200 };
      }
      if (method === "POST" && !media[2]) {
        requireThat(
          p.role === "client" && body.media_transport === "webrtc",
          "RTC_FORBIDDEN",
          403,
        );
        if (!leg) {
          conflict(
            call.direction === "outgoing"
              ? ["reserved", "connecting"].includes(string(call.state))
              : !call.winner_client_id && call.state !== "active",
          );
          const binding = {
            owner_id: this.store.owner,
            call_id: call.call_id,
            leg_id: crypto.randomUUID(),
            attempt_id: crypto.randomUUID(),
            client_id: p.id,
            gateway_id: call.gateway_id,
            sim_id: call.sim_id,
            mapping_revision: call.mapping_revision,
          };
          leg = {
            binding,
            phase: "waiting_offer",
            revision: 1,
            generation: 1,
            authorized: Date.now() + 60_000,
            negotiation: Date.now() + 30_000,
            signals: [],
            candidates: { client: 0, gateway: 0 },
            ended: { client: false, gateway: false },
            operations: 0,
            cellular_active: false,
          };
          this.store.put("leg", binding.leg_id, string(call.call_id), leg);
        }
      }
      if (!leg && p.role === "gateway" && method === "GET")
        return { body: { media_transport: "pending" }, status: 200 };
      requireThat(leg, "RTC_NOT_SELECTED", 409);
      this.mediaAllowed(p, leg);
      conflict(leg.phase !== "closed");
      return {
        body: {
          media_transport: "webrtc",
          call_control: "rtc",
          rtc_signaling: "https",
          binding: leg.binding,
          cellular_active: leg.cellular_active,
          ice_servers: [],
        },
        status: 200,
        iceFor: p.id,
      };
    }
    const signal = path.match(/^\/v1\/rtc\/legs\/([^/]+)$/);
    if (signal) {
      const leg = this.store.get("leg", uuid(signal[1]));
      requireThat(leg, "RTC_NOT_FOUND", 404);
      this.mediaAllowed(p, leg);
      const binding = record(leg.binding);
      if (method === "GET") {
        if (leg.phase !== "closed") leg.authorized = Date.now() + 60_000;
        this.store.put(
          "leg",
          string(binding.leg_id),
          string(binding.call_id),
          leg,
        );
        const all = array(leg.signals);
        const signals = all.filter(
          (s) =>
            s.recipient_id === p.id &&
            Date.parse(string(s.expires_at)) > Date.now(),
        );
        const complete = !all.some(
          (s) =>
            s.recipient_id === p.id &&
            Date.parse(string(s.expires_at)) <= Date.now(),
        );
        return {
          body: {
            state: {
              snapshot: this.legSnapshot(leg),
              signals,
              replay_complete: complete,
            },
            cellular_active: leg.cellular_active,
          },
          status: 200,
        };
      }
      if (method === "POST") {
        validate("RTCSignalCommand", body);
        const allowed = [
          "version",
          "call_id",
          "leg_id",
          "attempt_id",
          "operation_id",
          "generation",
          "revision",
          "kind",
          "sdp",
          "ice",
        ];
        requireThat(
          Object.keys(body).every((k) => allowed.includes(k)) &&
            body.version === 1,
          "RTC_INVALID",
        );
        requireThat(
          body.call_id === binding.call_id &&
            body.leg_id === binding.leg_id &&
            body.attempt_id === binding.attempt_id,
          "RTC_FORBIDDEN",
          403,
        );
        const kind = string(body.kind);
        const client = p.id === binding.client_id;
        const side = client ? "client" : "gateway";
        const rev = integer(body.revision);
        const generation = integer(body.generation);
        const op = string(body.operation_id);
        requireThat(
          [
            "offer",
            "answer",
            "candidate",
            "end_of_candidates",
            "restart",
            "close",
          ].includes(kind) &&
            generation >= 1 &&
            generation <= 8,
          "RTC_INVALID",
        );
        if (kind === "offer" || kind === "answer")
          requireThat(
            rev >= 1 &&
              typeof body.sdp === "string" &&
              new TextEncoder().encode(body.sdp).length <= 65536 &&
              body.sdp.length > 0 &&
              !body.sdp.includes("\0") &&
              body.ice === undefined,
            "RTC_INVALID",
          );
        else {
          requireThat(
            body.sdp === undefined &&
              (kind === "restart" ? rev >= 1 : rev === 0),
            "RTC_INVALID",
          );
          if (kind === "candidate") {
            const ice = record(body.ice);
            requireThat(
              Object.keys(ice).length === 3 &&
                typeof ice.candidate === "string" &&
                ice.candidate.length > 0 &&
                new TextEncoder().encode(ice.candidate).length <= 2048 &&
                !/[\r\n\0]/.test(ice.candidate) &&
                typeof ice.sdp_mid === "string" &&
                /^[A-Za-z0-9_-]{1,128}$/.test(ice.sdp_mid) &&
                Number.isSafeInteger(ice.sdp_mline_index) &&
                Number(ice.sdp_mline_index) >= 0 &&
                Number(ice.sdp_mline_index) <= 15,
              "RTC_INVALID",
            );
          } else requireThat(body.ice === undefined, "RTC_INVALID");
        }
        return this.store.replay(
          `signal:${binding.leg_id}:${p.id}`,
          op,
          sha(body),
          () => {
            requireThat(leg.phase !== "closed", "RTC_CLOSED", 410);
            requireThat(
              Number(leg.authorized) > Date.now() &&
                (kind === "close" ||
                  leg.phase === "negotiated" ||
                  Number(leg.negotiation) > Date.now()),
              "RTC_EXPIRED",
              410,
            );
            conflict(
              kind === "close"
                ? generation <= Number(leg.generation)
                : generation === leg.generation,
            );
            if (["offer", "answer", "restart"].includes(kind))
              conflict(rev === leg.revision);
            requireThat(
              Number(leg.operations) < 2304 || kind === "close",
              "RTC_LIMIT",
              429,
            );
            if (kind === "offer") {
              requireThat(client, "RTC_FORBIDDEN", 403);
              conflict(leg.phase === "waiting_offer");
              leg.phase = "waiting_answer";
            }
            if (kind === "answer") {
              requireThat(!client, "RTC_FORBIDDEN", 403);
              conflict(leg.phase === "waiting_answer");
              leg.phase = "negotiated";
            }
            if (kind === "candidate" || kind === "end_of_candidates") {
              const ended = record(leg.ended);
              conflict(!ended[side]);
              if (kind === "candidate") {
                const counts = record(leg.candidates);
                requireThat(Number(counts[side]) < 128, "RTC_LIMIT", 429);
                counts[side] = Number(counts[side]) + 1;
              } else ended[side] = true;
            }
            if (kind === "restart") {
              requireThat(client, "RTC_FORBIDDEN", 403);
              conflict(leg.phase === "negotiated");
              requireThat(Number(leg.generation) < 8, "RTC_LIMIT", 429);
              leg.generation = Number(leg.generation) + 1;
              leg.phase = "waiting_offer";
              leg.negotiation = Math.min(
                Date.now() + 30_000,
                Number(leg.authorized),
              );
              leg.signals = [];
              leg.candidates = { client: 0, gateway: 0 };
              leg.ended = { client: false, gateway: false };
            }
            if (kind === "close") {
              leg.phase = "closed";
              leg.reason = "participant_closed";
              leg.signals = [];
            }
            leg.revision = Number(leg.revision) + 1;
            leg.operations = Number(leg.operations) + 1;
            if (!["close", "restart"].includes(kind)) {
              const signals = array(leg.signals);
              signals.push({
                sequence: leg.revision,
                sender_id: p.id,
                recipient_id: client ? binding.gateway_id : binding.client_id,
                generation: body.generation,
                kind,
                ...(body.sdp !== undefined ? { sdp: body.sdp } : {}),
                ...(body.ice !== undefined ? { ice: body.ice } : {}),
                expires_at: iso(
                  Math.min(Date.now() + 15_000, Number(leg.authorized)),
                ),
              });
              leg.signals = signals;
            }
            this.store.put(
              "leg",
              string(binding.leg_id),
              string(binding.call_id),
              leg,
            );
            return {
              body: {
                ack: {
                  operation_id: op,
                  revision: leg.revision,
                  generation: leg.generation,
                },
              },
              status: 200,
            };
          },
        );
      }
    }
    return undefined;
  }
  private legSnapshot(leg: Data): Data {
    return {
      binding: leg.binding,
      phase: leg.phase,
      revision: leg.revision,
      generation: leg.generation,
      authorized_until: iso(Number(leg.authorized)),
      negotiation_until: iso(Number(leg.negotiation)),
      ...(leg.reason ? { reason: leg.reason } : {}),
    };
  }
}
