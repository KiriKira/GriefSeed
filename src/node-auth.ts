import {
  digest,
  randomId,
  decode,
  mac,
  issueToken,
  type SigningConfig,
} from "./crypto";
import { validate, requireThat, string, iso, type Data } from "./node-protocol";
import { NodeStore } from "./node-store";
export type Principal = {
  id: string;
  role: string;
  name: string;
  platform: string;
  state: string;
  access_hash: string;
  session: string;
};
type Session = {
  id: string;
  device: string;
  access_hash: string;
  refresh_hash: string;
  access_expires: number;
  refresh_expires: number;
  previous_hash: string | null;
  last_key: string | null;
  kid: string | null;
  last_issued: number | null;
};
export class NodeAuth {
  constructor(
    private store: NodeStore,
    private env: SigningConfig,
  ) {}
  async createJoin(): Promise<Data> {
    this.store.sql.exec("DELETE FROM node_join WHERE expires<=?", Date.now());
    requireThat(
      this.store.sql
        .exec<{ n: number }>("SELECT COUNT(*) n FROM node_join")
        .one().n < 100,
      "JOIN_CAPACITY",
      409,
    );
    const code = randomId();
    const hash = await digest(code);
    const expires = Date.now() + 900_000;
    this.store.sql.exec(
      "INSERT INTO node_join(hash,expires) VALUES (?,?)",
      hash,
      expires,
    );
    return { join_code: code, expires_at: iso(expires) };
  }
  fromHash(hash: string): Principal {
    const rows = this.store.sql
      .exec<Principal>(
        `SELECT d.*,s.id AS session,s.access_hash FROM node_devices d JOIN node_sessions s ON s.device=d.id WHERE s.access_hash=? AND s.access_expires>? AND d.state='active'`,
        hash,
        Date.now(),
      )
      .toArray();
    requireThat(rows.length === 1, "INVALID_CREDENTIALS", 401);
    return rows[0];
  }
  async authenticate(request: Request): Promise<Principal> {
    const header = request.headers.get("Authorization") || "";
    requireThat(
      /^Bearer [A-Za-z0-9_.-]{20,256}$/.test(header),
      "INVALID_CREDENTIALS",
      401,
    );
    return this.fromHash(await digest(header.slice(7)));
  }
  recheck(p: Principal): void {
    this.fromHash(p.access_hash);
  }
  async claim(body: Data): Promise<Data> {
    validate("PairingClaim", body);
    const role = body.role;
    requireThat(
      role === "client" || role === "gateway",
      "INVALID_PAIRING_REQUEST",
    );
    const name = string(body.device_name).trim();
    requireThat(name.length > 0, "INVALID_PAIRING_REQUEST");
    const platform = string(body.platform ?? "").trim() || "unknown";
    const code = await digest(string(body.pairing_code).trim());
    const access = await issueToken(this.env, randomId(), "nodeAccess");
    const refresh = randomId();
    const ah = await digest(access);
    const rh = await digest(refresh);
    const device = crypto.randomUUID();
    const issued = Date.now();
    const accessExpires = issued + 900_000;
    const refreshExpires = issued + 30 * 86400_000;
    return this.store.storage.transactionSync(() => {
      const join = this.store.sql
        .exec<{
          expires: number;
          client: string | null;
          gateway: string | null;
        }>("SELECT * FROM node_join WHERE hash=?", code)
        .toArray()[0];
      requireThat(
        join && join.expires > issued && !join[role],
        "INVALID_PAIRING_CODE",
        401,
      );
      requireThat(
        this.store.sql
          .exec<{ n: number }>("SELECT COUNT(*) n FROM node_devices")
          .one().n < 64,
        "DEVICE_CAPACITY",
        409,
      );
      this.store.sql.exec(
        "INSERT INTO node_devices VALUES (?,?,?,?,?,?)",
        device,
        role,
        name,
        platform,
        "active",
        issued,
      );
      this.store.sql.exec(
        "INSERT INTO node_sessions(id,device,access_hash,refresh_hash,access_expires,refresh_expires) VALUES (?,?,?,?,?,?)",
        crypto.randomUUID(),
        device,
        ah,
        rh,
        accessExpires,
        refreshExpires,
      );
      this.store.sql.exec(
        `UPDATE node_join SET ${role}=? WHERE hash=?`,
        device,
        code,
      );
      if (role === "gateway")
        this.store.put("gateway", device, device, {
          gateway_id: device,
          mapping_revision: 0,
          sequence: 0,
          last_seen: 0,
          install_id: null,
          heartbeat_hash: null,
        });
      return {
        owner_id: this.store.owner,
        device_id: device,
        role,
        access_token: access,
        refresh_token: refresh,
        access_expires_at: iso(accessExpires),
        refresh_expires_at: iso(refreshExpires),
      };
    });
  }
  private async rotation(
    refresh: string,
    requestKey: string,
    session: Session,
    kid: string,
  ): Promise<{ access: string; refresh: string }> {
    const keys = JSON.parse(this.env.TOKEN_KEYS);
    requireThat(Object.hasOwn(keys, kid), "SESSION_REVOKED", 401);
    const key = decode(keys[kid], 32);
    const input = `${this.env.DEPLOYMENT_ID}\n${session.id}\n${refresh}\n${requestKey}`;
    return {
      access: await issueToken(
        { ...this.env, TOKEN_KID: kid },
        await mac(key, "griefseed-node-access-nonce\n" + input),
        "nodeAccess",
      ),
      refresh: await mac(key, "griefseed-node-refresh\n" + input),
    };
  }
  async refresh(
    body: Data,
    key: string | null,
    expectedDevice?: string,
  ): Promise<Data> {
    validate("RefreshRequest", body);
    const token = string(body.refresh_token);
    requireThat(
      token.length >= 20 && token.length <= 256,
      "SESSION_REVOKED",
      401,
    );
    if (key !== null)
      requireThat(
        key.length >= 16 && key.length <= 128,
        "INVALID_IDEMPOTENCY_KEY",
      );
    const hash = await digest(token);
    const original = this.store.sql
      .exec<Session>(
        "SELECT * FROM node_sessions WHERE refresh_hash=? OR previous_hash=?",
        hash,
        hash,
      )
      .toArray()[0];
    requireThat(
      original &&
        original.refresh_expires > Date.now() &&
        (!expectedDevice || original.device === expectedDevice),
      "SESSION_REVOKED",
      401,
    );
    const replay = original.previous_hash === hash;
    requireThat(
      !replay || (key !== null && key === original.last_key),
      "SESSION_REVOKED",
      401,
    );
    const requestKey = replay ? string(original.last_key) : key || randomId();
    const kid = replay ? string(original.kid) : this.env.TOKEN_KID;
    const rotated = await this.rotation(token, requestKey, original, kid);
    const accessHash = await digest(rotated.access);
    const refreshHash = await digest(rotated.refresh);
    return this.store.storage.transactionSync(() => {
      const current = this.store.sql
        .exec<Session>(
          "SELECT s.* FROM node_sessions s JOIN node_devices d ON d.id=s.device WHERE s.id=? AND d.state=?",
          original.id,
          "active",
        )
        .toArray()[0];
      requireThat(
        current && current.refresh_expires > Date.now(),
        "SESSION_REVOKED",
        401,
      );
      if (current.previous_hash === hash)
        requireThat(
          key !== null &&
            current.last_key === key &&
            current.access_hash === accessHash &&
            current.refresh_hash === refreshHash,
          "SESSION_REVOKED",
          401,
        );
      else {
        requireThat(current.refresh_hash === hash, "SESSION_REVOKED", 401);
        const issued = Date.now();
        this.store.sql.exec(
          "UPDATE node_sessions SET access_hash=?,refresh_hash=?,previous_hash=?,last_key=?,kid=?,last_issued=?,access_expires=?,refresh_expires=? WHERE id=?",
          accessHash,
          refreshHash,
          hash,
          requestKey,
          kid,
          issued,
          issued + 900_000,
          issued + 30 * 86400_000,
          current.id,
        );
      }
      const next = this.store.sql
        .exec<Session>("SELECT * FROM node_sessions WHERE id=?", current.id)
        .one();
      return {
        access_token: rotated.access,
        refresh_token: rotated.refresh,
        access_expires_at: iso(next.access_expires),
        refresh_expires_at: iso(next.refresh_expires),
      };
    });
  }
  revoke(p: Principal, refreshHash: string): Data {
    this.recheck(p);
    requireThat(
      this.store.sql
        .exec(
          "SELECT id FROM node_sessions WHERE device=? AND refresh_hash=?",
          p.id,
          refreshHash,
        )
        .toArray().length > 0,
      "SESSION_REVOKED",
      401,
    );
    this.store.sql.exec("DELETE FROM node_sessions WHERE device=?", p.id);
    return { revoked: true };
  }
}
