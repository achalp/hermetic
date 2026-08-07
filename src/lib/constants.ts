import { envConfig } from "@/lib/harness-slot";
import timeouts from "../../config/timeouts.json";
export const ALLOWED_LOCAL_EXTENSIONS = [".parquet", ".csv", ".xlsx", ".geojson", ".json"] as const;
export const LOCAL_MOUNT_PATH = "/data/local"; // mount point inside sandbox container

// Max rows the materialization pulls. Raised well past the pandas-era 50K
// because large pulls now go through Parquet + DuckDB (materializeCsvToParquet),
// so most filtered slices load COMPLETE instead of being sampled.
export const WAREHOUSE_MAX_ROWS = 1_000_000;
// Target row count for sizing the metadata SCAN WINDOW — the span of the recent
// window handed to SQL-gen as a hard bound. This is a SCAN budget, NOT the output
// cap (WAREHOUSE_MAX_ROWS): server-side aggregations return a tiny result but must
// SCAN a real time range to be meaningful ("by day of week", "daily spikes"). On a
// firehose table, sizing the window to the 1M output cap yields a useless ~2-hour
// sliver; sizing it to a scan budget gives weeks/months of coverage while staying
// well under the engine's read-row limit (e.g. ClickHouse's ~20B). Row-level pulls
// stay bounded by their LIMIT (no ORDER BY → the engine stops early). Tunable: lower
// it if a warehouse has a tighter read limit or is slow under load.
export const WAREHOUSE_SCAN_ROW_BUDGET = 100_000_000;
// A base table at/above this row count is "large" for the unbounded-join guard:
// a CROSS / self / non-equi join over it is O(n²) and won't scale, so the guard
// forces a bucketed rewrite. Below it, an all-pairs join is small enough to allow.
// Tunable from real logs.
export const WAREHOUSE_LARGE_JOIN_ROWS = 5_000_000;
// At/above this row count, materialize to Parquet and analyze via DuckDB
// (bind-mounted) instead of parsing the CSV in Node + pandas. Below it the
// proven CSV path is unchanged.
export const PARQUET_MATERIALIZE_THRESHOLD = 100_000;
export const MAX_CSV_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_CSV_SIZE_LABEL = "100MB";
export const SANDBOX_TIMEOUT_MS = 30_000; // 30 seconds
// Large local Parquet and remote cloud datasets (e.g. Overture buildings, 2.5B
// rows read over S3) legitimately need minutes to scan — not a bug, just big.
// Give those executions a generous budget rather than sampling the data.
// Sourced from config/timeouts.json so scripts/server-timeouts.mjs (the HTTP
// requestTimeout preload) derives from the SAME number — previously two
// unlinked literals where raising this one silently broke long streams.
export const LARGE_DATA_TIMEOUT_MS = timeouts.largeDataTimeoutMs;
// Hard cap on a single warehouse query's execution. Warehouses default to
// enormous limits (BigQuery kills a job only at 6 HOURS) — so a runaway
// query (e.g. an O(n²) spatial self-join whose grid cells explode in dense
// urban areas) ties up the user's request and burns warehouse slots for
// hours before failing. Cancel it at our own budget instead; the engine
// error then flows into the normal repair/fail path in minutes, not hours.
export const WAREHOUSE_QUERY_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
// SLIDING idle TTL for an uploaded/warehouse-result CSV: time since it was last
// READ, not since upload. Every access slides it forward, and an in-flight run
// pins its own CSV regardless of age (see csv/storage.ts isExpired), so this only
// governs how long a truly-idle dataset lingers between questions. Generous so a
// user returning to follow up isn't told to re-upload.
// Idle TTL for WAREHOUSE connections (credentialed sockets — see
// lib/warehouse/storage.ts). CSV/excel/remote entries no longer expire
// (retention policy 2026-08-05, lib/csv/storage.ts).
export const CSV_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours idle
export const DOCKER_SANDBOX_IMAGE = "hermetic-sandbox";
// Fraction of the Docker/colima DAEMON's total memory that a single sandbox
// container may use (`docker run --memory`). The remainder is headroom for the
// daemon/VM's own OS and reclaimable page cache. This is a RATIO, not a byte
// count — it is derived against whatever `docker info` reports on the host
// (the colima/Docker-Desktop VM allocation on macOS, host RAM on native
// Linux), so it scales to any machine with no hardcoded limit. Override with
// SANDBOX_MEMORY_FRACTION (0 < f <= 1) for unusually memory-tight or -rich hosts.
export const DEFAULT_SANDBOX_MEMORY_FRACTION = 0.8;
export const MAX_SAMPLE_ROWS = 5;
export const MAX_PREVIEW_ROWS = 10;
export const MAX_COMPONENT_COUNT = 20;
export const MAX_NESTING_DEPTH = 3;
export const CODE_GEN_MODEL = "claude-sonnet-4-6" as const;
export const UI_COMPOSE_MODEL = "claude-sonnet-4-6" as const;
// Pre-execution code review (the "lint" critic). A stronger model reviews the
// generated code for OOM / memory-cap / prefer-engine violations BEFORE the
// sandbox runs it, and feeds severe findings back for a redo — cheaper than a
// 15-min remote scan that OOMs. Opus is the critic even when codegen is Sonnet.
export const CODE_REVIEW_MODEL = "claude-opus-4-8" as const;
// Only redo once on severe findings — a second critic pass rarely changes the
// verdict and just delays execution.
export const MAX_REVIEW_REDOS = 1;
export const LOCAL_CTX_SIZE = 32_768; // context window for local models (Ollama, llama.cpp, MLX prompt cache)
export const LLM_MAX_OUTPUT_TOKENS = 16_384; // max output tokens — local models default to ~256 without this

