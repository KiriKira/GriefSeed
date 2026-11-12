import { test } from "node:test";
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
async function fixture(options = {}) {
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
function next(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("RPC timeout")), 3000);
    const listener = (e) => {
      const data = JSON.parse(e.data);
      if (data.event) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(data);
    };
    socket.addEventListener("message", listener);
  });
}

test("delayed alarms cannot revive control leases or stale gateway authority", async () => {
  const f = await fixture();
  try {
    let call = await f.create();
    await f.age("call", call.call_id, { _gateway_seen: Date.now() - 21000 });
    let response = await f.send(
      "/rtc/control/calls/" + call.call_id,
      "GET",
      undefined,
      f.host.access_token,
    );
    assert.equal((await response.json()).state, "ended");
    call = await f.create();
    await f.age("call", call.call_id, {
      dispatched: true,
      state: "dialing",
      _client_seen: Date.now() - 21000,
    });
    response = await f.send(
      "/rtc/control/calls/" + call.call_id,
      "GET",
      undefined,
      f.gateway.access_token,
    );
    const unknown = await response.json();
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.end_requested, true);
    response = await f.operation(unknown, f.gateway, "ended");
    assert.equal(response.status, 200);
    call = await f.create();
    await f.age("gateway", f.gateway.device_id, {
      last_seen: Date.now() - 91000,
    });
    response = await f.send(
      "/calls/" + call.call_id + "/media",
      "POST",
      { media_transport: "webrtc" },
      f.host.access_token,
    );
    assert.equal(response.status, 403);
  } finally {
    await f.close();
  }
});

