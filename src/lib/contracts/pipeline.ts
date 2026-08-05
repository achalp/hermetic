/**
 * Pipeline result contract — what one code-gen → sandbox-execute run returns.
 * Moved out of pipeline/orchestrator.ts so llm/ modules (investigate-composer
 * consumes it via SubQuestionResult in ./investigation) depend on contracts,
 * never upward on pipeline/ — the same layering rule the sandbox executors
 * follow (see contracts/execution.ts SandboxRunHooks).
 */

import type { SandboxExecutionResult } from "./execution";

export interface PipelineResult {
  executionResult: SandboxExecutionResult;
  generatedCode: string;
  question: string;
  /**
   * Per-step SQL: the warehouse query this step ran to fetch its data
   * (Investigate over a warehouse, where each sub-question issues its own
   * SQL). Absent for file-source steps and Python-only paths.
   */
  sql?: string;
  /**
   * csv_id under which this step's SQL result was stored, so the step's
   * Python can be re-run against the same data later (notebook re-run).
   */
  stepCsvId?: string;
  /**
   * csv_id under which this step's FULL primary output frame was stored
   * (uncapped). Lets a dependent's re-run consume the complete upstream
   * output, independent of the trace's display-preview row cap.
   */
  outputCsvId?: string;
  /**
   * Set to true when the pipeline exhausted its retry budget on semantic
   * failures (empty/NaN/zero-only results) but execution itself succeeded.
   * The caller can surface this to the composer / UI as a warning.
   */
  degraded?: boolean;
  /** When `degraded` is true, the most recent validator reason. */
  degradedReason?: string;
}
