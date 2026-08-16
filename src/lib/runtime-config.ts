import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { envConfig } from "@/lib/harness-slot";
import { CODE_GEN_MODEL, UI_COMPOSE_MODEL, isValidModelId } from "@/lib/constants";
import { hermeticPaths } from "@/lib/paths";
import { logger, errMessage } from "@/lib/logger";

export interface OllamaConfig {
  enabled: boolean;
  baseUrl: string;
  activeModel: string;
  pid?: number;
}

export interface MlxConfig {
  enabled: boolean;
  baseUrl: string;
  activeModel: string;
  pid?: number;
}

export interface LlamaCppConfig {
  enabled: boolean;
  baseUrl: string;
  activeModel: string;
  pid?: number;
  binaryPath?: string;
}

/** Optional overrides for the Claude CLI provider. The binary is normally found
 *  on PATH; `binaryPath` lets a user point at a non-standard install. */
export interface ClaudeCliConfig {
  binaryPath?: string;
}

export interface RuntimeConfig {
  ollama?: OllamaConfig;
  mlx?: MlxConfig;
  llamaCpp?: LlamaCppConfig;
  claudeCli?: ClaudeCliConfig;
  sandboxRuntime?: "docker" | "e2b" | "microsandbox";
  /** User-selected LLM provider override (takes priority over auto-detection) */
  activeProvider?: string;
  /**
   * Product settings migrated from env-only config (lib/settings.ts resolves
   * these first, env second) so every harness — web, MCP, CLI — shares them.
   * NEVER put secrets here; those live in the OS keychain (lib/secrets).
   */
  providers?: {
    openaiBaseUrl?: string;
    openaiModel?: string;
    vertexProject?: string;
    vertexLocation?: string;
    awsRegion?: string;
  };
  sandbox?: {
    microsandboxUrl?: string;
    microsandboxImage?: string;
    /** Fraction (0,1] of daemon memory a sandbox container may use. */
    memoryFraction?: number;
  };
  retention?: {
    maxHistoryEntries?: number;
    maxRunRecords?: number;
  };
  /** Declared-findings rollout (spec §8): off | shadow (collect, ship to no
   *  consumer — the default) | on (composer + MCP receive the manifest). */
  findings?: {
    mode?: "off" | "shadow" | "on";
  };
  /**
   * User-selected models (Settings UI). The SERVER-side source of truth so
   * every harness honors one choice: web requests fall back to it when the
   * client sends none, and the MCP server reads it directly (it has no
   * localStorage). Validated against AVAILABLE_MODELS on read AND write —
   * a stale id from an old config falls back to the defaults.
   */
  /** Composer architecture (narrative-compiler spec): "generative" (the
   *  LLM writes the dashboard; default during burn-in) or "compiled" (the
   *  LLM writes a typed plan; code compiles the dashboard). */
  composer?: { mode?: string };
  models?: {
    codeGen?: string;
    uiCompose?: string;
    /** Claude CLI reasoning-effort override: "auto" (phase-routed default)
     *  or a fixed level applied to every phase. Superseded by per-phase
     *  `efforts` when a phase has an entry there. */
    effort?: string;
    /** Per-phase effort overrides ({code_gen: "high", compose: "medium"});
     *  "auto"/absent defers to the phase policy. Open keys — new phases need
     *  no config migration. */
    efforts?: Record<string, string>;
  };
}

// Resolved per call, not at import — a module-level const froze the pre-boot
// default before the harness could call setPathRoots (the seam in lib/paths.ts).
const configPath = () => hermeticPaths.runtimeConfigFile();
const CACHE_TTL_MS = 5_000;

let cached: RuntimeConfig | null = null;
let cacheTime = 0;

/**
 * Preserve an unparsable config before setRuntimeConfig's read-modify-write
 * can overwrite the only copy (missing ≠ corrupt — the record-store
 * RecordCorruptError distinction). Best-effort: the rename may itself fail
 * (e.g. the read failed on permissions), but the warn always lands.
 */
function backupCorruptConfig(path: string, err: unknown): void {
  const backupPath = `${path}.corrupt-${Date.now()}`;
  let backedUp = true;
  try {
    renameSync(path, backupPath);
  } catch {
    backedUp = false;
  }
  logger.warn("runtime-config.json unreadable — starting from an empty config", {
    path,
    backupPath: backedUp ? backupPath : undefined,
    error: errMessage(err),
  });
}

