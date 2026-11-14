import { verifyToken, digest, type SigningConfig } from "./crypto";
import { error } from "./http";
/** The callback is the only DO access; invalid signatures never invoke it. */
export async function relayRequest(
  env: SigningConfig,
  authorization: string,
  query: (hash: string) => Promise<Response>,
): Promise<Response> {
  if (
    !authorization.startsWith("Bearer ") ||
    !(await verifyToken(env, authorization.slice(7)))
  )
    return error("INVALID_CREDENTIALS", 401);
  return query(await digest(authorization.slice(7)));
}