// ── Investigate agent budgets ────────────────────────────────────────
// Bounds on the agentic re-planning loop. The orchestrator calls the
// re-planner between waves; these caps prevent runaway cost / latency
// regardless of what the model emits.
export const INVESTIGATE_MAX_HOPS = 2; // max re-plan rounds after the initial plan (so 3 total wave-planning calls)
export const INVESTIGATE_MAX_SUBQUESTIONS = 10; // hard cap on total sub-questions across initial + amended
// Composer-dispatched follow-ups: how many times the composer may ask
// for an extra wave before being forced to compose with what it has.
export const COMPOSER_MAX_DISPATCHES = 1;

// Drill-as-sub-investigation cost control. A follow-up/drill auto-routed to
// Investigate is first classified lookup-vs-deep by a cheap model; lookups run
// the single-shot path instead of a full investigation. The per-session budget
// is a hard backstop against pathological drilling — beyond it, auto-routed
// follow-ups degrade to lookup regardless of the classifier.
export const FOLLOWUP_CLASSIFIER_MODEL = "claude-haiku-4-5-20251001" as const;
// Planning (decompose → JSON plan) and re-planning (continue/amend/stop) are
// structured tasks on schema+stats only — not user-facing dashboard quality — so
// they run on the cheap model regardless of the user's chosen code-gen model.
// The planner ingests the full schema (and, for warehouses, every table), so
// this is a meaningful per-investigation saving.
export const PLANNER_MODEL = "claude-haiku-4-5-20251001" as const;
// Cheap model for low-stakes structured tasks: the composer gap-check (small
// JSON coverage verdict) and query suggestions. ~1/3 the input price of Sonnet.
export const GAP_CHECK_MODEL = "claude-haiku-4-5-20251001" as const;
export const SUGGEST_MODEL = "claude-haiku-4-5-20251001" as const;
export const MAX_AUTO_INVESTIGATIONS_PER_SESSION = 4;

