/**
 * Sandbox execution result contract (WS6 boundary).
 * Split from lib/types.ts (fan-in 85) — modularization M1-1a, spec S3.3.
 */

export interface SandboxExecutionResult {
  success: true;
  results: Record<string, unknown>;
  chart_data: Record<string, unknown>;
  images: Record<string, string>;
  datasets?: Record<string, Record<string, unknown>[]>;
  execution_ms: number;
}

export interface SandboxExecutionError {
  success: false;
  error: string;
  /**
   * Structured failure class for the errors that drive CONTROL FLOW —
   * previously the orchestrator's no-retry decision string-matched
   * /timed out/ against docker-utils' message, with nothing tying the two
   * together (a reworded message would silently re-enable futile retries).
   * "timeout" → fail fast, don't retry; "oom" → retry with lean-script
   * guidance; "stopped" → the user cancelled — fail fast, don't retry.
   * Absent for ordinary execution errors.
   */
  errorKind?: "timeout" | "oom" | "stopped" | "user-config";
  execution_ms: number;
  /**
   * Post-mortem diagnostics captured at failure — the container's self-reported
   * DuckDB config line (HERMETIC_DUCKDB_CFG: threads=…), the OOM phase, and a
   * stderr tail. Saved as attempt-NN.diag.txt so a hard-kill OOM (where the
   * container is torn down before the console can surface it) is still
   * diagnosable from the run recorder.
   */
  execDiag?: string;
}

export type ExecutionResult = SandboxExecutionResult | SandboxExecutionError;

/** Optional cloud credentials for a private remote Parquet bucket. Anonymous
 *  access (public buckets like Overture) needs none of this. */
