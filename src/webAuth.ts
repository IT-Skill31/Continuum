import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed client tokens for the web API.
 *
 * The browser cannot be trusted to say which client it is: an open "type your
 * email" form would let anyone read anyone else's memories. Instead the site
 * the client is already logged into mints a short-lived token naming them, and
 * links to the chat with it. The chat server only has to check the signature.
 *
 *   token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))
 *
 * Deliberately not a JWT library: one algorithm, no header to negotiate, so
 * there is no "alg: none" class of mistake to make.
 */

export interface ClientTokenPayload {
  /** The client's external id (email, CRM id...). */
  sub: string;
  /** Optional display name, used only when the client row is first created. */
  name?: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function mintClientToken(
  payload: ClientTokenPayload,
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** Returns the payload, or null for anything malformed, forged or expired. */
export function verifyClientToken(
  token: string,
  secret: string,
  now = Date.now(),
): ClientTokenPayload | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) return null;

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as ClientTokenPayload).sub !== "string" ||
    typeof (payload as ClientTokenPayload).exp !== "number"
  ) {
    return null;
  }

  const parsed = payload as ClientTokenPayload;
  if (!parsed.sub.trim() || parsed.exp * 1000 <= now) return null;
  return parsed;
}
