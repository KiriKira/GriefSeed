import { type Data, record, string, requireThat } from "./node-protocol";
import { error, json, strictJson } from "./http";
import type { NodeState } from "./node-state";
type Attachment = { hash: string; device: string; kind: "wake" | "control" };
export class NodeSockets {
  constructor(
    private ctx: DurableObjectState,
    private node: () => NodeState,
  ) {}
  async open(request: Request, kind: "wake" | "control"): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return error("WEBSOCKET_REQUIRED", 400);
    const principal = await this.node().auth.authenticate(request);
    const own = this.ctx.getWebSockets().filter((ws) => {
      try {
        return (
          (ws.deserializeAttachment() as Attachment)?.device === principal.id
        );
      } catch {
        return false;
      }
    });
    if (own.length >= 3)
      return json({ error: { code: "CONTROL_CONNECTION_LIMIT" } }, 429, {
        "Retry-After": "30",
      });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      hash: principal.access_hash,
      device: principal.id,
      kind,
    } satisfies Attachment);
    if (kind === "wake")
      server.send(
        JSON.stringify({ protocol_version: 1, type: "sync_required" }),
      );
    else
      server.send(
        JSON.stringify({
          version: 1,
          event: "snapshot",
          calls: this.node().rtc.currentCalls(principal),
        }),
      );
    return new Response(null, { status: 101, webSocket: client });
  }
  async message(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const attachment = ws.deserializeAttachment() as Attachment;
      const principal = this.node().auth.fromHash(attachment.hash);
      if (attachment.kind === "wake") {
        ws.close(1008, "wake_only");
        return;
      }
      if (
        typeof message !== "string" ||
        new TextEncoder().encode(message).length > 262144
      ) {
        ws.close(1009, "message_limit");
        return;
      }
      const request = record(strictJson(message));
      requireThat(
        request.version === 1 &&
          typeof request.request_id === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(request.request_id),
        "INVALID_CONTROL_FRAME",
      );
      const path = string(request.path);
      const method = string(request.method);
      requireThat(
        ["GET", "POST", "PUT", "DELETE"].includes(method) &&
          new RegExp(
            "^/(auth/(refresh|revoke)|gateways(/[A-Za-z0-9_-]+/(heartbeat|sims|sim-bindings|events:batch|commands(/[A-Za-z0-9_-]+/claim)?))?|clients|messages(/[A-Za-z0-9_-]+)?|events(/ack)?|devices/self/(rtc-capability|reception)|rtc/(control/(capability|calls(/[A-Za-z0-9_-]+(/operations)?)?|incoming(-policy)?)|legs/[A-Za-z0-9_-]+)|calls(/[A-Za-z0-9_-]+(/media(/active)?)?)?)(\\?[^#\\s]*)?$",
          ).test(path),
        "INVALID_CONTROL_PATH",
      );
      const response = await this.node().fetch(
        new Request("https://node/v1" + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(typeof request.idempotency_key === "string"
              ? { "Idempotency-Key": request.idempotency_key }
              : {}),
          },
          body: ["POST", "PUT"].includes(method)
            ? JSON.stringify(request.body || {})
            : undefined,
        }),
        principal,
      );
      const body = response.status === 204 ? null : await response.json();
      if (path === "/auth/refresh" && response.ok) {
        const next = await this.node().auth.authenticate(
          new Request("https://node", {
            headers: {
              Authorization: "Bearer " + string(record(body).access_token),
            },
          }),
        );
        requireThat(next.id === attachment.device, "SESSION_CHANGED", 403);
        ws.serializeAttachment({ ...attachment, hash: next.access_hash });
      } else if (path !== "/auth/revoke") this.node().auth.recheck(principal);
      ws.send(
        JSON.stringify({
          version: 1,
          request_id: request.request_id,
          status: response.status,
          body,
          ...(response.headers.get("Retry-After")
            ? { retry_after: Number(response.headers.get("Retry-After")) }
            : {}),
        }),
      );
    } catch {
      try {
        ws.close(1008, "authorization_or_protocol");
      } catch {}
    }
  }
  wake(devices: Set<string>, domain: "sms" | "call"): void {
    for (const ws of this.ctx.getWebSockets())
      try {
        const attachment = ws.deserializeAttachment() as Attachment;
        if (!devices.has(attachment.device)) continue;
        const principal = this.node().auth.fromHash(attachment.hash);
        const reception = this.node().store.get("reception", principal.id);
        if (
          principal.role === "client" &&
          domain === "sms" &&
          reception?.version === 2 &&
          reception.sms_enabled === false
        )
          continue;
        if (attachment.kind === "control") {
          ws.send(
            JSON.stringify({
              version: 1,
              event: "snapshot",
              calls: this.node().rtc.currentCalls(principal),
            }),
          );
          continue;
        }
        ws.send(
          JSON.stringify({
            protocol_version: 1,
            type: "sync_required",
            ...(principal.role === "client" && reception?.version === 2
              ? { domains: [domain] }
              : {}),
          }),
        );
      } catch {
        try {
          ws.close(1008, "session_expired");
        } catch {}
      }
  }
  recheck(): void {
    for (const ws of this.ctx.getWebSockets())
      try {
        this.node().auth.fromHash(
          (ws.deserializeAttachment() as Attachment).hash,
        );
      } catch {
        try {
          ws.close(1008, "session_expired");
        } catch {}
      }
  }
}
