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
// At/above this row count, materialize to Parquet and analyze via DuckDB
// (bind-mounted) instead of parsing the CSV in Node + pandas. Below it the
// proven CSV path is unchanged.
export const PARQUET_MATERIALIZE_THRESHOLD = 100_000;
export const MAX_CSV_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_CSV_SIZE_LABEL = "100MB";
export const SANDBOX_TIMEOUT_MS = 30_000; // 30 seconds
export const CSV_TTL_MS = 60 * 60 * 1000; // 1 hour
export const DOCKER_SANDBOX_IMAGE = "hermetic-sandbox";
export const MAX_SAMPLE_ROWS = 5;
export const MAX_PREVIEW_ROWS = 10;
export const MAX_COMPONENT_COUNT = 20;
export const MAX_NESTING_DEPTH = 3;
export const CODE_GEN_MODEL = "claude-sonnet-4-6" as const;
export const UI_COMPOSE_MODEL = "claude-sonnet-4-6" as const;
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
  (process.env.SANDBOX_RUNTIME as SandboxRuntimeId) || "docker";

export function isValidRuntimeId(id: string): id is SandboxRuntimeId {
  return AVAILABLE_RUNTIMES.some((r) => r.id === id);
}

export const AVAILABLE_PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
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
