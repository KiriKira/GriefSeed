// Only fake local credentials; do not use this helper to serve production data.
import { Miniflare } from "miniflare";
import http from "node:http";
const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/index.js",
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    DEPLOYMENT_ID: "browser-tests",
    TOKEN_KID: "primary",
    TOKEN_KEYS: JSON.stringify({
      primary: Buffer.alloc(32, 4).toString("base64url"),
    }),
    ADMIN_PASSWORD: "test-browser-password",
    TURN_KEY_ID: "test-only",
    TURN_API_TOKEN: "test-only",
    CREDENTIAL_TTL: "60",
    NODE_ENABLED: "true",
  },
  durableObjects: { DEPLOYMENT: { className: "Deployment", useSQLite: true } },
  outboundService: async () => new Response(null, { status: 204 }),
});
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await mf.dispatchFetch("http://localhost:8787" + req.url, {
      method: req.method,
      headers: req.headers,
      body: body.length ? body : undefined,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(503);
    res.end();
  }
});
server.listen(8787, "127.0.0.1");
process.on("SIGTERM", async () => {
  server.close();
  await mf.dispose();
  process.exit(0);
});
