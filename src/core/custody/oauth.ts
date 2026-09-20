/**
 * OAuth refresh for the stores quotadeck owns.
 *
 * This is the FALLBACK path. Rotating a refresh token is destructive -- both
 * providers issue single-use refresh tokens -- so `plan.ts` only routes here
 * when no live token for that provider exists anywhere on disk to adopt.
 *
 * User-Agent warning: the Anthropic *token* endpoint rate-limits agents whose
 * UA starts with `claude`, which is the exact opposite of the usage endpoint's
 * requirement. REFRESH_USER_AGENT must therefore never be reused for quota
 * calls, and vice versa.
 */

import { asFiniteNumber, asString, isRecord, parseJson } from "../json.ts";
import { CONFIG } from "../config.ts";

/** Fallback lifetime when the endpoint omits `expires_in`. */
const DEFAULT_TTL_SECONDS = 28_800;

export interface RefreshedTokens {
  readonly accessToken: string;
  /** Rotated by both providers -- the old value is dead once this returns. */
  readonly refreshToken: string;
  readonly expiresAt: number;
  /** OpenAI returns this; Codex's auth.json stores it. Null for Anthropic. */
  readonly idToken: string | null;
}

export type RefreshFailureReason =
  | "invalid-grant"
  | "rate-limited"
  | "http-error"
  | "network-error"
  | "parse-error";

export type RefreshResult =
  | { readonly ok: true; readonly tokens: RefreshedTokens }
  | { readonly ok: false; readonly reason: RefreshFailureReason; readonly detail: string };

function classify(status: number, body: string): { reason: RefreshFailureReason; detail: string } {
  const parsed = parseJson(body);
  let detail = body.slice(0, 200);
  if (parsed.ok && isRecord(parsed.value)) {
    const error = asString(parsed.value["error"]);
    const description = asString(parsed.value["error_description"]);
    detail = [error, description].filter((v): v is string => v !== null).join(": ") || detail;
    if (error === "invalid_grant") return { reason: "invalid-grant", detail };
  }
  if (status === 429) return { reason: "rate-limited", detail };
  return { reason: "http-error", detail: `HTTP ${status} ${detail}` };
}

function readTokens(body: string, previousRefresh: string, now: number): RefreshResult {
  const parsed = parseJson(body);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return { ok: false, reason: "parse-error", detail: "token response was not JSON" };
  }
  const accessToken = asString(parsed.value["access_token"]);
  if (accessToken === null) {
    return { ok: false, reason: "parse-error", detail: "token response had no access_token" };
  }
  const expiresIn = asFiniteNumber(parsed.value["expires_in"]) ?? DEFAULT_TTL_SECONDS;
  return {
    ok: true,
    tokens: {
      accessToken,
      // Absent means "keep using the old one" -- true for some providers.
      refreshToken: asString(parsed.value["refresh_token"]) ?? previousRefresh,
      expiresAt: now + Math.trunc(expiresIn * 1000),
      idToken: asString(parsed.value["id_token"]),
    },
  };
}

async function post(url: string, init: RequestInit, previousRefresh: string): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    return { ok: false, reason: "network-error", detail: err instanceof Error ? err.message : String(err) };
  }
  const body = await response.text();
  if (!response.ok) {
    const { reason, detail } = classify(response.status, body);
    return { ok: false, reason, detail };
  }
  return readTokens(body, previousRefresh, Date.now());
}

/** `POST https://claude.ai/v1/oauth/token` with a JSON body. */
export function refreshAnthropic(refreshToken: string): Promise<RefreshResult> {
  return post(
    CONFIG.anthropic.tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": CONFIG.refreshUserAgent,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CONFIG.anthropic.clientId,
      }),
    },
    refreshToken,
  );
}

/** `POST https://auth.openai.com/oauth/token`, form-encoded as Codex does. */
export function refreshOpenAI(refreshToken: string): Promise<RefreshResult> {
  return post(
    CONFIG.openai.tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": CONFIG.refreshUserAgent,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CONFIG.openai.clientId,
      }).toString(),
    },
    refreshToken,
  );
}

export function refreshFor(provider: string, refreshToken: string): Promise<RefreshResult> | null {
  if (provider === "anthropic") return refreshAnthropic(refreshToken);
  if (provider === "openai") return refreshOpenAI(refreshToken);
  return null;
}
