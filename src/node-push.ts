import {
  NodeError,
  requireThat,
  string,
  integer,
  iso,
  type Data,
} from "./node-protocol";
import { NodeStore } from "./node-store";
import type { Principal } from "./node-auth";
import type { Env } from "./index";
import { json, error, readJson } from "./http";
export class NodePush {
  constructor(
    private store: NodeStore,
    private env: Env,
    private recheck: (p: Principal) => void,
  ) {}
  get enabled() {
    return !!this.env.PUSH_ALLOWED_HOSTS?.trim();
  }
  private endpoint(value: unknown): string {
    const text = string(value);
    requireThat(text.length <= 2048, "INVALID_PUSH_ENDPOINT");
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      requireThat(false, "INVALID_PUSH_ENDPOINT");
    }
    const allowed = (this.env.PUSH_ALLOWED_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    requireThat(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        (!url.port || url.port === "443") &&
        allowed.includes(url.hostname) &&
        url.hostname.includes(".") &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) &&
        !url.hostname.startsWith("[") &&
        !["localhost", "local", "internal"].some(
          (suffix) =>
            url.hostname === suffix || url.hostname.endsWith("." + suffix),
        ),
      "INVALID_PUSH_ENDPOINT",
    );
    return url.toString();
  }
  private async post(
    endpoint: string,
    body: Data,
    ttl: number,
    urgency: string,
  ): Promise<number> {
    this.endpoint(endpoint);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          TTL: String(ttl),
          Urgency: urgency,
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Unreachable or too slow: a failed hand-off, not a node error.
      return 0;
    }
    await response.body?.cancel();
    // A Cloudflare challenge in front of the relay is not the relay's answer;
    // retry it later instead of rejecting the endpoint (as SoulGem does).
    if (response.headers.get("Cf-Mitigated")) return 503;
    return response.status;
  }
  /** As SoulGem: 404, 410, redirects and other 4xx answers mean the endpoint
   * will not reach the device; 429, 5xx and network failures are temporary. */
  private static rejected(status: number): boolean {
    return status >= 300 && status < 500 && status !== 429;
  }
  async route(request: Request, p: Principal): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    const root = "/v1/devices/self/push-endpoint";
    if (path !== root && path !== root + "/test") return undefined;
    requireThat(p.role === "client", "ROLE_FORBIDDEN", 403);
    requireThat(this.enabled, "PUSH_UNAVAILABLE", 503);
    const old = this.store.get("push", p.id);
    if (request.method === "GET" && path === root)
      return json(
        old
          ? {
              registered: true,
              failures: Number(old.failures || 0),
              call_failures: Number(old.call_failures || 0),
              endpoint_generation: Number(old.generation),
              ...(old.delivered_at ? { delivered_at: old.delivered_at } : {}),
            }
          : { registered: false },
      );
    if (request.method === "DELETE" && path === root) {
      this.store.remove("push", p.id);
      return new Response(null, { status: 204 });
    }
    if (request.method === "PUT" && path === root) {
      const body = await readJson(request);
      requireThat(Object.keys(body).length === 1, "INVALID_PUSH_ENDPOINT");
      const endpoint = this.endpoint(body.endpoint);
      const status = await this.post(
        endpoint,
        { kind: "check", device_id: p.id },
        60,
        "high",
      );
      if (NodePush.rejected(status))
        throw new NodeError(422, "PUSH_ENDPOINT_REJECTED");
      requireThat(status >= 200 && status < 300, "PUSH_UNAVAILABLE", 503);
      this.recheck(p);
      const current = this.store.get("push", p.id);
      // The same endpoint registering again keeps its generation.
      const generation =
        current?.endpoint === endpoint
          ? Number(current.generation)
          : Number(this.store.get("push-generation", p.id)?.generation || 0) +
            1;
      this.store.put("push-generation", p.id, p.id, { generation });
      // The relay just accepted the check, so the endpoint counts as working.
      this.store.put("push", p.id, p.id, {
        endpoint,
        generation,
        failures: 0,
        call_failures: 0,
        tested_at: Number(current?.tested_at || 0),
        delivered_at: iso(),
      });
      return json({ push: "ready", endpoint_generation: generation });
    }
    if (request.method === "POST" && path === root + "/test") {
      requireThat(old, "PUSH_NOT_REGISTERED", 404);
      if (Number(old.tested_at) >= Date.now() - 60_000)
        throw new NodeError(
          429,
          "PUSH_TEST_TOO_SOON",
          Number(old.tested_at) + 60_000,
        );
      old.tested_at = Date.now();
      this.store.put("push", p.id, p.id, old);
      const status = await this.post(
        string(old.endpoint),
        { kind: "sms", device_id: p.id },
        60,
        "high",
      );
      const sent = status >= 200 && status < 300;
      this.recheck(p);
      if (this.store.get("push", p.id)?.generation !== old.generation)
        return json({ sent });
      old.failures = sent ? 0 : Number(old.failures || 0) + 1;
      if (sent) old.delivered_at = iso();
      this.store.put("push", p.id, p.id, old);
      return json({ sent });
    }
    return error("NOT_FOUND", 404);
  }
  async deliver(
    device: string,
    kind: string,
    wakeId: string,
    call?: Data,
  ): Promise<boolean> {
    const endpoint = this.store.get("push", device);
    if (!endpoint || !this.enabled) return true;
    if (
      !this.store.sql
        .exec(
          "SELECT id FROM node_sessions WHERE device=? AND refresh_expires>?",
          device,
          Date.now(),
        )
        .toArray().length
    )
      return true;
    const reception = this.store.get("reception", device);
    if (kind === "sms" && reception?.sms_enabled === false) return true;
    if (
      kind === "call" &&
      (reception?.incoming_enabled === false ||
        !call ||
        !["ringing", "connecting"].includes(string(call.state)) ||
        call.winner_client_id ||
        call.end_requested)
    )
      return true;
    const ttl =
      kind === "call"
        ? Math.floor((Date.parse(string(call!.expires_at)) - Date.now()) / 1000)
        : 86400;
    if (ttl < 3) return true;
    const wire2 = reception?.version === 2;
    const body: Data = wire2
      ? {
          v: 2,
          kind,
          device_id: device,
          wake_id: wakeId,
          revision:
            call?.state_revision ||
            this.store.sql
              .exec<{ n: number | null }>("SELECT MAX(cursor) n FROM node_feed")
              .one().n ||
            1,
          endpoint_generation: endpoint.generation,
          ...(call ? { call_id: call.call_id } : {}),
        }
      : { kind, device_id: device };
    const status = await this.post(
      string(endpoint.endpoint),
      body,
      ttl,
      kind === "call" ? "high" : "normal",
    );
    // Don't let a delayed completion overwrite a concurrently registered endpoint.
    const current = this.store.get("push", device);
    if (!current || current.generation !== endpoint.generation) return true;
    if (status === 404 || status === 410) {
      this.store.remove("push", device);
      return true;
    }
    const success = status >= 200 && status < 300;
    const counter = kind === "call" ? "call_failures" : "failures";
    const delivered = kind === "call" ? "call_delivered_at" : "delivered_at";
    current[counter] = success ? 0 : Number(current[counter] || 0) + 1;
    if (success) current[delivered] = iso();
    this.store.put("push", device, device, current);
    return success;
  }
}
