import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { envConfig } from "@/lib/harness-slot";
import { hermeticPaths } from "@/lib/paths";
import { logger } from "@/lib/logger";

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
    error: err instanceof Error ? err.message : String(err),
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

export function setRuntimeConfig(partial: Partial<RuntimeConfig>): RuntimeConfig {
  const current = readFromDisk();
  const merged: RuntimeConfig = { ...current };

  if (partial.ollama !== undefined) {
    merged.ollama = partial.ollama === null ? undefined : { ...current.ollama, ...partial.ollama };
  }
  if (partial.mlx !== undefined) {
    merged.mlx = partial.mlx === null ? undefined : { ...current.mlx, ...partial.mlx };
  }
  if (partial.llamaCpp !== undefined) {
    merged.llamaCpp =
      partial.llamaCpp === null ? undefined : { ...current.llamaCpp, ...partial.llamaCpp };
  }
  if (partial.claudeCli !== undefined) {
    merged.claudeCli =
      partial.claudeCli === null ? undefined : { ...current.claudeCli, ...partial.claudeCli };
  }
  if (partial.sandboxRuntime !== undefined) {
    merged.sandboxRuntime = partial.sandboxRuntime;
  }
  if (partial.activeProvider !== undefined) {
    merged.activeProvider = partial.activeProvider || undefined;
  }
  // Settings blocks (lib/settings.ts): REPLACED wholesale, not per-field
  // merged — the /api/settings route sends the complete block with cleared
  // fields as `undefined`, and a per-field merge would make clearing
  // impossible (undefined spreads as "keep the old value").
  if (partial.providers !== undefined) {
    merged.providers = partial.providers === null ? undefined : partial.providers;
  }
  if (partial.sandbox !== undefined) {
    merged.sandbox = partial.sandbox === null ? undefined : partial.sandbox;
  }
  if (partial.retention !== undefined) {
    merged.retention = partial.retention === null ? undefined : partial.retention;
  }
  if (partial.findings !== undefined) {
    merged.findings = partial.findings === null ? undefined : partial.findings;
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