function readFromDisk(): RuntimeConfig {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    // ENOENT is the normal first-run state; anything else is a real failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") backupCorruptConfig(path, err);
    return {};
  }
  try {
    return JSON.parse(raw) as RuntimeConfig;
  } catch (err) {
    backupCorruptConfig(path, err);
    return {};
  }
}

export function getRuntimeConfig(): RuntimeConfig {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL_MS) {
    return cached;
  }
  cached = readFromDisk();
  cacheTime = now;
  return cached;
}

/** Backend blocks merged per-field (a partial update keeps other fields). */
const DEEP_MERGED_KEYS = new Set(["ollama", "mlx", "llamaCpp", "claudeCli"]);

export function setRuntimeConfig(partial: Partial<RuntimeConfig>): RuntimeConfig {
  const current = readFromDisk();
  const merged: RuntimeConfig = { ...current };

  // EVERY present key persists — fields the merge doesn't special-case flow
  // through the generic path instead of silently dropping. The previous
  // per-field allowlist ate any field it didn't name (composer.mode was
  // validated by the route, merged, written… nowhere: the setting appeared
  // to change, took no effect, and reverted on restart).
  //
  // Two shapes:
  //  - DEEP_MERGED_KEYS (local-backend blocks): per-field merge, so a
  //    partial update keeps the block's other fields; null clears.
  //  - everything else (settings blocks per lib/settings.ts, composer,
  //    scalars): REPLACED wholesale — the /api/settings route sends the
  //    complete block with cleared fields as `undefined`, and a per-field
  //    merge would make clearing impossible.
  const m = merged as Record<string, unknown>;
  const c = current as Record<string, unknown>;
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    if (value === null) {
      m[key] = undefined;
    } else if (DEEP_MERGED_KEYS.has(key)) {
      m[key] = { ...(c[key] as Record<string, unknown> | undefined), ...(value as object) };
    } else if (key === "activeProvider") {
      m[key] = (value as string) || undefined; // "" clears (legacy semantic)
    } else {
      m[key] = value;
    }
  }

  // Atomic write: write to tmp then rename
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmpPath, path);

  // Update cache immediately
  cached = merged;
  cacheTime = Date.now();

  return merged;
}

export function clearRuntimeConfigCache(): void {
  cached = null;
  cacheTime = 0;
}

/**
 * The active model selection: runtime-config (UI choice) first, constants
 * fallback. Every layer that needs "the code-gen model" or "the compose
 * model" without an explicit per-request override resolves through here.
 */
export const EFFORT_CHOICES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;

/** The user's effort override for a phase: per-phase entry first, then the
 *  global override; "auto"/unset defers to phase routing. */
export function getActiveEffort(phase?: string | null): string | null {
  const m = getRuntimeConfig().models;
  const valid = (e: unknown): e is string =>
    typeof e === "string" && e !== "auto" && (EFFORT_CHOICES as readonly string[]).includes(e);
  const perPhase = phase ? m?.efforts?.[phase] : undefined;
  if (valid(perPhase)) return perPhase;
  if (valid(m?.effort)) return m.effort as string;
  return null;
}

export function getComposerMode(): "generative" | "compiled" {
  const m = getRuntimeConfig().composer?.mode;
  return m === "compiled" ? "compiled" : "generative";
}

export function getActiveModels(): { codeGen: string; uiCompose: string } {
  const rc = getRuntimeConfig();
  return {
    codeGen:
      rc.models?.codeGen && isValidModelId(rc.models.codeGen) ? rc.models.codeGen : CODE_GEN_MODEL,
    uiCompose:
      rc.models?.uiCompose && isValidModelId(rc.models.uiCompose)
        ? rc.models.uiCompose
        : UI_COMPOSE_MODEL,
  };
}

/**
 * Get the active sandbox runtime. Checks runtime config (UI selection) first,
 * then SANDBOX_RUNTIME env var, then defaults to "docker".
 */
export function getActiveSandboxRuntime(): "docker" | "e2b" | "microsandbox" {
  const rc = getRuntimeConfig();
  if (rc.sandboxRuntime) return rc.sandboxRuntime;
  const env = envConfig().SANDBOX_RUNTIME;
  if (env === "docker" || env === "e2b" || env === "microsandbox") return env;
  return "docker";
}
