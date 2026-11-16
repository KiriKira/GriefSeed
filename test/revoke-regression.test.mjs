import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fix-fixture.mjs";

test("regression: refresh-token-only revoke matches Android clients", async () => {
  const f = await fixture();
  try {
    const r = await f.send("/auth/revoke", "POST", {
      refresh_token: f.host.refresh_token,
    });
    console.log("revoke without access header:", r.status);
    const stillLive = await f.send(
      "/clients",
      "GET",
      undefined,
      f.host.access_token,
    );
    console.log("old access token after revoke:", stillLive.status);
    assert.equal(r.status, 204);
    assert.equal(stillLive.status, 401);
    assert.equal(
      (
        await f.send("/auth/revoke", "POST", {
          refresh_token: f.host.refresh_token,
        })
      ).status,
      204,
    );
    assert.equal(
      (await f.send("/clients", "GET", undefined, f.gateway.access_token))
        .status,
      403,
    );
  } finally {
    await f.close();
  }
});
test("revocation accepts expired access and the previous refresh recovery token", async () => {
  const f = await fixture();
  try {
    const rotated = await f.send(
      "/auth/refresh",
      "POST",
      { refresh_token: f.host.refresh_token },
      undefined,
      { "Idempotency-Key": "revoke-refresh-recovery-key" },
    );
    assert.equal(rotated.status, 200);
    const next = await rotated.json();
    await f.age("session", f.host.device_id);
    assert.equal(
      (
        await f.send("/auth/revoke", "POST", {
          refresh_token: f.host.refresh_token,
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await f.send("/auth/refresh", "POST", {
          refresh_token: next.refresh_token,
        })
      ).status,
      401,
    );
    assert.equal(
      (await f.send("/clients", "GET", undefined, next.access_token)).status,
      401,
    );
  } finally {
    await f.close();
  }
});
