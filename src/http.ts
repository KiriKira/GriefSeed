export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    !("request_id" in body)
  )
    body = { ...body, request_id: crypto.randomUUID() };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}
export function error(code: string, status = 400): Response {
  return json(
    { error: { code, message: code, retryable: status >= 500 } },
    status,
  );
}
export class HttpInputError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export async function readJson(
  request: Request | Response,
  limit = 8192,
): Promise<Record<string, unknown>> {
  try {
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      throw Error("invalid_json");
    const reader = request.body?.getReader();
    if (!reader) throw Error("invalid_json");
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HttpInputError(413, "PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const data = strictJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw Error("invalid_json");
    return data as Record<string, unknown>;
  } catch (failure) {
    if (failure instanceof HttpInputError) throw failure;
    throw new HttpInputError(400, "INVALID_JSON");
  }
}

/** Reject duplicate object keys and unpaired Unicode before JSON is interpreted anywhere else. */
export function strictJson(text: string): unknown {
  let position = 0;
  function space() {
    while (position < text.length && /[\x20\t\r\n]/.test(text[position]))
      position++;
  }
  function quoted(): string {
    const start = position++;
    let escaped = false;
    while (position < text.length) {
      const char = text[position++];
      if (!escaped && char === '"') {
        const value = JSON.parse(text.slice(start, position)) as string;
        if (
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
            value,
          )
        )
          throw Error("invalid_unicode");
        return value;
      }
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    throw Error("invalid_json");
  }
  function value(depth: number): void {
    if (depth > 64) throw Error("json_depth");
    space();
    const char = text[position];
    if (char === '"') {
      quoted();
      return;
    }
    if (char === "{") {
      position++;
      space();
      const keys = new Set<string>();
      if (text[position] === "}") {
        position++;
        return;
      }
      while (true) {
        space();
        if (text[position] !== '"') throw Error("invalid_json");
        const key = quoted();
        if (keys.has(key)) throw Error("duplicate_key");
        keys.add(key);
        space();
        if (text[position++] !== ":") throw Error("invalid_json");
        value(depth + 1);
        space();
        const next = text[position++];
        if (next === "}") return;
        if (next !== ",") throw Error("invalid_json");
      }
    }
    if (char === "[") {
      position++;
      space();
      if (text[position] === "]") {
        position++;
        return;
      }
      while (true) {
        value(depth + 1);
        space();
        const next = text[position++];
        if (next === "]") return;
        if (next !== ",") throw Error("invalid_json");
      }
    }
    const match = text
      .slice(position)
      .match(
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/,
      );
    if (!match) throw Error("invalid_json");
    position += match[0].length;
  }
  value(0);
  space();
  if (position !== text.length) throw Error("invalid_json");
  return JSON.parse(text);
}
