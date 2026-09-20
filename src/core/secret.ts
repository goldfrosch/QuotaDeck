/**
 * Secret handling. Tokens are read into memory to make API calls, but they
 * must never be logged, persisted by us, or sent to the renderer. Everything
 * outside the HTTP layer identifies a token by fingerprint only.
 */

import { createHash } from "node:crypto";

/** sha256(token) truncated to 12 hex chars -- enough to compare, useless to replay. */
export function fingerprint(token: string | null): string | null {
  if (token === null || token.length === 0) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * Decodes a JWT payload without signature verification.
 *
 * Verification would be pointless here: the token is one we already hold on
 * local disk, and we only read the `exp` claim to decide when to refresh.
 * Returns null for anything that isn't a well-formed 3-part JWT.
 */
export function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (token === null) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