test("two hosts cannot reserve an incoming candidate simultaneously; long ringing does not create media", async () => {
  const f = await fixture();
  try {
    const second = await f.pair("client");
    assert.equal(
      (
        await f.send(
          "/devices/self/reception",
          "PUT",
          {
            version: 2,
            expected_revision: 0,
            incoming_enabled: true,
            sms_enabled: true,
          },
          second.access_token,
        )
      ).status,
      200,
    );
    const call = await f.create(true);
    await f.age("call", call.call_id, {
      created_at: new Date(Date.now() - 61000).toISOString(),
    });
    const responses = await Promise.all([
      f.operation(call, f.host, "accept"),
      f.operation(call, second, "accept"),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const current = await (
      await f.send(
        "/rtc/control/calls/" + call.call_id,
        "GET",
        undefined,
        f.gateway.access_token,
      )
    ).json();
    assert.equal(current.state, "connecting");
    assert.ok(current.remaining_ms > 200000);
    const backup = await (
      await f.mf.dispatchFetch("https://local/admin/backup", {
        headers: f.admin,
      })
    ).json();
    assert.equal(
      backup.tables.node_records.filter((r) => r.kind === "leg").length,
      0,
    );
    assert.equal(
      (
        await f.operation(current, f.gateway, "winner", {
          candidate_client_id: current.candidate_client_id,
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("control socket refreshes its own authentication in place, then rejects expiry", async () => {
  const f = await fixture();
  try {
    const response = await f.send(
      "/rtc/control/ws",
      "GET",
      undefined,
      f.host.access_token,
      { Upgrade: "websocket" },
    );
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    socket.accept();
    let pending = next(socket);
    socket.send(
      JSON.stringify({
        version: 1,
        request_id: "refresh",
        method: "POST",
        path: "/auth/refresh",
        idempotency_key: "recoverable-refresh-key",
        body: { refresh_token: f.host.refresh_token },
      }),
    );
    const reply = await pending;
    assert.equal(reply.status, 200);
    assert.ok(reply.body.access_token);
    assert.equal(
      (await f.send("/clients", "GET", undefined, f.host.access_token)).status,
      401,
    );
    pending = next(socket);
    socket.send(
      JSON.stringify({
        version: 1,
        request_id: "next",
        method: "GET",
        path: "/clients",
      }),
    );
    assert.equal((await pending).status, 200);
    const closed = new Promise((resolve) =>
      socket.addEventListener("close", (e) => resolve(e.code), { once: true }),
    );
    await f.age("session", f.host.device_id);
    socket.send(
      JSON.stringify({
        version: 1,
        request_id: "expired",
        method: "GET",
        path: "/clients",
      }),
    );
    assert.equal(await closed, 1008);
  } finally {
    await f.close();
  }
});

test("ordinary exhaustion preserves termination budget; fake ended fields cannot use it", async () => {
  const f = await fixture();
  try {
    let call = await f.create();
    let r;
    for (let i = 0; i < 110; i++) {
      r = await f.send(
        "/rtc/control/capability",
        "POST",
        { version: 1, enabled: true },
        f.host.access_token,
      );
      if (r.status === 429) break;
    }
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("Retry-After")) > 0);
    r = await f.send(
      "/messages",
      "POST",
      { kind: "ended" },
      f.host.access_token,
    );
    assert.equal(r.status, 429);
    assert.equal(
      (
        await f.send(
          "/rtc/control/calls/" + call.call_id,
          "GET",
          undefined,
          f.host.access_token,
        )
      ).status,
      200,
    );
    r = await f.operation(call, f.host, "cancel");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state, "ended");
  } finally {
    await f.close();
  }
});

test("strict wire parsing rejects duplicate/escaped duplicate keys, unsafe integers and invalid Unicode", async () => {
  const f = await fixture();
  try {
    for (const text of [
      '{"version":1,"version":1,"enabled":true}',
      '{"version":1,"\\u0076ersion":1,"enabled":true}',
      '{"version":1,"enabled":true,"name":"\\ud800"}',
      '{"version":9007199254740993,"enabled":true}',
    ]) {
      const response = await f.mf.dispatchFetch(
        "https://local/v1/rtc/control/capability",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + f.host.access_token,
          },
          body: text,
        },
      );
      assert.equal(response.status, 400);
    }
  } finally {
    await f.close();
  }
});

test("push endpoints use an exact allowlist, never follow redirects, and retain monotonic generations", async () => {
  const posted = [];
  let redirect = false;
  const f = await fixture({
    bindings: { PUSH_ALLOWED_HOSTS: "push.example,127.0.0.1,local.internal" },
    upstream: async (request) => {
      posted.push({ url: request.url, body: await request.json() });
      return redirect
        ? new Response(null, {
            status: 302,
            headers: { Location: "https://other.example/" },
          })
        : new Response(null, { status: 204 });
    },
  });
  try {
    for (const endpoint of [
      "http://push.example/a",
      "https://user:pass@push.example/a",
      "https://push.example:444/a",
      "https://push.example/a#fragment",
      "https://other.example/a",
      "https://127.0.0.1/a",
      "https://local.internal/a",
    ])
      assert.equal(
        (
          await f.send(
            "/devices/self/push-endpoint",
            "PUT",
            { endpoint },
            f.host.access_token,
          )
        ).status,
        400,
      );
    assert.equal(posted.length, 0);
    let r = await f.send(
      "/devices/self/push-endpoint",
      "PUT",
      { endpoint: "https://push.example/a" },
      f.host.access_token,
    );
    assert.equal(r.status, 204);
    assert.equal(posted[0].body.kind, "check");
    r = await f.send(
      "/devices/self/push-endpoint",
      "DELETE",
      undefined,
      f.host.access_token,
    );
    assert.equal(r.status, 204);
    r = await f.send(
      "/devices/self/push-endpoint",
      "PUT",
      { endpoint: "https://push.example/b" },
      f.host.access_token,
    );
    assert.equal(r.status, 204);
    const snapshot = await (
      await f.mf.dispatchFetch("https://local/admin/backup", {
        headers: f.admin,
      })
    ).json();
    const push = JSON.parse(
      snapshot.tables.node_records.find((r) => r.kind === "push").body,
    );
    assert.equal(push.generation, 2);
    redirect = true;
    r = await f.send(
      "/devices/self/push-endpoint",
      "PUT",
      { endpoint: "https://push.example/redirect" },
      f.host.access_token,
    );
    assert.equal(r.status, 503);
    assert.equal(posted.length, 3);
    assert.ok(posted.every((p) => p.url.startsWith("https://push.example/")));
  } finally {
    await f.close();
  }
});

test("event batches roll back atomically; multipart terminal evidence survives late callbacks", async () => {
  const f = await fixture();
  try {
    const message = {
      message_id: crypto.randomUUID(),
      gateway_id: f.gateway.device_id,
      sim_id: f.sim,
      mapping_revision: f.revision,
      to: "+15550100",
      text: "parts",
      ttl_seconds: 3600,
    };
    let r = await f.send("/messages", "POST", message, f.host.access_token, {
      "Idempotency-Key": "test-atomic-event-message",
    });
    assert.equal(r.status, 201);
    const accepted = await r.json();
    const commands = await (
      await f.send(
        `/gateways/${f.gateway.device_id}/commands?limit=1`,
        "GET",
        undefined,
        f.gateway.access_token,
      )
    ).json();
    const command = commands.commands[0];
    r = await f.send(
      `/gateways/${f.gateway.device_id}/commands/${command.command_id}/claim`,
      "POST",
      { payload_sha256: command.payload_sha256 },
      f.gateway.access_token,
    );
    assert.equal(r.status, 200);
    let sequence = 1;
    const event = (type, payload) => ({
      protocol_version: 1,
      event_id: crypto.randomUUID(),
      gateway_id: f.gateway.device_id,
      sim_id: f.sim,
      mapping_revision: f.revision,
      sequence: sequence++,
      occurred_at: new Date().toISOString(),
      type,
      payload: {
        command_id: command.command_id,
        message_id: accepted.message_id,
        ...payload,
      },
    });
    const dispatch = event("sms.dispatching", { part_count: 2 });
    const bad = event("sms.part_state", { part_index: 5, state: "delivered" });
    r = await f.send(
      `/gateways/${f.gateway.device_id}/events:batch`,
      "POST",
      { events: [dispatch, bad] },
      f.gateway.access_token,
    );
    assert.equal(r.status, 409);
    let detail = await (
      await f.send(
        "/messages/" + message.message_id,
        "GET",
        undefined,
        f.host.access_token,
      )
    ).json();
    assert.equal(detail.part_count, null);
    assert.equal(detail.status, "accepted_by_gateway");
    const sendEvents = async (events) => {
      const r = await f.send(
        `/gateways/${f.gateway.device_id}/events:batch`,
        "POST",
        { events },
        f.gateway.access_token,
      );
      assert.equal(r.status, 200, await r.clone().text());
    };
    await sendEvents([dispatch]);
    await sendEvents([
      event("sms.part_state", { part_index: 0, state: "delivered" }),
      event("sms.part_state", { part_index: 1, state: "submitted" }),
    ]);
    detail = await (
      await f.send(
        "/messages/" + message.message_id,
        "GET",
        undefined,
        f.host.access_token,
      )
    ).json();
    assert.equal(detail.status, "submitted");
    await sendEvents([
      event("sms.part_state", { part_index: 0, state: "unknown" }),
      event("sms.command_state", { state: "failed", error: "late" }),
    ]);
    detail = await (
      await f.send(
        "/messages/" + message.message_id,
        "GET",
        undefined,
        f.host.access_token,
      )
    ).json();
    assert.equal(detail.status, "submitted");
    assert.equal(detail.parts[0].state, "delivered");
    await sendEvents([
      event("sms.part_state", { part_index: 1, state: "delivered" }),
    ]);
    detail = await (
      await f.send(
        "/messages/" + message.message_id,
        "GET",
        undefined,
        f.host.access_token,
      )
    ).json();
    assert.equal(detail.status, "delivered");
  } finally {
    await f.close();
  }
});

test("message and command pagination do not lose records with identical timestamps", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) {
      const r = await f.send(
        "/messages",
        "POST",
        {
          message_id: crypto.randomUUID(),
          gateway_id: f.gateway.device_id,
          sim_id: f.sim,
          mapping_revision: f.revision,
          to: "+15550100",
          text: "page " + i,
          ttl_seconds: 3600,
        },
        f.host.access_token,
        { "Idempotency-Key": "paging-test-key-" + i },
      );
      assert.equal(r.status, 201);
    }
    const snapshot = await (
      await f.mf.dispatchFetch("https://local/admin/backup", {
        headers: f.admin,
      })
    ).json();
    const stamp = new Date().toISOString();
    for (const row of snapshot.tables.node_records.filter((r) =>
      ["message", "command"].includes(r.kind),
    ))
      await f.age(row.kind, row.id, { created_at: stamp });
    for (const [path, token, key, id] of [
      ["/messages", f.host.access_token, "items", "message_id"],
      [
        `/gateways/${f.gateway.device_id}/commands`,
        f.gateway.access_token,
        "commands",
        "command_id",
      ],
    ]) {
      const ids = [];
      let cursor = null;
      do {
        const response = await f.send(
          path +
            "?limit=2" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          "GET",
          undefined,
          token,
        );
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.ok(page[key].length <= 2);
        ids.push(...page[key].map((r) => r[id]));
        cursor = page.next_cursor;
      } while (cursor);
      assert.equal(ids.length, 5);
      assert.equal(new Set(ids).size, 5);
    }
  } finally {
    await f.close();
  }
});

test("incoming winner requires negotiated media; losers lose access and candidate timeouts release the reservation", async () => {
  const f = await fixture();
  try {
    const second = await f.pair("client");
    await f.send(
      "/devices/self/reception",
      "PUT",
      {
        version: 2,
        expected_revision: 0,
        incoming_enabled: true,
        sms_enabled: true,
      },
      second.access_token,
    );
    let call = await f.create(true);
    let r = await f.operation(call, f.host, "accept");
    call = await r.json();
    await f.age("call", call.call_id, {
      candidate_until: new Date(Date.now() - 1).toISOString(),
    });
    call = await (
      await f.send(
        "/rtc/control/calls/" + call.call_id,
        "GET",
        undefined,
        f.gateway.access_token,
      )
    ).json();
    assert.equal(call.state, "ringing");
    assert.equal(call.candidate_client_id, undefined);
    r = await f.operation(call, f.host, "accept");
    call = await r.json();
    assert.equal(r.status, 200);
    const admit = async (p) => {
      const response = await f.send(
        "/calls/" + call.call_id + "/media",
        "POST",
        { media_transport: "webrtc" },
        p.access_token,
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const admission = await admit(f.host),
      loser = await admit(second);
    const base = {
      version: 1,
      call_id: call.call_id,
      leg_id: admission.binding.leg_id,
      attempt_id: admission.binding.attempt_id,
      generation: 1,
    };
    let state = await (
      await f.send(
        "/rtc/legs/" + base.leg_id,
        "GET",
        undefined,
        f.host.access_token,
      )
    ).json();
    for (const [kind, p] of [
      ["offer", f.host],
      ["answer", f.gateway],
    ]) {
      r = await f.send(
        "/rtc/legs/" + base.leg_id,
        "POST",
        {
          ...base,
          operation_id: crypto.randomUUID(),
          revision: state.state.snapshot.revision,
          kind,
          sdp: "v=0\r\n",
        },
        p.access_token,
      );
      assert.equal(r.status, 200, await r.clone().text());
      state = await (
        await f.send(
          "/rtc/legs/" + base.leg_id,
          "GET",
          undefined,
          f.host.access_token,
        )
      ).json();
    }
    r = await f.operation(call, f.gateway, "winner", {
      candidate_client_id: f.host.device_id,
    });
    assert.equal(r.status, 200, await r.clone().text());
    call = await r.json();
    assert.equal(call.winner_client_id, f.host.device_id);
    r = await f.send(
      "/rtc/legs/" + loser.binding.leg_id,
      "GET",
      undefined,
      second.access_token,
    );
    assert.equal(r.status, 403);
    const losingView = await (
      await f.send(
        "/rtc/control/calls/" + call.call_id,
        "GET",
        undefined,
        second.access_token,
      )
    ).json();
    assert.equal(losingView.state, "ended");
    assert.equal(losingView.reason, "answered_elsewhere");
    r = await f.operation(call, f.gateway, "active");
    assert.equal(r.status, 409);
    r = await f.send(
      "/calls/" + call.call_id + "/media/active",
      "POST",
      { leg_id: base.leg_id },
      f.gateway.access_token,
    );
    assert.equal(r.status, 200);
    r = await f.operation(call, f.gateway, "active");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state, "active");
  } finally {
    await f.close();
  }
});

test("SQLite cold restart preserves claims, replay tombstones and expired unknown occupancy", async () => {
  const f = await fixture();
  try {
    const message = {
      message_id: crypto.randomUUID(),
      gateway_id: f.gateway.device_id,
      sim_id: f.sim,
      mapping_revision: f.revision,
      to: "+15550100",
      text: "restart",
      ttl_seconds: 3600,
    };
    const headers = { "Idempotency-Key": "restart-message-test-key" };
    let r = await f.send(
      "/messages",
      "POST",
      message,
      f.host.access_token,
      headers,
    );
    const accepted = await r.json();
    assert.equal(r.status, 201);
    const command = (
      await (
        await f.send(
          `/gateways/${f.gateway.device_id}/commands`,
          "GET",
          undefined,
          f.gateway.access_token,
        )
      ).json()
    ).commands[0];
    r = await f.send(
      `/gateways/${f.gateway.device_id}/commands/${command.command_id}/claim`,
      "POST",
      { payload_sha256: command.payload_sha256 },
      f.gateway.access_token,
    );
    assert.equal(r.status, 200);
    const call = await f.create();
    await f.age("call", call.call_id, {
      dispatched: true,
      state: "dialing",
      _gateway_seen: Date.now() - 21000,
    });
    await f.restart();
    r = await f.send(
      "/messages",
      "POST",
      message,
      f.host.access_token,
      headers,
    );
    assert.equal(r.status, 201);
    assert.equal((await r.json()).command_id, accepted.command_id);
    r = await f.send(
      `/gateways/${f.gateway.device_id}/commands`,
      "GET",
      undefined,
      f.gateway.access_token,
    );
    const restored = await r.json();
    assert.equal(restored.commands.length, 1);
    assert.equal(restored.commands[0].state, "accepted_by_gateway");
    r = await f.send(
      "/rtc/control/calls/" + call.call_id,
      "GET",
      undefined,
      f.gateway.access_token,
    );
    assert.equal((await r.json()).state, "unknown");
    r = await f.send(
      "/rtc/control/calls",
      "POST",
      {
        version: 1,
        call_id: crypto.randomUUID(),
        operation_id: crypto.randomUUID(),
        gateway_id: f.gateway.device_id,
        sim_id: f.sim,
        mapping_revision: f.revision,
        to: "+15550200",
      },
      f.host.access_token,
    );
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "GATEWAY_BUSY");
  } finally {
    await f.close();
  }
});
