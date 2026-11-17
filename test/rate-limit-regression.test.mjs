import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fix-fixture.mjs";

test("regression: push probe throttle must expire after a minute", async () => {
  const f = await fixture({
    bindings: { PUSH_ALLOWED_HOSTS: "push.example" },
    upstream: async () => new Response(null, { status: 204 }),
  });
  try {
    const registration = await f.send(
      "/devices/self/push-endpoint",
      "PUT",
      { endpoint: "https://push.example/a" },
      f.host.access_token,
    );
    assert.equal(registration.status, 200);
    const first = await f.send(
      "/devices/self/push-endpoint/test",
      "POST",
      {},
      f.host.access_token,
    );
    assert.equal(first.status, 200);
    const second = await f.send(
      "/devices/self/push-endpoint/test",
      "POST",
      {},
      f.host.access_token,
    );
    const delay = Number(second.headers.get("Retry-After"));
    console.log(
      "second push probe:",
      second.status,
      (await second.json()).error?.code,
      "Retry-After:",
      delay,
    );
    assert.equal(second.status, 429);
    assert.ok(delay <= 60);
    await f.age("push", f.host.device_id, { tested_at: Date.now() - 61_000 });
    assert.equal(
      (
        await f.send(
          "/devices/self/push-endpoint/test",
          "POST",
          {},
          f.host.access_token,
        )
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});