export const AVAILABLE_MODELS = [
  { id: "claude-fable-5", label: "Claude Fable 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export function isValidModelId(id: string): id is ModelId {
  return AVAILABLE_MODELS.some((m) => m.id === id);
}

/**
 * Per-token pricing for cost tracking, in USD per 1,000,000 tokens.
 * HAND-MAINTAINED — update when Anthropic prices change. Cache-write is the
 * 5-minute ephemeral rate (1.25× input); cache-read is 0.1× input. Models not
 * listed (e.g. local Ollama/MLX) have no entry → cost is treated as $0 (tokens
 * are still tracked). Keyed by the resolved model id.
 */
export interface ModelPrice {
  /** uncached input tokens */
  input: number;
  /** output tokens */
  output: number;
  /** cache write (ephemeral 5m) */
  cacheWrite: number;
  /** cache read */
  cacheRead: number;
}

// cacheWrite is the 1-HOUR ephemeral rate (2× input) because cachedSystem/
// cachedText use ttl:"1h"; cacheRead is 0.1× input. If the cache TTL changes
// back to the 5-minute default, cacheWrite drops to 1.25× input.
// Opus 4.x list price is $5/$25 per MTok (the $15/$75 figure is Claude 3 Opus).
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Claude 5 family: tier-assumed pricing (matches the corresponding 4.x
  // tier) until official numbers are wired — cost display only, not billing.
  "claude-fable-5": { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.3 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  // Retained so historical analyses that ran on Opus 4.6 still price correctly.
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheWrite: 2, cacheRead: 0.1 },
};

export const AVAILABLE_RUNTIMES = [
  { id: "docker", label: "Docker (Local)" },
  { id: "e2b", label: "E2B (Cloud)" },
  { id: "microsandbox", label: "Microsandbox (MicroVM)" },
] as const;

export type SandboxRuntimeId = (typeof AVAILABLE_RUNTIMES)[number]["id"];

/** Static fallback — prefer getActiveSandboxRuntime() which checks runtime config */
export const DEFAULT_SANDBOX_RUNTIME: SandboxRuntimeId =
  (envConfig().SANDBOX_RUNTIME as SandboxRuntimeId) || "docker";

export function isValidRuntimeId(id: string): id is SandboxRuntimeId {
  return AVAILABLE_RUNTIMES.some((r) => r.id === id);
}

export const AVAILABLE_PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "claude-cli", label: "Claude CLI" },
  { id: "bedrock", label: "Amazon Bedrock" },
  { id: "vertex", label: "Google Vertex AI" },
  { id: "openai-compatible", label: "OpenAI-Compatible" },
  { id: "mlx", label: "MLX (Apple Silicon)" },
  { id: "llama-cpp", label: "llama.cpp (Local)" },
  { id: "ollama", label: "Ollama (Local)" },
] as const;

export type LLMProviderId = (typeof AVAILABLE_PROVIDERS)[number]["id"];

export type LocalBackendId = "mlx" | "llama-cpp" | "ollama";

/** Recommended model entry with minimum RAM requirement for filtering */
export interface RecommendedModel {
  id: string;
  label: string;
  description: string;
  tag: string;
  family: "qwen" | "llama" | "glm";
  /** Minimum system RAM in GB needed to run this model */
  minRam: number;
}

export const RECOMMENDED_OLLAMA_MODELS: readonly RecommendedModel[] = [
  // --- 8 GB tier ---
  {
    id: "llama3.2:3b",
    label: "Llama 3.2 3B",
    description: "Fast & light, great for quick iterations",
    tag: "lightweight",
    family: "llama",
    minRam: 8,
  },
  {
    id: "qwen2.5-coder:7b",
    label: "Qwen 2.5 Coder 7B",
    description: "Solid coding model for 8 GB machines",
    tag: "lightweight",
    family: "qwen",
    minRam: 8,
  },
  // --- 16 GB tier ---
  {
    id: "glm4:9b",
    label: "GLM-4 9B",
    description: "Strong all-around, good reasoning",
    tag: "recommended",
    family: "glm",
    minRam: 16,
  },
  {
    id: "llama3.1:8b",
    label: "Llama 3.1 8B",
    description: "General purpose, good instruction following",
    tag: "recommended",
    family: "llama",
    minRam: 16,
  },
  {
    id: "qwen2.5-coder:14b",
    label: "Qwen 2.5 Coder 14B",
    description: "Best coding quality for 16 GB",
    tag: "recommended",
    family: "qwen",
    minRam: 16,
  },
  // --- 24 GB tier ---
  {
    id: "qwen2.5-coder:32b",
    label: "Qwen 2.5 Coder 32B",
    description: "Highest coding quality, needs 24+ GB",
    tag: "premium",
    family: "qwen",
    minRam: 24,
  },
  // --- 48 GB+ tier ---
  {
    id: "llama3.3:latest",
    label: "Llama 3.3 70B",
    description: "Best general-purpose, needs 48+ GB",
    tag: "premium",
    family: "llama",
    minRam: 48,
  },
] as const;

