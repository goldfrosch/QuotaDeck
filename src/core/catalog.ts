/**
 * The credential store catalog: which files quotadeck reads, in which format,
 * and which of their credentials it may ever write.
 *
 * The built-in entries cover the host tools quotadeck knows about. Anything
 * machine-specific -- a relocated Codex home, a second opencode profile, a
 * host tool that did not exist when this was written -- goes in the user's
 * `stores.json` instead of a code change:
 *
 *   {
 *     "stores": [
 *       { "id": "codex", "path": "D:/tools/codex/auth.json" },
 *       { "id": "opencode-auth-localappdata", "enabled": false },
 *       {
 *         "id": "work-omo",
 *         "format": "opencode-auth",
 *         "path": "~/work/.omo/agent/auth.json",
 *         "providerAliases": { "chatgpt-subscription": "openai" }
 *       }
 *     ]
 *   }
 *
 * The file is re-read on every poll, so an edit takes effect without restart.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HOME, PATHS, storesConfigPath } from "./paths.ts";
import { isRecord, parseJson } from "./json.ts";
import { STORE_FORMATS } from "./types.ts";
import type { Ownership, StoreConfigStatus, StoreFormat, StoreId } from "./types.ts";

export interface StoreSpec {
  readonly id: StoreId;
  readonly format: StoreFormat;
  readonly path: string;
  readonly source: "builtin" | "user";
  /** Host-tool provider name -> the name quotadeck uses (anthropic, openai, ...). */
  readonly providerAliases: Readonly<Record<string, string>>;
  /** Providers another process rotates here, or "all" for a read-only store. */
  readonly observed: "all" | readonly string[];
  /** Whether custody may copy this store's tokens into other stores. */
  readonly donor: boolean;
}

export interface Catalog {
  readonly specs: readonly StoreSpec[];
  readonly config: StoreConfigStatus;
}

/**
 * Ownership is per (store, provider), not per store.
 *
 * An earlier version keyed this by store alone and that was wrong in a way
 * that caused real damage: `opencode-claude-auth` owns only the **anthropic**
 * entry inside opencode's auth.json, but treating the whole file as foreign
 * meant quotadeck could strand the openai entry in it -- it copied that
 * entry's refresh token into Codex, Codex rotated it, and opencode was left
 * holding a dead grant it was never allowed to repair.
 */
export function ownershipOf(spec: StoreSpec, provider: string): Ownership {
  return spec.observed === "all" || spec.observed.includes(provider) ? "observed" : "owned";
}

const BUILTIN: readonly StoreSpec[] = [
  // The `claude` CLI and the opencode-claude-auth plugin already implement
  // locking, proactive refresh, rotation adoption and 401 recovery for the
  // anthropic entries, so those are observed.
  {
    id: "claude-code",
    format: "claude-code",
    path: PATHS.claudeCredentials,
    source: "builtin",
    providerAliases: {},
    observed: ["anthropic"],
    donor: true,
  },
  {
    id: "opencode-auth-xdg",
    format: "opencode-auth",
    path: PATHS.opencodeAuthXdg,
    source: "builtin",
    providerAliases: {},
    observed: ["anthropic"],
    donor: true,
  },
  {
    id: "opencode-auth-localappdata",
    format: "opencode-auth",
    path: PATHS.opencodeAuthLocalAppData,
    source: "builtin",
    providerAliases: {},
    observed: ["anthropic"],
    donor: true,
  },
  {
    id: "opencode-account",
    format: "opencode-account",
    path: PATHS.opencodeAccount,
    source: "builtin",
    providerAliases: {},
    observed: [],
    donor: true,
  },
  {
    id: "codex",
    format: "codex",
    path: PATHS.codexAuth,
    source: "builtin",
    providerAliases: {},
    observed: [],
    donor: true,
  },
  // omo native refreshes its own grants, so every entry is read-only. It is
  // not a donor either: adoption mirrors the refresh token, and the moment
  // Codex or opencode rotated that copy, omo would be logged out. Its tokens
  // still anchor the quota bands -- reading is free of that risk.
  {
    id: "omo-agent",
    format: "opencode-auth",
    path: PATHS.omoAgentAuth,
    source: "builtin",
    providerAliases: { "chatgpt-subscription": "openai" },
    observed: "all",
    donor: false,
  },
];

/* --------------------------------------------------------- stores.json */

