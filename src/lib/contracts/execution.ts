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
  /** Raw declare_finding entries from the sandbox registry, in declaration
   *  order (declared-findings spec §2) — validated/merged host-side by
   *  lib/findings; absent for pre-findings runs and findings.mode=off. */
  findings?: unknown[];
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

/** A named extra file staged into the sandbox alongside the primary input. */
export interface AdditionalFile {
  path: string;
  content: string;
}

/**
 * Source-agnostic progress event streamed to the client. Field names match the
 * on-the-wire shape the sandbox prelude's progress() emits (snake_case), so it
 * passes through untransformed.
 */
export interface SandboxProgress {
  /** Coarse phase: starting | scanning | analyzing | hydrating | composing | … */
  phase: string;
  /** Human-readable detail ("scanning California buildings"). */
  detail?: string;
  /** 0..1 completion when the phase can report it (e.g. a DuckDB scan). */
  fraction?: number;
  /** Rows processed so far / expected, when known. */
  rows?: number;
  total_rows?: number;
  /** Milliseconds since the run started. */
  elapsed_ms?: number;
  /** Extra fields the analysis code passes to progress(**fields). */
  [k: string]: unknown;
}

/** A phase-keyed remedy merged into the sandbox OOM-failure router.
 *  Owned here (not skills/types, which re-exports it): it is part of the
 *  sandbox execution seam, and contracts imports nothing above it. */
export interface SkillFailureHint {
  /** Case-insensitive regex source matched against the failing progress phase
   *  ("" when a hard kill left no heartbeat — use pattern `^` to catch that). */
  pattern: string;
  /** Remedy text injected verbatim into the retry error message. */
  hint: string;
  /** Owning skill name — logged when the hint fires. */
  skill: string;
  /**
   * Matched only for a BARE hard kill — never over a watchdog-predicted abort,
   * whose own message carries the right guidance. For catch-all (`^`) hints.
   */
  fallback?: boolean;
}

/**
 * Everything the ORCHESTRATION layer supplies to a sandbox execution
 * (modularization M4/WS6). The executors never import run-control — the old
 * upward imports (registerContainer/getRunSignal/reportProgress/
 * getRunFailureHints) arrive here as injected capabilities. All optional:
 * outside a tracked run everything degrades to a no-op, exactly as the
 * ambient lookups did.
 */
export interface SandboxRunHooks {
  /** Fires when the user hits Stop — the executor tears the container down. */
  signal?: AbortSignal;
  /** Live progress heartbeats (phase/fraction/rows) from the prelude. */
  onProgress?: (p: SandboxProgress) => void;
  /** Container lifecycle registration (orphan-reaper bookkeeping). */
  onContainerStart?: (containerId: string) => void;
  onContainerEnd?: (containerId: string) => void;
  /** Active skills' failure remedies for the post-mortem parser. */
  failureHints?: () => SkillFailureHint[];
}
