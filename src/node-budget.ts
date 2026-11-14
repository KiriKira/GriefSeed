import { NodeStore } from "./node-store";
import { NodeError } from "./node-protocol";
export class NodeBudget {
  constructor(private store: NodeStore) {
    store.sql.exec(
      "CREATE TABLE IF NOT EXISTS node_budgets (scope TEXT NOT NULL,period INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(scope,period))",
    );
  }
  consume(scope: string, maximum: number, windowMs: number): void {
    const period = Math.floor(Date.now() / windowMs) * windowMs;
    this.store.storage.transactionSync(() => {
      const row = this.store.sql
        .exec<{
          count: number;
        }>(
          "SELECT count FROM node_budgets WHERE scope=? AND period=?",
          scope,
          period,
        )
        .toArray()[0];
      if (row && row.count >= maximum) throw new NodeError(429, "RATE_LIMITED");
      this.store.sql.exec(
        "INSERT INTO node_budgets VALUES (?,?,1) ON CONFLICT(scope,period) DO UPDATE SET count=count+1",
        scope,
        period,
      );
    });
  }
  cleanup() {
    this.store.sql.exec(
      "DELETE FROM node_budgets WHERE period<?",
      Date.now() - 2 * 86400_000,
    );
  }
}
