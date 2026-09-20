/**
 * Readers for every credential store on the machine.
 *
 * Each host tool invented its own on-disk shape, so there is one parser per
 * store. All of them are total: an unrecognised shape yields zero records and
 * a populated `error`, never an exception.
 *
 * `loadStore` returns secrets (needed to call quota APIs and to refresh the
 * stores we own). `snapshot` is the redacted projection -- that is the only
 * thing allowed to cross a process or log boundary.
 */

import { readFileSync } from "node:fs";
import { ownershipFor, STORE_PATHS, ALL_STORE_IDS } from "./paths.ts";
import { asEpochMs, asString, child, isRecord, parseJson } from "./json.ts";
import { decodeJwtPayload, fingerprint } from "./secret.ts";
import type { CredentialKind, CredentialRecord, StoreId, StoreSnapshot } from "./types.ts";

export interface LoadedCredential {
  readonly record: CredentialRecord;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
}

export interface LoadedStore {
  readonly storeId: StoreId;
  readonly path: string;
  readonly exists: boolean;
  readonly error: string | null;
  readonly credentials: readonly LoadedCredential[];
  /** Raw parsed JSON, kept so a writer can round-trip unknown fields. */
  readonly raw: unknown;
}

interface Draft {
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly label: string | null;
  readonly expiresAt: number | null;
  readonly refreshExpiresAt: number | null;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
}

function build(storeId: StoreId, draft: Draft): LoadedCredential {
  return {
    record: {
      storeId,
      ownership: ownershipFor(storeId, draft.provider),
      provider: draft.provider,
      kind: draft.kind,
      label: draft.label,
      expiresAt: draft.expiresAt,
      refreshExpiresAt: draft.refreshExpiresAt,
      accessFingerprint: fingerprint(draft.accessToken),
      refreshFingerprint: fingerprint(draft.refreshToken),
    },
    accessToken: draft.accessToken,
    refreshToken: draft.refreshToken,
  };
}

/* --------------------------------------------------------------- parsers */

/** `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, subscriptionType } }` */
function parseClaudeCode(root: unknown): Draft[] {
  const oauth = child(root, "claudeAiOauth");
  if (oauth === null) return [];
  const tier = asString(oauth["rateLimitTier"]);
  const plan = asString(oauth["subscriptionType"]);
  return [
    {
      provider: "anthropic",
      kind: "oauth",
      label: [plan, tier].filter((v): v is string => v !== null).join(" / ") || null,
      expiresAt: asEpochMs(oauth["expiresAt"]),
      refreshExpiresAt: asEpochMs(oauth["refreshTokenExpiresAt"]),
      accessToken: asString(oauth["accessToken"]),
      refreshToken: asString(oauth["refreshToken"]),
    },
  ];
}

/** `{ [provider]: { type: "oauth", access, refresh, expires } | { type: "api", key } }` */
function parseOpencodeAuth(root: unknown): Draft[] {
  if (!isRecord(root)) return [];
  const out: Draft[] = [];
  for (const [provider, value] of Object.entries(root)) {
    if (!isRecord(value)) continue;
    const type = asString(value["type"]);
    if (type === "oauth") {
      out.push({
        provider,
        kind: "oauth",
        label: asString(value["accountId"]),
        expiresAt: asEpochMs(value["expires"]),
        refreshExpiresAt: null,
        accessToken: asString(value["access"]),
        refreshToken: asString(value["refresh"]),
      });
    } else {
      out.push({
        provider,
        kind: "api",
        label: type,
        expiresAt: null,
        refreshExpiresAt: null,
        accessToken: asString(value["key"]) ?? asString(value["token"]),
        refreshToken: null,
      });
    }
  }
  return out;
}

