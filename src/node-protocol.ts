import * as schemas from "./generated/validators.js";
export type Data = Record<string, unknown>;
export class NodeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function requireThat(
  condition: unknown,
  code: string,
  status = 400,
): asserts condition {
  if (!condition) throw new NodeError(status, code);
}
export function validate(
  name: keyof typeof schemas,
  body: unknown,
): asserts body is Data {
  requireThat(schemas[name](body), "INVALID_" + name.toUpperCase());
  safeNumbers(body);
}
function safeNumbers(value: unknown): void {
  if (typeof value === "number")
    requireThat(Number.isSafeInteger(value), "INVALID_NUMBER");
  else if (Array.isArray(value)) value.forEach(safeNumbers);
  else if (value && typeof value === "object")
    Object.values(value).forEach(safeNumbers);
}
export function string(value: unknown): string {
  requireThat(typeof value === "string", "INVALID_FIELD");
  return value;
}
export function integer(value: unknown): number {
  requireThat(Number.isSafeInteger(value), "INVALID_FIELD");
  return value as number;
}
export function record(value: unknown): Data {
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    "INVALID_FIELD",
  );
  return value as Data;
}
export function array(value: unknown): Data[] {
  requireThat(Array.isArray(value), "INVALID_FIELD");
  return value.map(record);
}
export function uuid(value: unknown): string {
  const text = string(value).toLowerCase();
  requireThat(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text),
    "INVALID_ID",
  );
  return text;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function hash(value: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export const iso = (time = Date.now()) =>
  new Date(time)
    .toISOString()
    .replace(/(\.\d*?)0+Z$/, "$1Z")
    .replace(/\.Z$/, "Z");
export function cursor(sequence: number): string {
  return btoa(String(sequence)).replace(/=+$/, "");
}
export function parseCursor(value: string | null): number {
  if (!value) return 0;
  try {
    const text = atob(value);
    requireThat(/^(0|[1-9][0-9]*)$/.test(text), "INVALID_CURSOR");
    const n = Number(text);
    requireThat(
      Number.isSafeInteger(n) && cursor(n) === value,
      "INVALID_CURSOR",
    );
    return n;
  } catch {
    throw new NodeError(400, "INVALID_CURSOR");
  }
}

const identityFields = new Set([
  "owner_id",
  "device_id",
  "gateway_id",
  "client_id",
  "sim_id",
  "existing_sim_id",
  "proposed_sim_id",
  "call_id",
  "leg_id",
  "attempt_id",
  "operation_id",
  "message_id",
  "command_id",
  "event_id",
  "install_id",
  "candidate_client_id",
]);
export function normaliseIDs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseIDs);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        identityFields.has(key) &&
        typeof v === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          v,
        )
          ? v.toLowerCase()
          : normaliseIDs(v),
      ]),
    );
  return value;
}
