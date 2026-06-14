import {
  generateAnalysisCode,
  cleanGeneratedCode,
  fixUpFilenames,
  fixReadCsvDelimiter,
} from "@/lib/llm/code-generation";
import { buildRetryPromptMulti } from "@/lib/llm/prompts";
import { executeSandbox } from "@/lib/sandbox";
import type { AdditionalFile } from "@/lib/sandbox";
import { generateText } from "ai";
import { getModel } from "@/lib/llm/client";
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

export async function runPipeline(
  schema: CSVSchema,
  csvContent: string,
  question: string,
  onStage?: (stage: string) => void,
  mode: SchemaMode = "metadata",
  model: string = CODE_GEN_MODEL,
  runtime?: SandboxRuntimeId,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[],
  workbookContext?: string,
  localMountPath?: string,
  localFileContext?: string,
  priorTurns?: ConversationTurn[]
): Promise<PipelineResult> {
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
      priorTurns
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
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

  // Step 2: Execute in sandbox
  logger.debug("Generated code", { chars: code.length, localMount: !!localMountPath });
  if (localMountPath) {
    logger.info("Local file execution", { localMountPath, fullCode: code });
  }
  onStage?.("executing");
  let result = await executeSandbox(
    csvContent,
    code,
    runtime,
    geojsonContent,
    additionalFiles,
    schema.csv_id,
    localMountPath
  );

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
  const MAX_RETRIES = 3;
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
    } else if (semanticVerdict && !semanticVerdict.ok) {
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

    const retrySystemExtra = localFileContext ? `\n\nIMPORTANT: ${localFileContext}` : "";
    let retryCode: string;
    try {
      const retryResult = await generateText({
        model: getModel(model),
        system:
          "You are a data analyst. Fix the Python code based on the error history. The code must write its JSON output to /data/output.json (not print to stdout). Output ONLY the corrected Python code. No markdown fencing." +
          retrySystemExtra,
        prompt: buildRetryPromptMulti(priorAttempts, schema),
        temperature: 0,
        maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      });

      retryCode = fixReadCsvDelimiter(
        fixUpFilenames(cleanGeneratedCode(retryResult.text), schema.filename)
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

    onStage?.("executing");
    result = await executeSandbox(
      csvContent,
      retryCode,
      runtime,
      geojsonContent,
      additionalFiles,
      schema.csv_id,
      localMountPath
    );

    code = retryCode;
    semanticVerdict = result.success ? validateExecutionResult(result) : null;
  }

  // Execution-level failure after exhausting retries → throw, same as
  // before. Semantic failures degrade gracefully (see below).
  if (!result.success) {
    const summary = priorAttempts
      .map((a, i) => `Attempt ${i + 1}: ${a.error.slice(0, 200).replace(/\n/g, " ")}`)
      .concat(`Attempt ${attempt + 1}: ${result.error.slice(0, 200).replace(/\n/g, " ")}`)
      .join("\n");
    throw new Error(
      `Analysis failed after ${MAX_RETRIES} retries.\n\n${summary}\n\nFinal error:\n${result.error}`
    );
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
  } = {}
): Promise<PipelineResult> {
  logger.debug("Re-executing edited code", {
    chars: code.length,
    localMount: !!options.localMountPath,
  });

  const result = await executeSandbox(
    csvContent,
    code,
    options.runtime,
    options.geojsonContent,
    options.additionalFiles,
    options.csvId,
    options.localMountPath
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
