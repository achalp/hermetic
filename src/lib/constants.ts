export const WAREHOUSE_MAX_ROWS = 50_000; // max rows to extract from a warehouse table
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

export const AVAILABLE_MODELS = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export function isValidModelId(id: string): id is ModelId {
  return AVAILABLE_MODELS.some((m) => m.id === id);
}

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
