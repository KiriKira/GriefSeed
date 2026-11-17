// Test-only SQLite deadline controls. This entry point is never bundled by Wrangler.
import worker from "../dist/index.js";
import { Deployment } from "../dist/index.js";
export class Harness extends Deployment {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/age") {
      const { kind, id, fields } = (await request.json()) as {
        kind: string;
        id: string;
        fields: Record<string, unknown>;
      };
      const sql = this.ctx.storage.sql;
      if (kind === "session")
        sql.exec(
          "UPDATE node_sessions SET access_expires=? WHERE device=?",
          Date.now() - 1000,
          id,
        );
      else {
        const row = sql
          .exec<{
            body: string;
          }>("SELECT body FROM node_records WHERE kind=? AND id=?", kind, id)
          .one();
        const body = { ...JSON.parse(row.body), ...fields };
        sql.exec(
          "UPDATE node_records SET body=? WHERE kind=? AND id=?",
          JSON.stringify(body),
          kind,
          id,
        );
      }
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__test/age")
      return env.DEPLOYMENT.get(env.DEPLOYMENT.idFromName("deployment")).fetch(
        request,
      );
    return worker.fetch(request, env);
  },
};
