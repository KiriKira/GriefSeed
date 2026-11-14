import { NodeSockets } from "./node-sockets";
import { NodeState } from "./node-state";
import { NodeError } from "./node-protocol";
import { NodeRecovery } from "./node-recovery";
import { DurableObject } from "cloudflare:workers";
import { digest, issueToken, seal, open } from "./crypto";
import { json, error, readJson, HttpInputError } from "./http";
import type { Principal } from "./node-auth";
import type { Env } from "./index";

type Token = {
  id: string;
  hash: string;
  name: string;
  created: number;
  revoked: number | null;
  requests: number;
  successes: number;
  failures: number;
  last_used: number | null;
};
type Credential = {
  username: string;
  key_id: string;
  token_id: string;
  expires: number;
  pending: number;
  attempts: number;
  next_try: number;
};
type IceServer = { urls: string[]; username: string; credential: string };
const now = () => Date.now();
export class Deployment extends DurableObject<Env> {
  private sql: SqlStorage;
  private nodeState?: NodeState;
  private sockets = new NodeSockets(this.ctx, () => this.node());
  private node(): NodeState {
    return (this.nodeState ??= new NodeState(
      this.sql,
      this.ctx.storage,
      this.env,
      (p) => this.nodeIce(p),
    ));
  }
  private async nodeIce(p: Principal): Promise<Record<string, unknown>> {
    const node = this.node();
    node.auth.recheck(p);
    const cached = node.store.get("ice-cache", p.id);
    if (cached && Number(cached.expires) > now() + 30_000) {
      try {
        return JSON.parse(await open(this.env, String(cached.blob), p.id));
      } catch {}
    }
    const id = await digest("node-relay:" + p.id);
    const hash = await digest("node-ice:" + p.id);
    this.sql.exec(
      "INSERT OR IGNORE INTO tokens(id,hash,name,created,kind) VALUES (?,?,?,?,?)",
      id,
      hash,
      "device relay",
      now(),
      "node",
    );
    const response = await this.issue(hash);
    if (!response.ok) throw Error("TURN_UNAVAILABLE");
    const body = (await response.json()) as Record<string, unknown>;
    const encrypted = await seal(this.env, JSON.stringify(body), p.id);
    node.auth.recheck(p);
    node.store.put("ice-cache", p.id, p.id, {
      blob: encrypted,
      expires: Date.parse(String(body.expires_at)),
    });
    return body;
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
      );
      if (!this.sql.exec("SELECT version FROM schema_version").toArray().length)
        this.sql.exec("INSERT INTO schema_version VALUES (1)");
      const version = this.sql
        .exec<{ version: number }>("SELECT version FROM schema_version")
        .one().version;
      if (version !== 1) throw Error("unsupported_schema");
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'source',revoked INTEGER,requests INTEGER NOT NULL DEFAULT 0,successes INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_used INTEGER)`,
      );
      if (
        !this.sql
          .exec<{ name: string }>("PRAGMA table_info(tokens)")
          .toArray()
          .some((c) => c.name === "kind")
      )
        this.sql.exec(
          "ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'source'",
        );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS credentials (username TEXT NOT NULL,key_id TEXT NOT NULL,token_id TEXT NOT NULL REFERENCES tokens(id),expires INTEGER NOT NULL,pending INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_try INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(key_id,username))`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS admin_sessions (hash TEXT PRIMARY KEY,expires INTEGER NOT NULL)`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL)`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS issuance (id TEXT PRIMARY KEY,token_id TEXT NOT NULL,started INTEGER NOT NULL,finished INTEGER)`,
      );
    });
  }
  private token(hash: string): Token | undefined {
    return this.sql
      .exec<Token>("SELECT * FROM tokens WHERE hash=?", hash)
      .toArray()[0];
  }
  private consume(bucket: string, maximum: number, window: number): boolean {
    const expires = Math.floor(now() / window) * window + window;
    return this.ctx.storage.transactionSync(() => {
      const key = `${bucket}:${expires}`;
      const count =
        this.sql
          .exec<{
            count: number;
          }>("SELECT count FROM limits WHERE bucket=?", key)
          .toArray()[0]?.count || 0;
      if (count >= maximum) return false;
      this.sql.exec(
        "INSERT INTO limits VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1",
        key,
        expires,
      );
      return true;
    });
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (this.env.NODE_ENABLED === "true" && path === "/node/v1/ws")
        return this.sockets.open(request, "wake");
      if (
        this.env.NODE_ENABLED === "true" &&
        path === "/node/v1/rtc/control/ws"
      )
        return this.sockets.open(request, "control");
      if (this.env.NODE_ENABLED === "true" && path.startsWith("/node/v1/")) {
        if (request.method !== "GET") {
          const alarm = await this.ctx.storage.getAlarm();
          if (alarm === null || alarm > now() + 1000)
            await this.ctx.storage.setAlarm(now() + 1000);
        }
        const response = await this.node().fetch(
          new Request(
            "https://node" + path.slice(5) + new URL(request.url).search,
            request,
          ),
        );
        this.sockets.recheck();
        this.ctx.waitUntil(this.flushOutbox());
        return response;
      }
      if (
        this.env.NODE_ENABLED === "true" &&
        path === "/node-join" &&
        request.method === "POST"
      )
        return json(await this.node().auth.createJoin(), 201);
      if (
        this.env.NODE_ENABLED === "true" &&
        path === "/node-devices" &&
        request.method === "GET"
      ) {
        this.node();
        return json({
          devices: this.sql
            .exec(
              "SELECT id,role,name,platform,state,created FROM node_devices ORDER BY created DESC",
            )
            .toArray(),
          budget: this.sql
            .exec(
              "SELECT scope,period,count FROM node_budgets WHERE period>=?",
              Math.floor(now() / 86400_000) * 86400_000,
            )
            .toArray(),
        });
      }
      const revokeDevice = path.match(
        /^\/node-devices\/([0-9a-f-]{36})\/revoke$/,
      );
      if (
        this.env.NODE_ENABLED === "true" &&
        revokeDevice &&
        request.method === "POST"
      ) {
        await this.ctx.storage.setAlarm(now() + 1000);
        const id = revokeDevice[1];
        const relay = await digest("node-relay:" + id);
        this.ctx.storage.transactionSync(() => {
          this.node();
          this.sql.exec("DELETE FROM node_sessions WHERE device=?", id);
          this.sql.exec(
            "UPDATE node_devices SET state=? WHERE id=?",
            "revoked",
            id,
          );
          this.sql.exec(
            "UPDATE tokens SET revoked=COALESCE(revoked,?) WHERE id=?",
            now(),
            relay,
          );
          this.sql.exec(
            "UPDATE credentials SET pending=1,next_try=0 WHERE token_id=? AND expires>?",
            relay,
            now(),
          );
          this.node().store.remove("ice-cache", id);
        });
        this.sockets.recheck();
        return json({ revoked: true });
      }
      if (path === "/backup" && request.method === "GET")
        return json(new NodeRecovery(this.sql, this.ctx.storage).backup());
      if (path === "/restore" && request.method === "POST") {
        await this.ctx.storage.setAlarm(now() + 1000);
        const snapshot = await readJson(request, 4 * 1024 * 1024);
        new NodeRecovery(this.sql, this.ctx.storage).restore(snapshot);
        this.sockets.recheck();
        return json({ restored: true, reauthentication_required: true });
      }
      if (path === "/login-budget" && request.method === "POST") {
        const body = await readJson(request);
        return this.consume(
          `login:${String(body.ip).slice(0, 128)}`,
          10,
          60_000,
        )
          ? json({ ok: true })
          : json({ error: { code: "RATE_LIMITED" } }, 429, {
              "Retry-After": "60",
            });
      }
      if (path === "/admin-session" && request.method === "POST") {
        const body = await readJson(request);
        if (typeof body.hash !== "string" || typeof body.expires !== "number")
          return error("INVALID_SESSION");
        this.sql.exec(
          "INSERT INTO admin_sessions VALUES (?,?)",
          body.hash,
          body.expires,
        );
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null || alarm > now() + 60_000)
          await this.ctx.storage.setAlarm(now() + 60_000);
        return json({ ok: true });
      }
      if (path === "/admin-check" && request.method === "POST") {
        const body = await readJson(request);
        const valid =
          this.sql
            .exec(
              "SELECT hash FROM admin_sessions WHERE hash=? AND expires>?",
              String(body.hash),
              now(),
            )
            .toArray().length > 0;
        return valid ? json({ ok: true }) : error("INVALID_CREDENTIALS", 401);
      }
      if (path === "/admin-logout" && request.method === "POST") {
        const body = await readJson(request);
        this.sql.exec(
          "DELETE FROM admin_sessions WHERE hash=?",
          String(body.hash),
        );
        return json({ ok: true });
      }
      if (path === "/tokens" && request.method === "GET") {
        const rows = this.sql
          .exec(
            "SELECT id,name,created,revoked,requests,successes,failures,last_used FROM tokens WHERE kind='source' ORDER BY created DESC LIMIT 500",
          )
          .toArray();
        const tasks = this.sql
          .exec(
            "SELECT token_id,count(*) AS pending FROM credentials WHERE pending=1 AND expires>? GROUP BY token_id",
            now(),
          )
          .toArray();
        return json({ tokens: rows, revocations: tasks });
      }
      if (path === "/tokens" && request.method === "POST") {
        const body = await readJson(request);
        const name = body.name;
        if (
          typeof name !== "string" ||
          name.trim().length < 1 ||
          name.length > 80
        )
          return error("INVALID_NAME");
        if (!this.consume("admin-create", 30, 3600_000))
          return json({ error: { code: "RATE_LIMITED" } }, 429, {
            "Retry-After": "3600",
          });
        if (
          this.sql
            .exec<{ count: number }>("SELECT count(*) AS count FROM tokens")
            .one().count >= 500
        )
          return error("TOKEN_CAPACITY", 409);
        const token = await issueToken(this.env);
        const id = token.split(".")[2];
        const hash = await digest(token);
        this.sql.exec(
          "INSERT INTO tokens(id,hash,name,created) VALUES (?,?,?,?)",
          id,
          hash,
          name.trim(),
          now(),
        );
        return json({ id, token }, 201);
      }
      const match = path.match(/^\/tokens\/([A-Za-z0-9_-]{43})\/revoke$/);
      if (match && request.method === "POST") {
        await this.ctx.storage.setAlarm(now() + 1000);
        const found = this.ctx.storage.transactionSync(() => {
          const token = this.sql
            .exec<Token>("SELECT * FROM tokens WHERE id=?", match[1])
            .toArray()[0];
          if (!token) return false;
          this.sql.exec(
            "UPDATE tokens SET revoked=COALESCE(revoked,?) WHERE id=?",
            now(),
            token.id,
          );
          this.sql.exec(
            "UPDATE credentials SET pending=1,next_try=0 WHERE token_id=? AND expires>?",
            token.id,
            now(),
          );
          return true;
        });
        return found
          ? json({ revoked: true, upstream: "pending" })
          : error("NOT_FOUND", 404);
      }
      if (path === "/ice" && request.method === "POST") {
        const body = await readJson(request);
        if (typeof body.hash !== "string")
          return error("INVALID_CREDENTIALS", 401);
        return this.issue(body.hash);
      }
      return error("NOT_FOUND", 404);
    } catch (failure) {
      return failure instanceof HttpInputError || failure instanceof NodeError
        ? error(failure.code, failure.status)
        : error("STORAGE_UNAVAILABLE", 503);
    }
  }
  private async issue(hash: string): Promise<Response> {
    const token = this.token(hash);
    if (!token || token.revoked !== null)
      return error("INVALID_CREDENTIALS", 401);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > now() + 60_000)
      await this.ctx.storage.setAlarm(now() + 60_000);
    const allowed =
      this.consume(`issue:${token.id}`, 24, 3600_000) &&
      this.consume("issue:deployment", 240, 3600_000);
    if (!allowed)
      return json({ error: { code: "RATE_LIMITED" } }, 429, {
        "Retry-After": "3600",
      });
    const operation = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO issuance VALUES (?,?,?,NULL)",
      operation,
      token.id,
      now(),
    );
    this.sql.exec(
      "UPDATE tokens SET requests=requests+1,last_used=? WHERE id=?",
      now(),
      token.id,
    );
    let upstream: IceServer[] = [];
    const ttl = Number(this.env.CREDENTIAL_TTL || "86400");
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400)
      return error("INVALID_TTL", 503);
    const started = now();
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.TURN_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl }),
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        },
      );
      if (!response.ok) throw Error("upstream_failed");
      const data = (await readJson(response, 65536)) as {
        iceServers?: unknown;
      };
      if (!Array.isArray(data.iceServers) || data.iceServers.length > 16)
        throw Error("invalid_upstream");
      for (const item of data.iceServers) {
        if (!item || typeof item !== "object") throw Error("invalid_upstream");
        const raw = item as Record<string, unknown>;
        if (
          typeof raw.username !== "string" ||
          typeof raw.credential !== "string"
        )
          continue;
        const urls = typeof raw.urls === "string" ? [raw.urls] : raw.urls;
        if (
          !Array.isArray(urls) ||
          urls.length > 32 ||
          raw.username.length > 1024 ||
          raw.credential.length > 2048
        )
          throw Error("invalid_upstream");
        const selected: string[] = [];
        const transports = new Set<string>();
        for (const value of urls) {
          if (typeof value !== "string" || value.length > 2048)
            throw Error("invalid_upstream");
          const m = value.match(
            /^(turns?):([^\s/@?#]+):(3478|443)\?transport=(udp|tcp)$/,
          );
          if (!m) continue;
          const kind = `${m[1]}:${m[4]}`;
          if (
            !(
              (m[1] === "turn" && m[3] === "3478") ||
              (m[1] === "turns" && m[3] === "443" && m[4] === "tcp")
            )
          )
            continue;
          if (!transports.has(kind)) {
            transports.add(kind);
            selected.push(value);
          }
        }
        // Retain usernames even if no URL survives filtering, so every known issuance can be revoked.
        upstream.push({
          urls: selected,
          username: raw.username,
          credential: raw.credential,
        });
      }
      if (!upstream.some((s) => s.urls.length)) throw Error("invalid_upstream");
      const expires = started + ttl * 1000;
      const active = this.ctx.storage.transactionSync(() => {
        const current = this.token(hash);
        const active = !!current && current.revoked === null;
        for (const server of upstream)
          this.sql.exec(
            "INSERT INTO credentials(username,key_id,token_id,expires,pending) VALUES (?,?,?,?,?) ON CONFLICT(key_id,username) DO UPDATE SET pending=MAX(pending,excluded.pending)",
            server.username,
            this.env.TURN_KEY_ID,
            token.id,
            expires,
            active ? 0 : 1,
          );
        this.sql.exec(
          "UPDATE issuance SET finished=? WHERE id=?",
          now(),
          operation,
        );
        this.sql.exec(
          "UPDATE tokens SET successes=successes+? ,failures=failures+? WHERE id=?",
          active ? 1 : 0,
          active ? 0 : 1,
          token.id,
        );
        return active;
      });
      if (!active) {
        await this.drainRevocations();
        return error("INVALID_CREDENTIALS", 401);
      }
      return json({
        ice_servers: upstream.filter((s) => s.urls.length),
        expires_at: new Date(expires).toISOString(),
      });
    } catch {
      // Never return an unrecorded upstream credential. Best-effort revocation supplements the durable queue.
      for (const server of upstream) {
        try {
          this.sql.exec(
            "INSERT INTO credentials(username,key_id,token_id,expires,pending) VALUES (?,?,?,?,1) ON CONFLICT(key_id,username) DO UPDATE SET pending=1",
            server.username,
            this.env.TURN_KEY_ID,
            token.id,
            started + ttl * 1000,
          );
        } catch {}
        try {
          await this.revoke(this.env.TURN_KEY_ID, server.username);
        } catch {}
      }
      try {
        this.sql.exec(
          "UPDATE tokens SET failures=failures+1 WHERE id=?",
          token.id,
        );
        this.sql.exec(
          "UPDATE issuance SET finished=? WHERE id=?",
          now(),
          operation,
        );
      } catch {}
      return error("TURN_UPSTREAM_UNAVAILABLE", 503);
    }
  }
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.sockets.message(ws, message);
    this.sockets.recheck();
    await this.flushOutbox();
  }
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1006 ? 1000 : code);
    } catch {}
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "socket_error");
    } catch {}
  }
  private async flushOutbox(): Promise<void> {
    if (this.env.NODE_ENABLED !== "true") return;
    const node = this.node();
    const jobs = this.ctx.storage.transactionSync(() => {
      const rows = this.sql
        .exec<{
          id: string;
          device: string;
          kind: string;
          payload: string;
          attempts: number;
        }>(
          "SELECT * FROM node_outbox WHERE next_try<=? ORDER BY rowid LIMIT 8",
          now(),
        )
        .toArray();
      for (const job of rows)
        this.sql.exec(
          "UPDATE node_outbox SET next_try=? WHERE id=?",
          now() + 30_000,
          job.id,
        );
      return rows;
    });
    for (const job of jobs) {
      if (job.kind.startsWith("push-")) {
        const data = JSON.parse(job.payload);
        const call = data.call_id
          ? node.store.get("call", data.call_id)
          : undefined;
        let success = false;
        try {
          success = await node.push.deliver(
            job.device,
            job.kind === "push-call" ? "call" : "sms",
            data.wake_id,
            call,
          );
        } catch {}
        if (success || job.attempts >= 5)
          this.sql.exec("DELETE FROM node_outbox WHERE id=?", job.id);
        else
          this.sql.exec(
            "UPDATE node_outbox SET attempts=attempts+1,next_try=? WHERE id=?",
            now() + Math.min(60_000, 1000 * 2 ** job.attempts),
            job.id,
          );
        continue;
      }
      const devices = new Set<string>();
      const clients = new Set<string>();
      const payload = JSON.parse(job.payload);
      if (job.kind === "call") {
        const call = node.store.get("call", payload.call_id);
        if (call) {
          devices.add(String(call.gateway_id));
          for (const device of Object.keys(
            call._participants as Record<string, unknown>,
          )) {
            devices.add(device);
            clients.add(device);
          }
        }
      } else
        for (const row of this.sql
          .exec<{
            id: string;
            role: string;
          }>("SELECT id,role FROM node_devices WHERE state=?", "active")
          .toArray()) {
          if (row.role === "client") clients.add(row.id);
          devices.add(row.id);
        }
      this.sockets.wake(devices, job.kind === "call" ? "call" : "sms");
      this.ctx.storage.transactionSync(() => {
        for (const device of clients)
          this.sql.exec(
            "INSERT OR IGNORE INTO node_outbox(id,device,kind,payload) VALUES (?,?,?,?)",
            job.id + ":" + device,
            device,
            job.kind === "call" ? "push-call" : "push-sms",
            JSON.stringify({
              wake_id: job.id,
              ...(payload.call_id ? { call_id: payload.call_id } : {}),
            }),
          );
        this.sql.exec("DELETE FROM node_outbox WHERE id=?", job.id);
      });
    }
    if (this.sql.exec("SELECT id FROM node_outbox LIMIT 1").toArray().length) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > now() + 1000)
        await this.ctx.storage.setAlarm(now() + 1000);
    }
  }
  private async revoke(key: string, username: string): Promise<void> {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key)}/credentials/${encodeURIComponent(username)}/revoke`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.env.TURN_API_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      },
    );
    if (response.status !== 204) throw Error("revoke_failed");
  }
  private async drainRevocations(): Promise<void> {
    const rows = this.sql
      .exec<Credential>(
        "SELECT * FROM credentials WHERE pending=1 AND expires>? AND next_try<=? LIMIT 16",
        now(),
        now(),
      )
      .toArray();
    for (const row of rows) {
      try {
        await this.revoke(row.key_id, row.username);
        this.sql.exec(
          "DELETE FROM credentials WHERE key_id=? AND username=?",
          row.key_id,
          row.username,
        );
      } catch {
        this.sql.exec(
          "UPDATE credentials SET attempts=attempts+1,next_try=? WHERE key_id=? AND username=?",
          now() + Math.min(3600_000, 15000 * 2 ** Math.min(row.attempts, 8)),
          row.key_id,
          row.username,
        );
      }
    }
  }
  async alarm(): Promise<void> {
    // Schedule first: an exception or restart must not strand a committed revocation job.
    await this.ctx.storage.setAlarm(now() + 60_000);
    await this.drainRevocations();
    if (this.env.NODE_ENABLED === "true") {
      this.node().sweep();
      this.sockets.recheck();
      await this.flushOutbox();
    }
    this.sql.exec("DELETE FROM credentials WHERE expires<=?", now());
    this.sql.exec("DELETE FROM limits WHERE expires<=?", now());
    this.sql.exec("DELETE FROM admin_sessions WHERE expires<=?", now());
    this.sql.exec(
      "DELETE FROM issuance WHERE started<?",
      now() - 7 * 86400_000,
    );
    const next = this.sql
      .exec<{ next: number | null }>(
        `SELECT MIN(due) AS next FROM (
      SELECT CASE WHEN pending=1 THEN MIN(expires,MAX(next_try,?)) ELSE expires END AS due FROM credentials
      UNION ALL SELECT started+604800000 AS due FROM issuance
      UNION ALL SELECT expires AS due FROM limits
      UNION ALL SELECT expires AS due FROM admin_sessions)`,
        now() + 1000,
      )
      .one().next;
    const nodeNext =
      this.env.NODE_ENABLED === "true" ? this.node().nextDeadline() : null;
    const target =
      next === null
        ? nodeNext
        : nodeNext === null
          ? next
          : Math.min(next, nodeNext);
    if (target === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(now() + 1000, target));
  }
}
