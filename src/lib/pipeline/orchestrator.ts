import {
  generateAnalysisCode,
  cleanGeneratedCode,
  fixUpFilenames,
  fixExcelReadOnCsv,
  fixReadCsvDelimiter,
  fixColumnNameCase,
  stripValueAssertions,
} from "@/lib/llm/code-generation";
import { buildRetryPromptMulti, RETRY_GUIDANCE, buildGeospatialGuidance } from "@/lib/llm/prompts";
import { getSandboxMemoryLimitGbLabel } from "@/lib/sandbox/memory-budget";
import { recordFailure } from "@/lib/diagnostics/failure-log";
import {
  recordRunStart,
  recordRunArtifact,
  recordRunEvent,
  recordAttemptCode,
  recordAttemptOutcome,
} from "@/lib/diagnostics/run-recorder";
import { executeSandbox } from "@/lib/sandbox";
import type { AdditionalFile } from "@/lib/sandbox";
import { codeDoesRemoteIo } from "@/lib/sandbox/docker-utils";
import { estimateRun, reportEstimate } from "@/lib/pipeline/estimate";
import { generateText } from "ai";
import { withPhase } from "@/lib/cost/accumulator";
import { getPurposeCodegenScope } from "@/lib/purpose-prompts";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { CSVSchema, ConversationTurn, SandboxExecutionResult, SchemaMode } from "@/lib/types";
import { logger } from "@/lib/logger";
import {
  validateExecutionResult,
  formatSemanticVerdictForRetry,
} from "@/lib/pipeline/result-validator";

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

export interface PipelineOptions {
  onStage?: (stage: string) => void;
  mode?: SchemaMode;
  model?: string;
  runtime?: SandboxRuntimeId;
  geojsonContent?: string | null;
  additionalFiles?: AdditionalFile[];
  workbookContext?: string;
  localMountPath?: string;
  localFileContext?: string;
  priorTurns?: ConversationTurn[];
  /** Host Parquet file to docker-cp into the sandbox (/data/input.parquet). */
  inputParquetPath?: string;
  purpose?: string;
}

/**
 * Code-gen → sandbox-execute → retry loop. Options object instead of the old
 * 15 positional parameters — with 12 trailing optionals, three of which were
 * `string | undefined` neighbors (workbookContext / localMountPath /
 * localFileContext), a swapped pair type-checked fine and failed at runtime;
 * call sites were padding with bare `undefined`s to reach the one they meant.
 */
