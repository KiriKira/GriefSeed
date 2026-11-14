import {
  canonical,
  requireThat,
  record,
  NodeError,
  type Data,
} from "./node-protocol";
/** Explicit indexes outside JSON enforce identity and replay constraints in SQLite. */
export class NodeStore {
  constructor(
    readonly sql: SqlStorage,
    readonly storage: DurableObjectStorage,
  ) {
    storage.transactionSync(() => {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_devices (id TEXT PRIMARY KEY,role TEXT NOT NULL,name TEXT NOT NULL,platform TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_sessions (id TEXT PRIMARY KEY,device TEXT NOT NULL,access_hash TEXT UNIQUE NOT NULL,refresh_hash TEXT UNIQUE NOT NULL,access_expires INTEGER NOT NULL,refresh_expires INTEGER NOT NULL,previous_hash TEXT,last_key TEXT,kid TEXT,last_issued INTEGER)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_join (hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,gateway TEXT,client TEXT)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_records (kind TEXT NOT NULL,id TEXT NOT NULL,device TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
      );
      sql.exec(
        "CREATE INDEX IF NOT EXISTS node_records_device ON node_records(kind,device)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_operations (scope TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,status INTEGER NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,id))",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_gateway_events (gateway TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,hash TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(gateway,id),UNIQUE(gateway,sequence))",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_feed (cursor INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS node_outbox (id TEXT PRIMARY KEY,device TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_try INTEGER NOT NULL DEFAULT 0)",
      );
      sql.exec(
        "CREATE INDEX IF NOT EXISTS node_records_state ON node_records(kind,json_extract(body,'$.state'),device)",
      );
      sql.exec(
        "CREATE INDEX IF NOT EXISTS node_records_created ON node_records(kind,julianday(json_extract(body,'$.created_at')),id)",
      );
      sql.exec(
        "CREATE INDEX IF NOT EXISTS node_live_calls ON node_records(id) WHERE kind='call' AND json_extract(body,'$.state') NOT IN ('ended','unknown')",
      );
      sql.exec(
        "CREATE INDEX IF NOT EXISTS node_live_legs ON node_records(id) WHERE kind='leg' AND json_extract(body,'$.phase')<>'closed'",
      );
      sql.exec(
        "INSERT OR IGNORE INTO node_meta VALUES (?,?)",
        "owner_id",
        crypto.randomUUID(),
      );
      sql.exec("INSERT OR IGNORE INTO node_meta VALUES (?,?)", "version", "1");
      requireThat(
        sql
          .exec<{
            value: string;
          }>("SELECT value FROM node_meta WHERE key=?", "version")
          .one().value === "1",
        "UNSUPPORTED_SCHEMA",
        503,
      );
    });
  }
  select(
    kind: string,
    where: string = "",
    bindings: (string | number | null)[] = [],
    order: string = "id",
    limit = 1024,
  ): Data[] {
    return this.sql
      .exec<{ body: string }>(
        `SELECT body FROM node_records WHERE kind=? ${where ? "AND " + where : ""} ORDER BY ${order} LIMIT ?`,
        kind,
        ...bindings,
        limit,
      )
      .toArray()
      .map((r) => record(JSON.parse(r.body)));
  }
  get owner(): string {
    return this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM node_meta WHERE key=?", "owner_id")
      .one().value;
  }
  get(kind: string, id: string): Data | undefined {
    const row = this.sql
      .exec<{
        body: string;
      }>("SELECT body FROM node_records WHERE kind=? AND id=?", kind, id)
      .toArray()[0];
    return row ? record(JSON.parse(row.body)) : undefined;
  }
  put(kind: string, id: string, device: string, body: Data): void {
    this.sql.exec(
      "INSERT INTO node_records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,device=excluded.device",
      kind,
      id,
      device,
      canonical(body),
    );
  }
  list(kind: string, device?: string): Data[] {
    return (
      device === undefined
        ? this.sql.exec<{ body: string }>(
            "SELECT body FROM node_records WHERE kind=?",
            kind,
          )
        : this.sql.exec<{ body: string }>(
            "SELECT body FROM node_records WHERE kind=? AND device=?",
            kind,
            device,
          )
    )
      .toArray()
      .map((row) => record(JSON.parse(row.body)));
  }
  remove(kind: string, id: string) {
    this.sql.exec("DELETE FROM node_records WHERE kind=? AND id=?", kind, id);
  }
  replay(
    scope: string,
    id: string,
    hash: string,
    work: () => { body: unknown; status: number },
  ): { body: unknown; status: number } {
    const old = this.sql
      .exec<{
        hash: string;
        response: string;
        status: number;
      }>("SELECT * FROM node_operations WHERE scope=? AND id=?", scope, id)
      .toArray()[0];
    if (old) {
      requireThat(old.hash === hash, "IDEMPOTENCY_CONFLICT", 409);
      return { body: JSON.parse(old.response), status: old.status };
    }
    const result = work();
    this.sql.exec(
      "INSERT INTO node_operations VALUES (?,?,?,?,?)",
      scope,
      id,
      hash,
      result.status,
      canonical(result.body),
    );
    return result;
  }
  feed(body: Data): number {
    const row = this.sql
      .exec<{
        cursor: number;
      }>(
        "INSERT INTO node_feed(event) VALUES (?) RETURNING cursor",
        canonical(body),
      )
      .one();
    return row.cursor;
  }
}
