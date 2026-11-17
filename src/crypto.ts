export interface SigningConfig {
  DEPLOYMENT_ID: string;
  TOKEN_KEYS: string;
  TOKEN_KID: string;
}
const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function decode(value: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("invalid_encoding");
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  if (bytes.length !== length || base64url(bytes) !== value)
    throw Error("invalid_encoding");
  return bytes;
}
export function randomId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function digest(value: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
export async function mac(key: Uint8Array, value: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", imported, encoder.encode(value)),
    ),
  );
}
async function verify(
  key: Uint8Array,
  value: string,
  signature: string,
): Promise<boolean> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    imported,
    decode(signature, 32),
    encoder.encode(value),
  );
}
function keys(env: SigningConfig): Record<string, string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(env.DEPLOYMENT_ID || ""))
    throw Error("invalid_deployment");
  const data = JSON.parse(env.TOKEN_KEYS);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Object.hasOwn(data, env.TOKEN_KID)
  )
    throw Error("invalid_keys");
  return data;
}
type Kind = "source" | "nodeAccess";
function input(env: SigningConfig, prefix: string, kind: Kind): string {
  return `${kind === "source" ? "griefseed-relay" : "griefseed-node-access"}\n${env.DEPLOYMENT_ID}\n${prefix}`;
}
export async function issueToken(
  env: SigningConfig,
  id = randomId(),
  kind: Kind = "source",
): Promise<string> {
  decode(id, 32);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(env.TOKEN_KID)) throw Error("invalid_kid");
  const key = decode(keys(env)[env.TOKEN_KID], 32);
  const prefix = `${kind === "source" ? "v1" : "a1"}.${env.TOKEN_KID}.${id}`;
  return `${prefix}.${await mac(key, input(env, prefix, kind))}`;
}
export async function verifyToken(
  env: SigningConfig,
  token: string,
  kind: Kind = "source",
): Promise<boolean> {
  try {
    if (token.length > 200) return false;
    const [version, kid, id, signature, ...extra] = token.split(".");
    if (
      version !== (kind === "source" ? "v1" : "a1") ||
      extra.length ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(kid)
    )
      return false;
    decode(id, 32);
    decode(signature, 32);
    const ring = keys(env);
    if (!Object.hasOwn(ring, kid)) return false;
    return verify(
      decode(ring[kid], 32),
      input(env, `${version}.${kid}.${id}`, kind),
      signature,
    );
  } catch {
    return false;
  }
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const left = new TextEncoder().encode(await digest(a));
  const right = new TextEncoder().encode(await digest(b));
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}
export async function adminSession(
  password: string,
  deployment: string,
): Promise<string> {
  const body = `${Math.floor(Date.now() / 1000) + 900}.${randomId()}`;
  return `${body}.${await mac(encoder.encode(password), `griefseed-admin\n${deployment}\n${body}`)}`;
}
export async function verifyAdmin(
  password: string,
  deployment: string,
  session: string,
): Promise<boolean> {
  try {
    const [expiry, nonce, signature, ...extra] = session.split(".");
    if (
      extra.length ||
      !/^\d{10}$/.test(expiry) ||
      Number(expiry) <= Date.now() / 1000 ||
      Number(expiry) > Date.now() / 1000 + 901
    )
      return false;
    decode(nonce, 32);
    return verify(
      encoder.encode(password),
      `griefseed-admin\n${deployment}\n${expiry}.${nonce}`,
      signature,
    );
  } catch {
    return false;
  }
}

export async function seal(
  env: SigningConfig,
  value: string,
  scope: string,
): Promise<string> {
  const kid = env.TOKEN_KID;
  const raw = decode(keys(env)[kid], 32);
  const derived = decode(
    await mac(raw, `griefseed-private-cache\n${env.DEPLOYMENT_ID}`),
    32,
  );
  const key = await crypto.subtle.importKey("raw", derived, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(scope) },
    key,
    encoder.encode(value),
  );
  return `${kid}.${base64url(iv)}.${base64url(new Uint8Array(cipher))}`;
}
export async function open(
  env: SigningConfig,
  value: string,
  scope: string,
): Promise<string> {
  const [kid, iv, cipher, ...extra] = value.split(".");
  if (extra.length) throw Error("invalid_cache");
  const ring = keys(env);
  if (!Object.hasOwn(ring, kid)) throw Error("retired_key");
  const derived = decode(
    await mac(
      decode(ring[kid], 32),
      `griefseed-private-cache\n${env.DEPLOYMENT_ID}`,
    ),
    32,
  );
  const key = await crypto.subtle.importKey("raw", derived, "AES-GCM", false, [
    "decrypt",
  ]);
  if (!/^[A-Za-z0-9_-]+$/.test(cipher)) throw Error("invalid_cache");
  const bytes = Uint8Array.from(
    atob(cipher.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(iv, 12),
        additionalData: encoder.encode(scope),
      },
      key,
      bytes,
    ),
  );
}
