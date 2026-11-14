import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const contract = YAML.parse(await readFile("protocol/openapi.yaml", "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...contract, $id: "https://griefseed.invalid/test.json" });
const responseChecks = new Map();
function checkContract(path, method, status, body) {
  const route = Object.keys(contract.paths).find((p) =>
    new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$").test(
      path.split("?")[0],
    ),
  );
  let response =
    contract.paths[route]?.[method.toLowerCase()]?.responses?.[status];
  if (response?.$ref)
    response = contract.components.responses[response.$ref.split("/").pop()];
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) return;
  const key = route + method + status;
  let check = responseChecks.get(key);
  if (!check) {
    check = ajv.compile({
      $id: "https://griefseed.invalid/test-response/" + encodeURIComponent(key),
      ...JSON.parse(
        JSON.stringify(schema).replaceAll(
          "#/components/",
          "https://griefseed.invalid/test.json#/components/",
        ),
      ),
    });
    responseChecks.set(key, check);
  }
  assert.ok(check(body), JSON.stringify(check.errors));
}

const compiled = await build({
  entryPoints: ["src/crypto.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const cryptoModule = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const gate = await build({
  entryPoints: ["src/relay.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { relayRequest } = await import(
  "data:text/javascript;base64," +
    Buffer.from(gate.outputFiles[0].text).toString("base64")
);
const key = Buffer.alloc(32, 7).toString("base64url");
const config = {
  DEPLOYMENT_ID: "test-deployment",
  TOKEN_KID: "primary",
  TOKEN_KEYS: JSON.stringify({ primary: key }),
};
const bindings = {
  ...config,
  ADMIN_PASSWORD: "test-only-password-long",
  TURN_KEY_ID: "test-key",
  TURN_API_TOKEN: "test-only-api-token",
  CREDENTIAL_TTL: "60",
};

test("signed token vectors, isolation, canonical parsing, and zero DO calls on invalid signatures", async () => {
  const id = Buffer.alloc(32, 9).toString("base64url");
  const token = await cryptoModule.issueToken(config, id);
  const { createHmac } = await import("node:crypto");
  const prefix = `v1.primary.${id}`;
  assert.equal(
    token,
    `${prefix}.${createHmac("sha256", Buffer.from(key, "base64url")).update(`griefseed-relay\ntest-deployment\n${prefix}`).digest("base64url")}`,
  );
  let calls = 0;
  const query = async () => {
    calls++;
    return new Response("ok");
  };
  for (const invalid of [
    "",
    token + "=",
    token.replace("v1", "v2"),
    token.replace("primary", "unknown"),
    token.replace(id, Buffer.alloc(32, 3).toString("base64url")),
    token.slice(0, -1) + "!",
    "v1.primary.bad.bad",
  ]) {
    assert.equal(
      (await relayRequest(config, "Bearer " + invalid, query)).status,
      401,
    );
  }
  assert.equal(calls, 0);
  assert.equal(
    await cryptoModule.verifyToken(
      { ...config, DEPLOYMENT_ID: "other" },
      token,
    ),
    false,
  );
  assert.equal(
    (await relayRequest(config, "Bearer " + token, query)).status,
    200,
  );
  assert.equal(calls, 1);
  const rotated = {
    ...config,
    TOKEN_KID: "next",
    TOKEN_KEYS: JSON.stringify({
      primary: key,
      next: Buffer.alloc(32, 5).toString("base64url"),
    }),
  };
  assert.equal(await cryptoModule.verifyToken(rotated, token), true);
  assert.equal(
    await cryptoModule.verifyToken(
      {
        ...rotated,
        TOKEN_KEYS: JSON.stringify({
          next: Buffer.alloc(32, 5).toString("base64url"),
        }),
      },
      token,
    ),
    false,
  );
});

function runtime(directory, upstream) {
  return new Miniflare({
    modules: true,
    scriptPath: "dist/index.js",
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    durableObjects: {
      DEPLOYMENT: { className: "Deployment", useSQLite: true },
    },
    durableObjectsPersist: directory,
    outboundService: upstream,
  });
}
async function login(mf) {
  const r = await mf.dispatchFetch("https://local/admin/login", {
    method: "POST",
    headers: { Origin: "https://local", "Content-Type": "application/json" },
    body: JSON.stringify({ password: bindings.ADMIN_PASSWORD }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const { csrf } = await r.json();
  return {
    Cookie: r.headers.get("Set-Cookie").split(";")[0],
    Origin: "https://local",
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
  };
}
async function create(mf, headers) {
  const r = await mf.dispatchFetch("https://local/admin/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "phone <safe>" }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}

test("actual SQLite DO issuance survives restart; revocation persists, fails closed, and retries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "griefseed-test-"));
  let mf;
  let revoked = [];
  let fail = false;
  const upstream = async (req) => {
    if (req.url.endsWith("/revoke")) {
      if (fail) return new Response("", { status: 503 });
      revoked.push(req.url);
      return new Response(null, { status: 204 });
    }
    return Response.json({
      iceServers: [
        {
          urls: [
            "turn:turn.cloudflare.com:53?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "issued-user",
          credential: "test-only-password",
        },
      ],
    });
  };
  try {
    mf = runtime(dir, upstream);
    const headers = await login(mf);
    const token = await create(mf, headers);
    assert.match(token.link, /^mahogsm:\/\/relay\?/);
    assert.match(token.qr, /<svg/);
    let r = await mf.dispatchFetch("https://local/v1/rtc/ice-servers", {
      headers: { Authorization: "Bearer " + token.token },
    });
    assert.equal(r.status, 200, await r.clone().text());
    const result = await r.json();
    assert.equal(result.ice_servers[0].urls.length, 3);
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.ok(Date.parse(result.expires_at) > Date.now());
    await mf.dispose();
    mf = runtime(dir, upstream);
    r = await mf.dispatchFetch("https://local/v1/rtc/ice-servers", {
      headers: { Authorization: "Bearer " + token.token },
    });
    assert.equal(r.status, 200);
    const newHeaders = await login(mf);
    fail = true;
    r = await mf.dispatchFetch(
      `https://local/admin/tokens/${token.id}/revoke`,
      { method: "POST", headers: newHeaders, body: "{}" },
    );
    assert.equal(r.status, 200);
    r = await mf.dispatchFetch("https://local/v1/rtc/ice-servers", {
      headers: { Authorization: "Bearer " + token.token },
    });
    assert.equal(r.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    let list = await (
      await mf.dispatchFetch("https://local/admin/tokens", {
        headers: newHeaders,
      })
    ).json();
    assert.equal(list.tokens[0].revoked !== null, true);
    assert.equal(list.revocations[0].pending, 1);
    fail = false;
    await mf.dispatchFetch(`https://local/admin/tokens/${token.id}/revoke`, {
      method: "POST",
      headers: newHeaders,
      body: "{}",
    });
    await new Promise((resolve) => setTimeout(resolve, 1400));
    list = await (
      await mf.dispatchFetch("https://local/admin/tokens", {
        headers: newHeaders,
      })
    ).json();
    assert.equal(list.revocations.length, 0);
    assert.equal(revoked.length, 1);
  } finally {
    if (mf) await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("admin endpoints reject cross-origin requests, missing CSRF, and bad password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "griefseed-auth-"));
  const mf = runtime(dir, async () => new Response(null, { status: 503 }));
  try {
    let r = await mf.dispatchFetch("https://local/admin/login", {
      method: "POST",
      headers: { Origin: "https://evil", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 403);
    r = await mf.dispatchFetch("https://local/admin/login", {
      method: "POST",
      headers: { Origin: "https://local", "Content-Type": "application/json" },
      body: '{"password":"wrong"}',
    });
    assert.equal(r.status, 401);
    const headers = await login(mf);
    delete headers["X-CSRF-Token"];
    r = await mf.dispatchFetch("https://local/admin/tokens", {
      method: "POST",
      headers,
      body: '{"name":"no"}',
    });
    assert.equal(r.status, 403);
    r = await mf.dispatchFetch("https://local/tokens");
    assert.equal(r.status, 404);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("revocation interleaves with upstream signing and prevents returning credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "griefseed-race-"));
  let release, announce;
  const gate = new Promise((r) => (release = r));
  const started = new Promise((r) => (announce = r));
  let revoked = 0;
  const mf = runtime(dir, async (req) => {
    if (req.url.endsWith("/revoke")) {
      revoked++;
      return new Response(null, { status: 204 });
    }
    announce();
    await gate;
    return Response.json({
      iceServers: [
        {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "race-user",
          credential: "test-only-password",
        },
      ],
    });
  });
  try {
    const headers = await login(mf);
    const token = await create(mf, headers);
    const request = mf.dispatchFetch("https://local/v1/rtc/ice-servers", {
      headers: { Authorization: "Bearer " + token.token },
    });
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("upstream did not start")), 5000),
      ),
    ]);
    const response = await mf.dispatchFetch(
      `https://local/admin/tokens/${token.id}/revoke`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(response.status, 200);
    release();
    assert.equal((await request).status, 401);
    assert.ok(revoked >= 1);
    const r = await mf.dispatchFetch("https://local/admin/logout", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(r.status, 200);
    assert.equal(
      (await mf.dispatchFetch("https://local/admin/tokens", { headers }))
        .status,
      401,
    );
  } finally {
    release();
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("experimental node pairs each role once, rotates sessions recoverably, binds SIMs and durably claims SMS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "griefseed-node-"));
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/index.js",
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { ...bindings, NODE_ENABLED: "true" },
    outboundService: async () =>
      Response.json({
        iceServers: [
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
            username: crypto.randomUUID(),
            credential: "test-only-password",
          },
        ],
      }),
    durableObjects: {
      DEPLOYMENT: { className: "Deployment", useSQLite: true },
    },
    durableObjectsPersist: dir,
  });
  const send = async (path, method = "GET", body, token, extra = {}) => {
    const response = await mf.dispatchFetch("https://local/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status !== 101 && response.status !== 204)
      checkContract(
        path,
        method,
        response.status,
        await response.clone().json(),
      );
    return response;
  };
  try {
    const headers = await login(mf);
    const joinResponse = await mf.dispatchFetch("https://local/admin/join", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(joinResponse.status, 201, await joinResponse.clone().text());
    const { join_code } = await joinResponse.json();
    const pair = async (role) => {
      const r = await send("/pairings/claim", "POST", {
        pairing_code: join_code,
        device_name: role,
        platform: "android",
        role,
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json();
    };
    const gateway = await pair("gateway");
    const host = await pair("client");
    assert.equal(gateway.owner_id, host.owner_id);
    const wakeResponse = await send(
      "/ws",
      "GET",
      undefined,
      host.access_token,
      { Upgrade: "websocket" },
    );
    assert.equal(wakeResponse.status, 101);
    const wake = wakeResponse.webSocket;
    wake.accept();
    const controlResponse = await send(
      "/rtc/control/ws",
      "GET",
      undefined,
      host.access_token,
      { Upgrade: "websocket" },
    );
    assert.equal(controlResponse.status, 101);
    const socket = controlResponse.webSocket;
    socket.accept();
    const nextMessage = () =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("socket response timed out")),
          3000,
        );
        const listener = (event) => {
          const data = JSON.parse(event.data);
          if (data.event === "snapshot") return;
          clearTimeout(timeout);
          socket.removeEventListener("message", listener);
          resolve(data);
        };
        socket.addEventListener("message", listener);
      });
    const waiting = nextMessage();
    socket.send(
      JSON.stringify({
        version: 1,
        request_id: "first-request",
        method: "POST",
        path: "/rtc/control/capability",
        body: { version: 1, enabled: true },
      }),
    );
    const socketReply = await waiting;
    assert.equal(socketReply.status, 200);
    assert.equal(socketReply.request_id, "first-request");

    assert.equal(
      (
        await send("/pairings/claim", "POST", {
          pairing_code: join_code,
          device_name: "replay",
          role: "gateway",
        })
      ).status,
      401,
    );
    const socketClosed = new Promise((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    const key = "refresh-test-idempotency-key";
    let r = await send(
      "/auth/refresh",
      "POST",
      { refresh_token: host.refresh_token },
      null,
      { "Idempotency-Key": key },
    );
    assert.equal(r.status, 200, await r.clone().text());
    const next = await r.json();
    r = await send(
      "/auth/refresh",
      "POST",
      { refresh_token: host.refresh_token },
      null,
      { "Idempotency-Key": key },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), next);
    assert.equal(
      (await send("/clients", "GET", undefined, host.access_token)).status,
      401,
    );
    host.access_token = next.access_token;
    assert.equal(await socketClosed, 1008);
    const operation_id = crypto.randomUUID();
    const sim = crypto.randomUUID();
    r = await send(
      `/gateways/${gateway.device_id}/sim-bindings`,
      "POST",
      {
        operation_id,
        phase: "propose",
        mappings: [
          {
            slot_index: 0,
            label: "SIM 1",
            same_sim_verified: false,
            proposed_sim_id: sim,
          },
        ],
      },
      gateway.access_token,
    );
    assert.equal(r.status, 200, await r.clone().text());
    const proposal = await r.json();
    r = await send(
      `/gateways/${gateway.device_id}/sim-bindings`,
      "POST",
      {
        operation_id,
        phase: "confirm",
        confirmations: [{ sim_id: sim, slot_index: 0, confirmed: true }],
      },
      gateway.access_token,
    );
    assert.equal(r.status, 200, await r.clone().text());
    const message = {
      message_id: crypto.randomUUID(),
      gateway_id: gateway.device_id,
      sim_id: sim,
      mapping_revision: proposal.mapping_revision,
      to: "+15550100200",
      text: "测试短信",
      ttl_seconds: 3600,
    };
    r = await send("/messages", "POST", message, host.access_token, {
      "Idempotency-Key": "sms-test-idempotency-key",
    });
    assert.equal(r.status, 201, await r.clone().text());
    const created = await r.json();
    r = await send("/messages", "POST", message, host.access_token, {
      "Idempotency-Key": "sms-test-idempotency-key",
    });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).message_id, created.message_id);
    r = await send(
      "/messages",
      "POST",
      { ...message, text: "changed" },
      host.access_token,
      { "Idempotency-Key": "sms-test-idempotency-key" },
    );
    assert.equal(r.status, 409);
    r = await send(
      `/gateways/${gateway.device_id}/commands`,
      "GET",
      undefined,
      gateway.access_token,
    );
    const commands = await r.json();
    assert.equal(commands.commands.length, 1);
    const command = commands.commands[0];
    r = await send(
      `/gateways/${gateway.device_id}/commands/${command.command_id}/claim`,
      "POST",
      { payload_sha256: command.payload_sha256 },
      gateway.access_token,
    );
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state, "accepted_by_gateway");
    const event = {
      protocol_version: 1,
      event_id: crypto.randomUUID(),
      gateway_id: gateway.device_id,
      sequence: 1,
      occurred_at: new Date().toISOString(),
      type: "sms.dispatching",
      sim_id: sim,
      mapping_revision: proposal.mapping_revision,
      payload: {
        message_id: message.message_id,
        command_id: command.command_id,
        part_count: 1,
      },
    };
    r = await send(
      `/gateways/${gateway.device_id}/events:batch`,
      "POST",
      { events: [event] },
      gateway.access_token,
    );
    assert.equal(r.status, 200, await r.clone().text());
    const ack = await r.json();
    r = await send(
      `/gateways/${gateway.device_id}/events:batch`,
      "POST",
      { events: [event] },
      gateway.access_token,
    );
    assert.equal(r.status, 200);
    assert.equal((await r.json()).acks[0].duplicate, true);
    r = await send(
      `/gateways/${gateway.device_id}/events:batch`,
      "POST",
      { events: [{ ...event, payload: { ...event.payload, part_count: 2 } }] },
      gateway.access_token,
    );
    assert.equal(r.status, 409);
    r = await send(
      `/gateways/${gateway.device_id}/commands`,
      "GET",
      undefined,
      host.access_token,
    );
    assert.equal(r.status, 403);
    r = await send("/events", "GET", undefined, host.access_token);
    assert.ok((await r.json()).items.length >= 3);
    r = await send(
      "/events/ack",
      "POST",
      { durable_cursor: ack.acks[0].event_cursor },
      host.access_token,
    );
    assert.equal(r.status, 200);
    // A real HTTP media/control handshake is required before cellular dispatch.
    r = await send(
      `/gateways/${gateway.device_id}/heartbeat`,
      "POST",
      {
        sequence: 1,
        protocol_version: 1,
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
    assert.equal(r.status, 200, await r.clone().text());
    for (const token of [host.access_token, gateway.access_token]) {
      r = await send(
        "/rtc/control/capability",
        "POST",
        { version: 1, enabled: true },
        token,
      );
      assert.equal(r.status, 200);
    }
    const call_id = crypto.randomUUID();
    const callBody = {
      version: 1,
      operation_id: crypto.randomUUID(),
      call_id,
      gateway_id: gateway.device_id,
      sim_id: sim,
      mapping_revision: proposal.mapping_revision,
      to: "+15550100200",
    };
    r = await send("/rtc/control/calls", "POST", callBody, host.access_token);
    assert.equal(r.status, 201, await r.clone().text());
    let call = await r.json();
    const operation = async (kind, token, expected = 200) => {
      const current = await (
        await send("/rtc/control/calls/" + call_id, "GET", undefined, token)
      ).json();
      const response = await send(
        "/rtc/control/calls/" + call_id + "/operations",
        "POST",
        {
          version: 1,
          operation_id: crypto.randomUUID(),
          revision: current.state_revision,
          kind,
        },
        token,
      );
      assert.equal(response.status, expected, await response.clone().text());
      return response.json();
    };
    await operation("start", host.access_token);
    await operation("dispatch", gateway.access_token, 409);
    r = await send(
      `/calls/${call_id}/media`,
      "POST",
      { media_transport: "webrtc" },
      host.access_token,
    );
    assert.equal(r.status, 200, await r.clone().text());
    const admission = await r.json();
    assert.equal(admission.ice_servers.length, 1);
    let leg = await (
      await send(
        "/rtc/legs/" + admission.binding.leg_id,
        "GET",
        undefined,
        host.access_token,
      )
    ).json();
    const signal = async (kind, token, sdp) => {
      const response = await send(
        "/rtc/legs/" + admission.binding.leg_id,
        "POST",
        {
          version: 1,
          call_id,
          leg_id: admission.binding.leg_id,
          attempt_id: admission.binding.attempt_id,
          operation_id: crypto.randomUUID(),
          generation: 1,
          revision: leg.state.snapshot.revision,
          kind,
          sdp,
        },
        token,
      );
      assert.equal(response.status, 200, await response.clone().text());
      leg = await (
        await send(
          "/rtc/legs/" + admission.binding.leg_id,
          "GET",
          undefined,
          host.access_token,
        )
      ).json();
    };
    await signal("offer", host.access_token, "v=0\r\n");
    await signal("answer", gateway.access_token, "v=0\r\n");
    assert.equal(leg.state.snapshot.phase, "negotiated");
    call = await operation("dispatch", gateway.access_token);
    assert.equal(call.dispatched, true);
    await operation("active", gateway.access_token, 409);
    r = await send(
      `/calls/${call_id}/media/active`,
      "POST",
      { leg_id: admission.binding.leg_id },
      gateway.access_token,
    );
    assert.equal(r.status, 200);
    call = await operation("active", gateway.access_token);
    assert.equal(call.state, "active");
    call = await operation("hangup", host.access_token);
    assert.equal(call.end_requested, true);
    r = await send(
      "/rtc/control/calls",
      "POST",
      {
        ...callBody,
        call_id: crypto.randomUUID(),
        operation_id: crypto.randomUUID(),
      },
      host.access_token,
    );
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "GATEWAY_BUSY");
    await operation("ended", gateway.access_token);
    r = await mf.dispatchFetch("https://local/admin/backup", { headers });
    assert.equal(r.status, 200);
    const backup = await r.json();
    assert.equal(
      backup.tables.node_records
        .find((r) => r.kind === "command")
        .body.includes("dispatching"),
      true,
    );
    assert.ok(backup.tables.node_gateway_events.length > 0);
    r = await mf.dispatchFetch("https://local/admin/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...backup, confirm: "wrong" }),
    });
    assert.equal(r.status, 400);
    assert.equal(
      (await send("/clients", "GET", undefined, host.access_token)).status,
      200,
    );
    const restore = await mf.dispatchFetch("https://local/admin/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...backup, confirm: "RESTORE_AND_REVOKE" }),
    });
    assert.equal(restore.status, 200, await restore.clone().text());
    assert.equal(
      (await send("/clients", "GET", undefined, host.access_token)).status,
      401,
    );
    assert.equal(
      (
        await send(
          `/gateways/${gateway.device_id}/commands`,
          "GET",
          undefined,
          gateway.access_token,
        )
      ).status,
      401,
    );
    const restoredHeaders = await login(mf);
    const restored = await (
      await mf.dispatchFetch("https://local/admin/backup", {
        headers: restoredHeaders,
      })
    ).json();
    assert.equal(
      JSON.parse(
        restored.tables.node_records.find((r) => r.kind === "command").body,
      ).state,
      "unknown",
    );
    assert.equal(
      JSON.parse(
        restored.tables.node_records.find((r) => r.kind === "message").body,
      ).status,
      "unknown",
    );
    assert.equal(
      restored.tables.node_gateway_events.length,
      backup.tables.node_gateway_events.length,
    );

    r = await send("/auth/revoke", "POST", {}, host.access_token);
    assert.equal(r.status, 401);
    assert.equal(
      (await send("/clients", "GET", undefined, host.access_token)).status,
      401,
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("frozen RTC command fixtures and token purpose separation remain compatible", async () => {
  const schemasBuild = await build({
    entryPoints: ["src/generated/validators.js"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const schemas = await import(
    "data:text/javascript;base64," +
      Buffer.from(schemasBuild.outputFiles[0].text).toString("base64")
  );
  for (const kind of [
    "offer",
    "answer",
    "candidate",
    "end_of_candidates",
    "restart",
    "close",
  ])
    assert.equal(
      schemas.RTCSignalCommand(
        JSON.parse(
          await readFile("protocol/rtc-v1/fixtures/" + kind + ".json", "utf8"),
        ),
      ),
      true,
    );
  const candidate = JSON.parse(
    await readFile("protocol/rtc-v1/fixtures/candidate.json", "utf8"),
  );
  assert.equal(
    schemas.RTCSignalCommand({ ...candidate, sender_id: "untrusted" }),
    false,
  );
  assert.equal(
    schemas.RTCSignalCommand({
      ...candidate,
      ice: { ...candidate.ice, sdp_mline_index: 16 },
    }),
    false,
  );
  const relay = await cryptoModule.issueToken(config);
  const node = await cryptoModule.issueToken(config, undefined, "nodeAccess");
  assert.equal(
    await cryptoModule.verifyToken(config, relay, "nodeAccess"),
    false,
  );
  assert.equal(await cryptoModule.verifyToken(config, node), false);
});