/** `{ version, accounts: { [id]: { serviceID, credential: {...} } }, active: { [serviceID]: id } }` */
function parseOpencodeAccount(root: unknown): Draft[] {
  const accounts = child(root, "accounts");
  if (accounts === null) return [];
  const active = child(root, "active") ?? {};
  const out: Draft[] = [];
  for (const [accountId, value] of Object.entries(accounts)) {
    if (!isRecord(value)) continue;
    const serviceId = asString(value["serviceID"]) ?? "unknown";
    const credential = child(value, "credential");
    if (credential === null) continue;
    const isActive = asString(active[serviceId]) === accountId;
    const suffix = accountId.slice(-6);
    const label = `${isActive ? "active" : "idle"} ${suffix}`;
    const type = asString(credential["type"]);
    if (type === "oauth") {
      out.push({
        provider: serviceId,
        kind: "oauth",
        label,
        expiresAt: asEpochMs(credential["expires"]),
        refreshExpiresAt: null,
        accessToken: asString(credential["access"]),
        refreshToken: asString(credential["refresh"]),
      });
    } else {
      out.push({
        provider: serviceId,
        kind: "api",
        label,
        expiresAt: null,
        refreshExpiresAt: null,
        accessToken: asString(credential["key"]),
        refreshToken: null,
      });
    }
  }
  return out;
}

/** `{ auth_mode, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }` */
function parseCodex(root: unknown): Draft[] {
  if (!isRecord(root)) return [];
  const out: Draft[] = [];
  const apiKey = asString(root["OPENAI_API_KEY"]);
  if (apiKey !== null) {
    out.push({
      provider: "openai",
      kind: "api",
      label: "OPENAI_API_KEY",
      expiresAt: null,
      refreshExpiresAt: null,
      accessToken: apiKey,
      refreshToken: null,
    });
  }
  const tokens = child(root, "tokens");
  if (tokens !== null) {
    const access = asString(tokens["access_token"]);
    // Codex stores no explicit expiry; the access token is a JWT carrying `exp`.
    const payload = decodeJwtPayload(access);
    const accountId = asString(tokens["account_id"]);
    out.push({
      provider: "openai",
      kind: "oauth",
      label: [asString(root["auth_mode"]), accountId?.slice(-6) ?? null]
        .filter((v): v is string => v !== null)
        .join(" ") || null,
      expiresAt: payload === null ? null : asEpochMs(payload["exp"]),
      refreshExpiresAt: null,
      accessToken: access,
      refreshToken: asString(tokens["refresh_token"]),
    });
  }
  return out;
}

const PARSERS: Readonly<Record<StoreId, (root: unknown) => Draft[]>> = {
  "claude-code": parseClaudeCode,
  "opencode-auth-xdg": parseOpencodeAuth,
  "opencode-auth-localappdata": parseOpencodeAuth,
  "opencode-account": parseOpencodeAccount,
  codex: parseCodex,
};

/* ------------------------------------------------------------------ load */

export function loadStore(storeId: StoreId): LoadedStore {
  const path = STORE_PATHS[storeId];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      storeId,
      path,
      exists: code !== "ENOENT",
      error: code === "ENOENT" ? null : String(code ?? err),
      credentials: [],
      raw: null,
    };
  }

  const parsed = parseJson(text);
  if (!parsed.ok) {
    return { storeId, path, exists: true, error: `invalid JSON: ${parsed.error}`, credentials: [], raw: null };
  }

  const drafts = PARSERS[storeId](parsed.value);
  return {
    storeId,
    path,
    exists: true,
    error: drafts.length === 0 ? "no credentials recognised" : null,
    credentials: drafts.map((d) => build(storeId, d)),
    raw: parsed.value,
  };
}

export function loadAllStores(): readonly LoadedStore[] {
  return ALL_STORE_IDS.map(loadStore);
}

/** Redacted projection -- the only shape allowed to leave the core. */
export function snapshot(store: LoadedStore): StoreSnapshot {
  // A store counts as observed only when every credential in it is foreign.
  const observed =
    store.credentials.length > 0 && store.credentials.every((c) => c.record.ownership === "observed");
  return {
    storeId: store.storeId,
    path: store.path,
    ownership: observed ? "observed" : "owned",
    exists: store.exists,
    error: store.error,
    records: store.credentials.map((c) => c.record),
  };
}

/** First credential matching a provider, preferring OAuth over API keys. */
export function pickCredential(store: LoadedStore, provider: string): LoadedCredential | null {
  const matches = store.credentials.filter((c) => c.record.provider === provider);
  return matches.find((c) => c.record.kind === "oauth") ?? matches[0] ?? null;
}
