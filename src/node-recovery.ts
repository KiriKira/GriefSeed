import { strictJson } from "./http";
import { requireThat, record, type Data } from "./node-protocol";
// Fixed table and column allowlist; imported identifiers never enter SQL.
const tables: Record<string, string[]> = {
  tokens: [
    "id",
    "hash",
    "name",
    "created",
    "kind",
    "revoked",
    "requests",
    "successes",
    "failures",
    "last_used",
  ],
  credentials: [
    "username",
    "key_id",
    "token_id",
    "expires",
    "pending",
    "attempts",
    "next_try",
  ],
  node_meta: ["key", "value"],
  node_devices: ["id", "role", "name", "platform", "state", "created"],
  node_records: ["kind", "id", "device", "body"],
  node_operations: ["scope", "id", "hash", "status", "response"],
  node_gateway_events: ["gateway", "id", "sequence", "hash", "cursor"],
  node_feed: ["cursor", "event"],
};
/** Disaster recovery deliberately requires new pairings and source tokens.
 * History and deduplication tombstones survive; executable work never does. */
export class NodeRecovery {
  constructor(
    private sql: SqlStorage,
    private storage: DurableObjectStorage,
  ) {}
  private exists(table: string) {
    return (
      this.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type=? AND name=?",
          "table",
          table,
        )
        .toArray().length > 0
    );
  }
  backup(): Data {
    const data: Record<string, unknown> = {};
    let count = 0;
    for (const table of Object.keys(tables))
      if (this.exists(table)) {
        const rows = this.sql
          .exec(`SELECT ${tables[table].join(",")} FROM ${table} LIMIT 20001`)
          .toArray();
        count += rows.length;
        requireThat(count <= 20000, "BACKUP_CAPACITY", 409);
        data[table] = rows;
      }
    const result = {
      format: "griefseed-backup",
      version: 1,
      created_at: new Date().toISOString(),
      tables: data,
    };
    requireThat(
      new TextEncoder().encode(JSON.stringify(result)).length <=
        4 * 1024 * 1024,
      "BACKUP_CAPACITY",
      409,
    );
    return result;
  }
  restore(input: Data): void {
    requireThat(
      input.format === "griefseed-backup" &&
        input.version === 1 &&
        input.confirm === "RESTORE_AND_REVOKE",
      "INVALID_BACKUP",
    );
    const data = record(input.tables);
    requireThat(
      Object.keys(data).every((t) => t in tables) && Array.isArray(data.tokens),
      "INVALID_BACKUP",
    );
    let count = 0;
    for (const [table, rows] of Object.entries(data)) {
      requireThat(
        this.exists(table) && Array.isArray(rows),
        "INCOMPATIBLE_BACKUP",
      );
      count += (rows as unknown[]).length;
      requireThat(count <= 20000, "BACKUP_CAPACITY");
      for (const value of rows as unknown[]) {
        const row = record(value);
        requireThat(
          Object.keys(row).length === tables[table].length &&
            tables[table].every((c) => Object.hasOwn(row, c)),
          "INVALID_BACKUP",
        );
        for (const v of Object.values(row))
          requireThat(
            v === null ||
              typeof v === "string" ||
              (typeof v === "number" && Number.isSafeInteger(v)),
            "INVALID_BACKUP",
          );
        if (table === "node_records") strictJson(String(row.body));
        if (table === "node_operations") strictJson(String(row.response));
        if (table === "node_feed") strictJson(String(row.event));
      }
    }
    if (this.exists("node_meta"))
      requireThat(data.node_meta, "INCOMPATIBLE_BACKUP");
    if (data.node_meta)
      requireThat(
        (data.node_meta as Data[]).some(
          (r) => r.key === "version" && r.value === "1",
        ),
        "INCOMPATIBLE_BACKUP",
      );
    this.storage.transactionSync(() => {
      // Current revocations must also survive restoration of an older snapshot.
      const revoked = new Set(
        this.sql
          .exec<{ id: string }>(
            "SELECT id FROM tokens WHERE revoked IS NOT NULL",
          )
          .toArray()
          .map((r) => r.id),
      );
      const tokens = this.sql
        .exec("SELECT " + tables.tokens.join(",") + " FROM tokens")
        .toArray();
      const credentials = this.sql
        .exec("SELECT * FROM credentials WHERE expires>?", Date.now())
        .toArray();
      for (const table of Object.keys(tables).reverse())
        if (this.exists(table)) this.sql.exec(`DELETE FROM ${table}`);
      for (const [table, rows] of Object.entries(data))
        for (const row of rows as Data[])
          this.sql.exec(
            `INSERT INTO ${table}(${tables[table].join(",")}) VALUES (${tables[table].map(() => "?").join(",")})`,
            ...tables[table].map((c) => row[c] as string | number | null),
          );
      for (const row of tokens)
        this.sql.exec(
          "INSERT OR IGNORE INTO tokens(" +
            tables.tokens.join(",") +
            ") VALUES (" +
            tables.tokens.map(() => "?").join(",") +
            ")",
          ...tables.tokens.map((c) => row[c] as string | number | null),
        );
      this.sql.exec(
        "UPDATE tokens SET revoked=COALESCE(revoked,?)",
        Date.now(),
      );
      for (const id of revoked)
        this.sql.exec(
          "UPDATE tokens SET revoked=COALESCE(revoked,?) WHERE id=?",
          Date.now(),
          id,
        );
      for (const row of credentials)
        this.sql.exec(
          "INSERT OR IGNORE INTO credentials VALUES (?,?,?,?,?,?,?)",
          row.username,
          row.key_id,
          row.token_id,
          row.expires,
          1,
          0,
          0,
        );
      this.sql.exec("UPDATE credentials SET pending=1,next_try=0");
      for (const table of [
        "admin_sessions",
        "issuance",
        "node_sessions",
        "node_join",
        "node_outbox",
        "node_budgets",
      ])
        if (this.exists(table)) this.sql.exec(`DELETE FROM ${table}`);
      if (this.exists("node_devices"))
        this.sql.exec("UPDATE node_devices SET state='revoked'");
      if (this.exists("node_records")) {
        this.sql.exec(
          "DELETE FROM node_records WHERE kind IN ('push','ice-cache','rtc-capability','proposal','reception','slot')",
        );
        for (const row of this.sql
          .exec<{
            kind: string;
            id: string;
            body: string;
          }>(
            "SELECT kind,id,body FROM node_records WHERE kind IN ('command','message','call','leg')",
          )
          .toArray()) {
          const body = record(JSON.parse(row.body));
          if (
            row.kind === "command" &&
            !["delivered", "failed", "expired"].includes(String(body.state))
          )
            body.state = "unknown";
          if (
            row.kind === "message" &&
            body.direction === "outbound" &&
            !["delivered", "failed", "expired"].includes(String(body.status))
          )
            body.status = "unknown";
          if (row.kind === "call") {
            body.state = "ended";
            body.end_reason = "restored";
            body._ended_at = Date.now();
          }
          if (row.kind === "leg") body.phase = "closed";
          this.sql.exec(
            "UPDATE node_records SET body=? WHERE kind=? AND id=?",
            JSON.stringify(body),
            row.kind,
            row.id,
          );
        }
      }
    });
  }
}