/** `~`, `%VAR%` and `${VAR}` expansion; relative paths resolve against the config file. */
function expandPath(raw: string, baseDir: string): string {
  const expanded = raw
    .replace(/^~(?=$|[\\/])/, HOME)
    .replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
    .replace(/\$\{([^}]+)\}/g, (whole, name: string) => process.env[name] ?? whole);
  return resolve(baseDir, expanded);
}

function isStoreFormat(value: unknown): value is StoreFormat {
  return typeof value === "string" && (STORE_FORMATS as readonly string[]).includes(value);
}

function readAliases(value: unknown): Record<string, string> | string {
  if (value === undefined) return {};
  if (!isRecord(value)) return `"providerAliases" must be an object of strings`;
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(value)) {
    if (typeof to !== "string" || to.length === 0) return `"providerAliases.${from}" must be a non-empty string`;
    out[from] = to;
  }
  return out;
}

/** Folds one stores.json entry into `specs`. Returns an error message, or null. */
function applyEntry(entry: unknown, specs: Map<StoreId, StoreSpec>, baseDir: string): string | null {
  if (!isRecord(entry)) return "entry must be an object";
  const id = entry["id"];
  if (typeof id !== "string" || id.length === 0) return `"id" is required`;
  const existing = specs.get(id) ?? BUILTIN.find((s) => s.id === id);

  const enabled = entry["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") return `"enabled" must be true or false`;
  if (enabled === false) {
    if (existing === undefined) return `unknown store "${id}" cannot be disabled`;
    specs.delete(id);
    return null;
  }

  const rawPath = entry["path"];
  if (rawPath !== undefined && (typeof rawPath !== "string" || rawPath.length === 0)) {
    return `"path" must be a non-empty string`;
  }
  const format = entry["format"];
  if (format !== undefined && !isStoreFormat(format)) {
    return `"format" must be one of ${STORE_FORMATS.join(", ")}`;
  }
  const aliases = readAliases(entry["providerAliases"]);
  if (typeof aliases === "string") return aliases;
  const ownership = entry["ownership"];
  if (ownership !== undefined && ownership !== "observed" && ownership !== "owned") {
    return `"ownership" must be "observed" or "owned"`;
  }
  const donor = entry["donor"];
  if (donor !== undefined && typeof donor !== "boolean") return `"donor" must be true or false`;

  if (existing !== undefined) {
    if (format !== undefined && format !== existing.format) {
      return `"format" of store "${id}" is ${existing.format} and cannot change`;
    }
    specs.set(id, {
      ...existing,
      source: "user",
      path: rawPath === undefined ? existing.path : expandPath(rawPath, baseDir),
      providerAliases: { ...existing.providerAliases, ...aliases },
      // "owned" never lifts a built-in protection; only tightening is allowed.
      observed: ownership === "observed" ? "all" : existing.observed,
      donor: donor ?? existing.donor,
    });
    return null;
  }

  if (format === undefined) return `new store "${id}" needs a "format"`;
  if (rawPath === undefined) return `new store "${id}" needs a "path"`;
  specs.set(id, {
    id,
    format,
    path: expandPath(rawPath, baseDir),
    source: "user",
    providerAliases: aliases,
    // quotadeck writing into a file some other tool owns is how every past
    // incident happened, so a store the user adds is read-only unless they
    // explicitly say otherwise.
    observed: ownership === "owned" ? [] : "all",
    donor: donor ?? false,
  });
  return null;
}

export function loadCatalog(): Catalog {
  const path = storesConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { specs: BUILTIN, config: { path, state: "absent", errors: [] } };
    return { specs: BUILTIN, config: { path, state: "invalid", errors: [`cannot read: ${String(code ?? err)}`] } };
  }

  const parsed = parseJson(text);
  if (!parsed.ok) {
    return { specs: BUILTIN, config: { path, state: "invalid", errors: [`invalid JSON: ${parsed.error}`] } };
  }
  const entries = isRecord(parsed.value) ? parsed.value["stores"] : undefined;
  if (!Array.isArray(entries)) {
    return { specs: BUILTIN, config: { path, state: "invalid", errors: [`expected { "stores": [ ... ] }`] } };
  }

  const specs = new Map<StoreId, StoreSpec>(BUILTIN.map((s) => [s.id, s]));
  const errors: string[] = [];
  entries.forEach((entry: unknown, index) => {
    const error = applyEntry(entry, specs, dirname(path));
    if (error !== null) errors.push(`stores[${index}]: ${error}`);
  });
  return { specs: [...specs.values()], config: { path, state: "loaded", errors } };
}