export async function runPipeline(
  schema: CSVSchema,
  csvContent: string,
  question: string,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const {
    onStage,
    mode = "metadata",
    model = CODE_GEN_MODEL,
    runtime,
    geojsonContent,
    additionalFiles,
    workbookContext,
    localMountPath,
    localFileContext,
    priorTurns,
    inputParquetPath,
    purpose,
  } = options;
  // Open the forensic record for this run: every attempt's code + outcome is
  // persisted to data/runs/<runId>/ as it happens, so a crash or exhausted-retry
  // failure (which saves only a near-empty history stub) still leaves the exact
  // code and errors to debug from.
  recordRunStart({
    question,
    filename: schema.filename,
    rowCount: schema.row_count,
    mode,
    model,
    localMount: !!localMountPath,
    remoteParquet: !!inputParquetPath,
  });
  let attemptIndex = 1;

  // Step 1: Generate analysis code
  onStage?.("generating_code");
  let code: string;
  try {
    code = await generateAnalysisCode(
      schema,
      question,
      mode,
      model,
      workbookContext,
      localFileContext,
      priorTurns,
      purpose
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordRunEvent({ type: "codegen_failed", attempt: attemptIndex, error: msg });
    // Log the full error including any nested cause/errors for debugging
    const details: Record<string, unknown> = {
      error: msg,
      name: err instanceof Error ? err.name : typeof err,
    };
    if (err && typeof err === "object" && "errors" in err) {
      const nested = (err as { errors: unknown[] }).errors;
      details.nested = nested.map((e) =>
        e instanceof Error ? { name: e.name, message: e.message } : String(e)
      );
    }
    if (err instanceof Error && err.cause) {
      details.cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
    }
    logger.error("Code generation failed", details);
    throw new Error(
      msg || "LLM failed to generate code — check that the model server is running and responsive."
    );
  }

  // Persist the code BEFORE executing — an OOM/crash during the run must not lose it.
  recordAttemptCode(attemptIndex, code);

  // Step 2: Execute in sandbox
  logger.debug("Generated code", { chars: code.length, localMount: !!localMountPath });
  if (localMountPath) {
    logger.info("Local file execution", { localMountPath, fullCode: code });
  } else if (codeDoesRemoteIo(code)) {
    logger.info("Remote cloud execution", { fullCode: code });
  }
  // Up-front duration estimate (a bucketed range, not an ETA) so the user knows
  // a long run is expected — streamed as a progress event before execution.
  const remote = codeDoesRemoteIo(code);
  reportEstimate(
    estimateRun({
      rowCount: schema.row_count,
      isRemote: remote,
      isLargeData: !!localMountPath || !!inputParquetPath || remote,
    })
  );
  onStage?.("executing");
  let result = await executeSandbox(
    csvContent,
    code,
    runtime,
    geojsonContent,
    additionalFiles,
    schema.csv_id,
    localMountPath,
    inputParquetPath
  );
  recordAttemptOutcome(attemptIndex, {
    success: result.success,
    error: result.success ? undefined : result.error,
    errorKind: result.success ? undefined : result.errorKind,
    executionMs: result.execution_ms,
    hasResults: result.success && !!result.results,
  });

  // Step 3: Self-correction loop. Up to MAX_RETRIES attempts. Each retry
  // shows the LLM the FULL history of prior failed attempts (code + error),
  // so it can avoid repeating the same fix that already failed.
  //
  // Two failure modes count against the same retry budget:
  //   - Execution failure: result.success === false (the sandbox threw)
  //   - Semantic failure: result.success === true but the validator
  //     verdict says the output is degenerate (empty / NaN-only / etc.)
  // For semantic failures, the "error" string fed to the retry prompt is
  // the validator's reason + suggested fix, not a Python traceback.
  // Restored to 3 (was briefly cut to 2 in the cost-optimization pass): each
  // struggling sub-question needs a final recovery attempt, and 2 measurably
  // raised the degraded/failed rate on Investigate, where it compounds across
  // sub-questions. Retries are cheap now that the system prompt is cached.
  const MAX_RETRIES = 3;
  // A clean run that just produced no results/charts is usually a LEGITIMATE
  // "no signal" answer, not a bug — so give it ONE fix attempt and then accept
  // it as degraded, rather than burning the whole budget manufacturing a token
  // result. Execution CRASHES are real bugs and keep the full MAX_RETRIES.
  const MAX_SEMANTIC_RETRIES = 1;
  let semanticRetries = 0;
  const priorAttempts: { code: string; error: string }[] = [];
  let attempt = 0;

  // Initial semantic check (only when execution succeeded)
  let semanticVerdict = result.success ? validateExecutionResult(result) : null;
  if (semanticVerdict && !semanticVerdict.ok) {
    logger.info("Initial result failed semantic validation", {
      reason: semanticVerdict.reason,
    });
  }

  while (attempt < MAX_RETRIES) {
    // Decide whether to retry at all
    let retryError: string;
    if (!result.success) {
      retryError = result.error;
      // A timeout means the query was too slow for the (already generous)
      // budget, not that the code is buggy — regenerating similar code just
      // times out again and multiplies the wait. Fail fast instead of
      // retrying. Keys on the STRUCTURED errorKind the executors set
      // (CORE-7 — the old message-substring coupling would silently
      // re-enable futile retries on a reword); the regex stays only as a
      // fallback for foreign SDK timeout strings we don't control.
      // A user Stop (errorKind "stopped") must also fail fast — never
      // regenerate and re-run something the user just cancelled.
      if (
        result.errorKind === "timeout" ||
        result.errorKind === "stopped" ||
        /timed out/i.test(retryError)
      )
        break;
    } else if (semanticVerdict && !semanticVerdict.ok) {
      // Already gave the empty result its one fix attempt → accept it as
      // degraded ("no signal") instead of retrying further.
      if (semanticRetries >= MAX_SEMANTIC_RETRIES) break;
      semanticRetries++;
      retryError = formatSemanticVerdictForRetry(semanticVerdict);
    } else {
      break; // success
    }

    priorAttempts.push({ code, error: retryError });
    attempt++;
    onStage?.(attempt === 1 ? "retrying" : `retrying_${attempt}`);
    logger.info("Pipeline retrying", {
      attempt,
      maxRetries: MAX_RETRIES,
      kind: result.success ? "semantic" : "execution",
      errorPreview: retryError.slice(0, 200),
    });
    void recordFailure({
      stage: "code-exec",
      attempt,
      kind: result.success ? "semantic" : "execution",
      step: question,
      errorText: retryError,
    });

    // Re-inject the geospatial recipe (KD-tree / polygon / memory-safe rowid) on
    // retry. Without this, a retry rebuilt from scratch drops the schema block's
    // spatial guidance and "repairs" a superlative by downsampling — the exact
    // regression that produced a grid-cell approximation. buildGeospatialGuidance
    // returns "" for non-geo data, so this is a no-op there.
    const retryGeoGuidance = buildGeospatialGuidance(schema, await getSandboxMemoryLimitGbLabel());
    const retrySystemExtra =
      (localFileContext ? `\n\nIMPORTANT: ${localFileContext}` : "") +
      (retryGeoGuidance ? `\n${retryGeoGuidance}` : "") +
      (purpose ? `\n\n${getPurposeCodegenScope(purpose)}` : "");
    let retryCode: string;
    try {
      const retryResult = await withPhase("code_gen", () =>
        generateText({
          model: getModel(model),
          // The static "Common fixes" guidance lives here (cached) rather than in
          // the per-attempt user prompt, so it isn't re-billed on every retry.
          system: cachedSystem(
            "You are a data analyst. Fix the Python code based on the error history. The code must write its JSON output to /data/output.json (not print to stdout). Output ONLY the corrected Python code. No markdown fencing.\n\n" +
              RETRY_GUIDANCE +
              retrySystemExtra
          ),
          prompt: buildRetryPromptMulti(priorAttempts, schema),
          temperature: 0,
          maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
        })
      );

      retryCode = fixColumnNameCase(
        stripValueAssertions(
          fixReadCsvDelimiter(
            fixExcelReadOnCsv(fixUpFilenames(cleanGeneratedCode(retryResult.text), schema.filename))
          )
        ),
        schema.columns.map((c) => c.name)
      );
    } catch (err) {
      // LLM call itself failed — surface the underlying error since
      // that's what the user actually cares about diagnosing.
      const llmErr = err instanceof Error ? err.message : String(err);
      const lastSandboxErr = result.success
        ? "(execution succeeded but result was degenerate)"
        : result.error;
      throw new Error(
        `Analysis failed and retry LLM call also failed.\nLast sandbox error: ${lastSandboxErr}\nLLM error: ${llmErr}`
      );
    }

    attemptIndex++;
    recordAttemptCode(attemptIndex, retryCode);

    onStage?.("executing");
    result = await executeSandbox(
      csvContent,
      retryCode,
      runtime,
      geojsonContent,
      additionalFiles,
      schema.csv_id,
      localMountPath,
      inputParquetPath
    );
    recordAttemptOutcome(attemptIndex, {
      success: result.success,
      error: result.success ? undefined : result.error,
      errorKind: result.success ? undefined : result.errorKind,
      executionMs: result.execution_ms,
      hasResults: result.success && !!result.results,
    });

    code = retryCode;
    semanticVerdict = result.success ? validateExecutionResult(result) : null;
  }

  // Persist the final code + outcome regardless of success/degraded/failure, so
  // the run's record is complete even when history saves only a stub.
  recordRunArtifact("code.py", code);
  recordRunEvent({ type: "final", success: result.success, attempts: attemptIndex });
  if (result.success) {
    recordRunArtifact(
      "output.json",
      JSON.stringify({ results: result.results, chart_data: result.chart_data }, null, 2)
    );
  }

  // Execution-level failure after exhausting retries → throw, same as
  // before. Semantic failures degrade gracefully (see below).
  if (!result.success) {
    void recordFailure({
      stage: "code-exec",
      attempt: attempt + 1,
      kind: "execution",
      step: question,
      errorText: result.error,
    });
    const summary = priorAttempts
      .map((a, i) => `Attempt ${i + 1}: ${a.error.slice(0, 200).replace(/\n/g, " ")}`)
      .concat(`Attempt ${attempt + 1}: ${result.error.slice(0, 200).replace(/\n/g, " ")}`)
      .join("\n");
    // Report the ACTUAL attempt count, not MAX_RETRIES — a timeout fail-fast
    // (errorKind === "timeout") breaks after ONE attempt, so "failed after 3
    // retries" was a lie that sent every reader hunting for retries that
    // never ran. A timeout says "too slow", not "buggy"; name that.
    const attemptsRun = attempt + 1;
    const headline =
      result.errorKind === "timeout"
        ? `Analysis timed out and was not retried (a timeout means the query is too slow for the budget, not that the code is wrong).`
        : `Analysis failed after ${attemptsRun} attempt${attemptsRun === 1 ? "" : "s"}.`;
    throw new Error(`${headline}\n\n${summary}\n\nFinal error:\n${result.error}`);
  }

  if (attempt > 0) {
    logger.info("Pipeline succeeded after retries", { attemptsToSucceed: attempt + 1 });
  }

  // Semantic-failure-exhausted path: return the result with `degraded: true`
  // so the caller (composer / UI) can surface a warning rather than treating
  // it as a clean success.
  if (semanticVerdict && !semanticVerdict.ok) {
    logger.warn("Pipeline returning degraded result", {
      reason: semanticVerdict.reason,
      retriesUsed: attempt,
    });
    void recordFailure({
      stage: "code-exec",
      attempt,
      kind: "semantic",
      step: question,
      errorText: semanticVerdict.reason,
    });
    return {
      executionResult: result,
      generatedCode: code,
      question,
      degraded: true,
      degradedReason: semanticVerdict.reason,
    };
  }

  return {
    executionResult: result,
    generatedCode: code,
    question,
  };
}

/**
 * Edit-and-rerun variant: takes pre-existing code (edited by the user in
 * the Artifacts panel), executes it in the sandbox, and returns the new
 * artifacts. Skips code-generation entirely — no LLM calls.
 *
 * Unlike `runPipeline`, this does NOT retry on failure. Edited code that
 * fails surfaces the raw sandbox error so the user can fix it and re-run.
 */
export async function runPipelineWithCode(
  code: string,
  csvContent: string,
  question: string,
  options: {
    runtime?: SandboxRuntimeId;
    geojsonContent?: string | null;
    additionalFiles?: AdditionalFile[];
    csvId?: string;
    localMountPath?: string;
    /** Host Parquet file to docker-cp into the sandbox (/data/input.parquet). */
    inputParquetPath?: string;
  } = {}
): Promise<PipelineResult> {
  logger.debug("Re-executing edited code", {
    chars: code.length,
    localMount: !!options.localMountPath,
    parquet: !!options.inputParquetPath,
  });

  const result = await executeSandbox(
    csvContent,
    code,
    options.runtime,
    options.geojsonContent,
    options.additionalFiles,
    options.csvId,
    options.localMountPath,
    options.inputParquetPath
  );

  if (!result.success) {
    throw new Error(result.error || "Edited code failed to execute.");
  }

  return {
    executionResult: result,
    generatedCode: code,
    question,
  };
}
