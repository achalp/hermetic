/**
 * Typed settings resolution (secrets-and-settings spec, 2026-08-06):
 * runtime-config first, environment fallback.
 *
 * Why: `.env.local` is loaded by Next for the WEB harness only — the MCP
 * server (spawned by Claude Desktop) and the CLI see the bare process env,
 * so env-only settings silently diverge between harnesses. runtime-config
 * (`data/runtime-config.json`) is shared by every harness in the checkout,
 * making it the canonical home for PRODUCT settings; env remains the seed /
 * headless override, following the precedent set by `rc.activeProvider`
 * and `rc.sandboxRuntime`.
 *
 * What does NOT belong here: process facts (NODE_ENV, TMPDIR, LOG_LEVEL),
 * the HERMETIC_LOCAL_FILE_ROOTS security boundary (a boundary the Settings
 * UI can widen is a weaker boundary), and secrets (lib/secrets — keychain).
 */
import { getRuntimeConfig } from "@/lib/runtime-config";
import { envConfig } from "@/lib/harness-slot";

// ── Provider endpoints ───────────────────────────────────────────────

export function openaiBaseUrl(): string | undefined {
  return getRuntimeConfig().providers?.openaiBaseUrl ?? envConfig().OPENAI_BASE_URL;
}

export function openaiModel(): string | undefined {
  return getRuntimeConfig().providers?.openaiModel ?? envConfig().OPENAI_MODEL;
}

export function vertexProject(): string | undefined {
  return getRuntimeConfig().providers?.vertexProject ?? envConfig().GOOGLE_VERTEX_PROJECT;
}

export function vertexLocation(): string | undefined {
  return getRuntimeConfig().providers?.vertexLocation ?? envConfig().GOOGLE_VERTEX_LOCATION;
}

export function awsRegion(): string | undefined {
  return getRuntimeConfig().providers?.awsRegion ?? envConfig().AWS_REGION;
}

// AWS_PROFILE deliberately NOT migrated: the Bedrock SDK resolves the profile
// through its own credential chain (env + ~/.aws), so a runtime-config value
// would be silently ignored — a setting that lies is worse than an env var.

// ── Sandbox ──────────────────────────────────────────────────────────

/** Policy fraction of daemon memory a container may use; NaN-guarded. */
export function sandboxMemoryFraction(fallback: number): number {
  const rc = getRuntimeConfig().sandbox?.memoryFraction;
  const raw = typeof rc === "number" ? rc : Number(envConfig().SANDBOX_MEMORY_FRACTION);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : fallback;
}

// ── Retention ────────────────────────────────────────────────────────

function positiveInt(rcValue: unknown, envValue: string | undefined, fallback: number): number {
  const raw = typeof rcValue === "number" ? rcValue : Number(envValue);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function maxHistoryEntries(fallback: number): number {
  return positiveInt(
    getRuntimeConfig().retention?.maxHistoryEntries,
    envConfig().HERMETIC_MAX_HISTORY_ENTRIES,
    fallback
  );
}

export function maxRunRecords(fallback: number): number {
  return positiveInt(
    getRuntimeConfig().retention?.maxRunRecords,
    envConfig().HERMETIC_MAX_RUN_RECORDS,
    fallback
  );
}
