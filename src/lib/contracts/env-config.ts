/**
 * The environment-derived configuration contract (modularization M2-B1,
 * spec §3.2 HermeticConfig).
 *
 * Every environment variable lib code consumes, as a flat typed snapshot.
 * The HARNESS resolves it once at boot (src/harness/env-config.ts for Next,
 * test-setup for vitest, the CLI's boot for WS8) and pushes it into the
 * harness slot; lib reads it via envConfig() and never touches process.env
 * (ratchet-enforced: lib-process-env → 0).
 *
 * Deliberately flat and string-valued — a 1:1 mirror of the env so the B1
 * migration is purely mechanical (`process.env.X` becomes `envConfig().X`).
 * Parsing/defaulting stays where it always was. Structured, parsed config
 * arrives with the LLMClient work (B2).
 */

export const ENV_CONFIG_KEYS = [
  // LLM providers
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_REGION",
  "GOOGLE_VERTEX_PROJECT",
  "GOOGLE_VERTEX_LOCATION",
  // Sandbox (Docker only — E2B/microsandbox removed)
  "SANDBOX_RUNTIME",
  "SANDBOX_MEMORY_FRACTION",
  // Warehouse env presets
  "WAREHOUSE_TYPE",
  "WAREHOUSE_PG_HOST",
  "WAREHOUSE_PG_PORT",
  "WAREHOUSE_PG_DATABASE",
  "WAREHOUSE_PG_USER",
  "WAREHOUSE_PG_PASSWORD",
  "WAREHOUSE_PG_SSL",
  "WAREHOUSE_PG_SCHEMA",
  "WAREHOUSE_CH_HOST",
  "WAREHOUSE_CH_PORT",
  "WAREHOUSE_CH_DATABASE",
  "WAREHOUSE_CH_USER",
  "WAREHOUSE_CH_PASSWORD",
  "WAREHOUSE_CH_SSL",
  "WAREHOUSE_BQ_PROJECT",
  "WAREHOUSE_BQ_DATASET",
  "WAREHOUSE_BQ_CREDENTIALS_JSON",
  // App tuning
  "HERMETIC_LOCAL_FILE_ROOTS",
  "HERMETIC_EGRESS_FETCH_BIN",
  "HERMETIC_PYODIDE_DIR",
  "HERMETIC_FORCE_RUNTIME",
  "HERMETIC_MAX_HISTORY_ENTRIES",
  "HERMETIC_MAX_RUN_RECORDS",
  "HERMETIC_CLAUDE_CLI_EFFORT",
  "LOG_LEVEL",
  // Process facts
  "NODE_ENV",
  "VITEST",
  "TMPDIR",
] as const;

export type EnvConfigKey = (typeof ENV_CONFIG_KEYS)[number];

export type HermeticEnvConfig = { [K in EnvConfigKey]?: string };