export const RECOMMENDED_MLX_MODELS: readonly RecommendedModel[] = [
  // --- 8 GB tier ---
  {
    id: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    label: "Llama 3.2 3B (4-bit)",
    description: "Fast & light (~2 GB), great for quick iterations",
    tag: "lightweight",
    family: "llama",
    minRam: 8,
  },
  {
    id: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
    label: "Qwen 2.5 Coder 7B (4-bit)",
    description: "Solid coding model (~4 GB)",
    tag: "lightweight",
    family: "qwen",
    minRam: 8,
  },
  // --- 16 GB tier ---
  {
    id: "mlx-community/GLM-4.7-Flash-4bit",
    label: "GLM-4.7 Flash (4-bit)",
    description: "Fast reasoning and code (~5 GB)",
    tag: "recommended",
    family: "glm",
    minRam: 16,
  },
  {
    id: "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit",
    label: "Llama 3.1 8B (4-bit)",
    description: "General purpose (~5 GB)",
    tag: "recommended",
    family: "llama",
    minRam: 16,
  },
  {
    id: "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit",
    label: "Qwen 2.5 Coder 14B (4-bit)",
    description: "Best coding quality for 16 GB (~8 GB)",
    tag: "recommended",
    family: "qwen",
    minRam: 16,
  },
  // --- 24 GB tier ---
  {
    id: "mlx-community/GLM-4.7-4bit",
    label: "GLM-4.7 (4-bit)",
    description: "Strong reasoning and code (~5 GB, headroom for context)",
    tag: "recommended",
    family: "glm",
    minRam: 16,
  },
  {
    id: "mlx-community/Qwen2.5-Coder-32B-Instruct-4bit",
    label: "Qwen 2.5 Coder 32B (4-bit)",
    description: "Highest coding quality (~18 GB)",
    tag: "premium",
    family: "qwen",
    minRam: 24,
  },
  {
    id: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
    label: "Qwen3 Coder 30B-A3B MoE (4-bit)",
    description: "MoE architecture, near-Sonnet quality (~17 GB)",
    tag: "premium",
    family: "qwen",
    minRam: 24,
  },
  // --- 48 GB+ tier ---
  {
    id: "mlx-community/Meta-Llama-3.3-70B-Instruct-4bit",
    label: "Llama 3.3 70B (4-bit)",
    description: "Best general-purpose (~40 GB)",
    tag: "premium",
    family: "llama",
    minRam: 48,
  },
] as const;

export const RECOMMENDED_LLAMACPP_MODELS: readonly RecommendedModel[] = [
  // --- 8 GB tier ---
  {
    id: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    label: "Llama 3.2 3B (GGUF)",
    description: "Fast & light (~2 GB)",
    tag: "lightweight",
    family: "llama",
    minRam: 8,
  },
  {
    id: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
    label: "Qwen 2.5 Coder 7B (GGUF)",
    description: "Solid coding model (~4 GB)",
    tag: "lightweight",
    family: "qwen",
    minRam: 8,
  },
  // --- 16 GB tier ---
  {
    id: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
    label: "Llama 3.1 8B (GGUF)",
    description: "General purpose (~5 GB)",
    tag: "recommended",
    family: "llama",
    minRam: 16,
  },
  {
    id: "bartowski/Qwen2.5-Coder-14B-Instruct-GGUF",
    label: "Qwen 2.5 Coder 14B (GGUF)",
    description: "Best coding quality for 16 GB (~8 GB)",
    tag: "recommended",
    family: "qwen",
    minRam: 16,
  },
  // --- 24 GB tier ---
  {
    id: "bartowski/Qwen2.5-Coder-32B-Instruct-GGUF",
    label: "Qwen 2.5 Coder 32B (GGUF)",
    description: "Highest coding quality (~18 GB)",
    tag: "premium",
    family: "qwen",
    minRam: 24,
  },
] as const;

/** DOM event fired when the recent-sources list changes (settings section → page). */
export const RECENTS_CHANGED_EVENT = "hermetic:recents-changed";

// ── Modularization M1-1d: named constants for former magic strings ──────────

/** Docker container name prefix — producer (docker-executor) and orphan
 *  reaper (run-control) must agree; two harnesses sharing a host would
 *  otherwise reap each other's containers. */
export const SANDBOX_CONTAINER_PREFIX = "hermetic-sandbox-";

/** Every localStorage key the app writes. The `gud-` prefix is a legacy
 *  product name kept for existing users' persisted settings. */
export const STORAGE_KEYS = {
  theme: "gud-theme",
  mode: "gud-mode",
  codeGenModel: "gud-code-gen-model",
  uiComposeModel: "gud-ui-compose-model",
  sandboxRuntime: "gud-sandbox-runtime",
  investigateView: "hermetic-investigate-view",
} as const;

/** Default endpoints for local LLM backends (overridable via runtime config). */
export const DEFAULT_LOCAL_LLM_ENDPOINTS = {
  ollama: "http://localhost:11434",
  mlx: "http://localhost:8080",
  "llama-cpp": "http://localhost:8081",
} as const;

// External map/export assets live in a leaf module so Edge-compiled
// middleware can derive its CSP host list without evaluating this file.
export { BASEMAP_STYLE_URL, BASEMAP_TILE_URLS, REVEALJS_CDN_URL } from "@/lib/basemap-constants";
