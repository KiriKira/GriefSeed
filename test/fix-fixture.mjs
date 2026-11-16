import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const compiled = await build({
  entryPoints: ["test/harness.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  external: ["../dist/index.js"],
  write: false,
});
const config = {
  DEPLOYMENT_ID: "node-tests",
  TOKEN_KID: "primary",
  TOKEN_KEYS: JSON.stringify({
    primary: Buffer.alloc(32, 5).toString("base64url"),
  }),
  ADMIN_PASSWORD: "test-node-admin-password",
  TURN_KEY_ID: "test-only",
  TURN_API_TOKEN: "test-only",
  CREDENTIAL_TTL: "60",
  NODE_ENABLED: "true",
  DEVICE_DAILY_BUDGET: "100",
};
export async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "node-recovery-"));
  const createRuntime = () =>
    new Miniflare({
      modules: [
        {
          type: "ESModule",
          path: "test/harness.js",
          contents: compiled.outputFiles[0].text,
        },
        { type: "ESModule", path: "dist/index.js" },
      ],
      modulesRoot: process.cwd(),
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { ...config, ...options.bindings },
      outboundService:
        options.upstream ||
        (async () =>
          Response.json({
            iceServers: [
              {
                urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
                username: crypto.randomUUID(),
                credential: "test-only",
              },
            ],
          })),
      durableObjects: { DEPLOYMENT: { className: "Harness", useSQLite: true } },
      durableObjectsPersist: dir,
    });
  let mf = createRuntime();
  const send = (path, method = "GET", body, token, extra = {}) =>
    mf.dispatchFetch("https://local/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = await mf.dispatchFetch("https://local/admin/login", {
    method: "POST",
    headers: { Origin: "https://local", "Content-Type": "application/json" },
    body: JSON.stringify({ password: config.ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const { csrf } = await login.json();
  const admin = {
    Cookie: login.headers.get("Set-Cookie").split(";")[0],
    Origin: "https://local",
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
  };
  const pair = async (role) => {
    const joinResponse = await mf.dispatchFetch("https://local/admin/join", {
      method: "POST",
      headers: admin,
      body: "{}",
    });
    const { join_code, link } = await joinResponse.json();
    assert.match(link, /^mahogsm:\/\/join\?v=2&n=/);
    const response = await send(
      "/pairings/claim",
      "POST",
      { role, pairing_code: join_code, device_name: role },
      null,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const gateway = await pair("gateway"),
    host = await pair("client");
  const sim = crypto.randomUUID(),
    op = crypto.randomUUID();
  let response = await send(
    `/gateways/${gateway.device_id}/sim-bindings`,
    "POST",
    {
      operation_id: op,
      phase: "propose",
      mappings: [{ slot_index: 0, label: "SIM", proposed_sim_id: sim }],
    },
    gateway.access_token,
  );
  const proposal = await response.json();
  response = await send(
    `/gateways/${gateway.device_id}/sim-bindings`,
    "POST",
    {
      operation_id: op,
      phase: "confirm",
      confirmations: [{ sim_id: sim, slot_index: 0, confirmed: true }],
    },
    gateway.access_token,
  );
  assert.equal(response.status, 200);
  response = await send(
    `/gateways/${gateway.device_id}/heartbeat`,
    "POST",
    {
      protocol_version: 1,
      sequence: 1,
      app_version: "test",
      root: true,
      sim_states: [
        {
          sim_id: sim,
          mapping_revision: proposal.mapping_revision,
          service_state: "in_service",
          identity_verified: true,
        },
      ],
    },
    gateway.access_token,
  );
  assert.equal(response.status, 200);
  for (const p of [gateway, host])
    assert.equal(
      (
        await send(
          "/rtc/control/capability",
          "POST",
          {
            version: 1,
            enabled: true,
            ...(p === gateway ? { global_decline: true } : {}),
          },
          p.access_token,
        )
      ).status,
      200,
    );
  const age = (kind, id, fields = {}) =>
    mf.dispatchFetch("https://local/__test/age", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, id, fields }),
    });
  const create = async (incoming = false) => {
    const call_id = crypto.randomUUID();
    const r = await send(
      "/rtc/control/" + (incoming ? "incoming" : "calls"),
      "POST",
      {
        version: 1,
        operation_id: crypto.randomUUID(),
        call_id,
        gateway_id: gateway.device_id,
        sim_id: sim,
        mapping_revision: proposal.mapping_revision,
        to: "+15550100",
        ...(incoming ? { from: "+15550200", remaining_ring_ms: 300000 } : {}),
      },
      incoming ? gateway.access_token : host.access_token,
    );
    assert.equal(r.status, 201, await r.clone().text());
    return r.json();
  };
  const operation = async (call, p, kind, extra = {}) =>
    send(
      "/rtc/control/calls/" + call.call_id + "/operations",
      "POST",
      {
        version: 1,
        operation_id: crypto.randomUUID(),
        revision: call.state_revision,
        kind,
        ...extra,
      },
      p.access_token,
    );
  return {
    mf,
    send,
    admin,
    pair,
    gateway,
    host,
    sim,
    revision: proposal.mapping_revision,
    age,
    create,
    operation,
    restart: async () => {
      await mf.dispose();
      mf = createRuntime();
      return mf;
    },
    close: async () => {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
