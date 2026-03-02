export const MAX_CSV_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_CSV_SIZE_LABEL = "100MB";
export const SANDBOX_TIMEOUT_MS = 30_000; // 30 seconds
export const CSV_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_SAMPLE_ROWS = 5;
export const MAX_PREVIEW_ROWS = 10;
export const MAX_COMPONENT_COUNT = 20;
export const MAX_NESTING_DEPTH = 3;
export const CODE_GEN_MODEL = "claude-sonnet-4-6" as const;
export const UI_COMPOSE_MODEL = "claude-sonnet-4-6" as const;

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
] as const;

export type LLMProviderId = (typeof AVAILABLE_PROVIDERS)[number]["id"];
