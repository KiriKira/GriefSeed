import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fix-fixture.mjs";

test("regression: winner must reject a committed hangup", async () => {
  const f = await fixture();
  try {
    let call = await f.create(true);
    call = await (await f.operation(call, f.host, "accept")).json();
    const selected = await f.send(
      `/calls/${call.call_id}/media`,
      "POST",
      { media_transport: "webrtc" },
      f.host.access_token,
    );
    assert.equal(selected.status, 200);
    const { binding } = await selected.json();
    const base = {
      version: 1,
      call_id: call.call_id,
      leg_id: binding.leg_id,
      attempt_id: binding.attempt_id,
      generation: 1,
    };
    for (const [kind, p] of [
      ["offer", f.host],
      ["answer", f.gateway],
    ]) {
      const state = await (
        await f.send(
          `/rtc/legs/${binding.leg_id}`,
          "GET",
          undefined,
          p.access_token,
        )
      ).json();
      const r = await f.send(
        `/rtc/legs/${binding.leg_id}`,
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
      assert.equal(r.status, 200);
    }
    const end = await f.operation(call, f.host, "hangup");
    assert.equal(end.status, 200);
    call = await end.json();
    assert.equal(call.end_requested, true);
    const winner = await f.operation(call, f.gateway, "winner", {
      candidate_client_id: f.host.device_id,
    });
    const won = await winner.json();
    console.log(
      "winner after hangup:",
      winner.status,
      "end_requested:",
      won.end_requested,
      "winner assigned:",
      !!won.winner_client_id,
    );
    assert.equal(winner.status, 409);
    const ended = await f.operation(call, f.gateway, "ended");
    assert.equal(ended.status, 200);
    assert.equal((await f.create()).state, "reserved");
  } finally {
    await f.close();
  }
});
test("regression: interrupted test call retains gateway slot after restart", async () => {
  const f = await fixture();
  try {
    const request = await (
      await f.send(
        "/rtc/control/test-calls",
        "POST",
        {
          version: 1,
          operation_id: crypto.randomUUID(),
          gateway_id: f.gateway.device_id,
        },
        f.host.access_token,
      )
    ).json();
    const id = crypto.randomUUID();
    const response = await f.send(
      "/rtc/control/incoming",
      "POST",
      {
        version: 1,
        operation_id: crypto.randomUUID(),
        call_id: id,
        gateway_id: f.gateway.device_id,
        sim_id: f.sim,
        mapping_revision: f.revision,
        to: "",
        from: "test",
        test_request_id: request.request_id,
      },
      f.gateway.access_token,
    );
    assert.equal(response.status, 201);
    await f.age("call", id, { _gateway_seen: Date.now() - 21000 });
    await f.restart();
    const state = await (
      await f.send(
        `/rtc/control/calls/${id}`,
        "GET",
        undefined,
        f.gateway.access_token,
      )
    ).json();
    const next = await f.send(
      "/rtc/control/test-calls",
      "POST",
      {
        version: 1,
        operation_id: crypto.randomUUID(),
        gateway_id: f.gateway.device_id,
      },
      f.host.access_token,
    );
    console.log(
      "orphaned test call:",
      state.state,
      "next test:",
      next.status,
      (await next.json()).error?.code,
    );
    assert.equal(state.state, "unknown");
    assert.equal(next.status, 409);
  } finally {
    await f.close();
  }
});
