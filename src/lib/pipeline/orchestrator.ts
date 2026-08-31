import { generateAnalysisCode, postProcessGeneratedCode } from "@/lib/llm/code-generation";
import { buildRetryPromptMulti, RETRY_GUIDANCE, buildCodeGenSystemPrompt } from "@/lib/llm/prompts";
import { pythonErrorSummary } from "@/lib/sandbox/parse-output";
import { activateSkills, reportSkillActivation } from "@/lib/skills";
import { userModuleFiles } from "@/lib/skills/user-modules";
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
import { redactRemoteSecrets, applyRemoteAuth } from "@/lib/parquet/duckdb-source";
import type { RemoteAuthSubst } from "@/lib/parquet/duckdb-source";
import { estimateRun, reportEstimate } from "@/lib/pipeline/estimate";
import { streamText } from "ai";
import { withPhaseSync } from "@/lib/cost/accumulator";
import {
  getRunSignal,
  isRunStopped,
  setRunFailureHints,
  ambientSandboxHooks,
  ambientWasmExecutor,
} from "@/lib/pipeline/run-control";
import { getPurposeCodegenScope } from "@/lib/purpose-prompts";
import { getRunId } from "@/lib/run-context";
import { envConfig } from "@/lib/harness-slot";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { llmReplayConfig } from "@/lib/llm/replay";
import { retrieveExemplar } from "@/lib/learning/exemplars";
import { harvestRun } from "@/lib/learning/harvest";
import { reviewGeneratedCode } from "@/lib/pipeline/code-review";
import { getActiveModels } from "@/lib/runtime-config";
import { CODE_REVIEW_MODEL, MAX_REVIEW_REDOS, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { CSVSchema, SchemaMode } from "@/lib/contracts/data-schema";
import type { ConversationTurn } from "@/lib/contracts/storage-types";
import { logger, errMessage } from "@/lib/logger";
import {
  validateExecutionResult,
  formatSemanticVerdictForRetry,
} from "@/lib/pipeline/result-validator";

// PipelineResult now lives in contracts (contracts/pipeline.ts) so llm/
// modules can reference it without importing this pipeline module. Re-exported
// here because existing consumers import it from the producer.
import type { PipelineResult } from "@/lib/contracts/pipeline";
export type { PipelineResult };

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
  /** WASM-only: host files the worker fetches into its FS (build log D13). */
  wasmFetchInputs?: { workerPath: string; hostPath: string }[];
  /** DuckDB range-token aliases for a multi-file remote source (build log D21). */
  wasmDuckDbAliases?: { name: string; url: string }[];
  purpose?: string;
  /**
   * Real S3 credentials to splice into generated code at the sandbox boundary
   * (finding C1). The prompt carries only placeholders; this restores them into
   * the executed copy — never into the code retained for retry prompts or the
   * forensic record.
   */
  remoteAuthSubst?: RemoteAuthSubst;
  /**
   * Explicit docker egress allowlist. Set for multi-entity manifest questions
   * (the union of the selected entities' hosts — revised host policy
   * 2026-08-31); absent, remote runs derive the single-source host as before.
   */
  allowedEgressHosts?: string[];
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
    model = getActiveModels().codeGen,
    runtime,
    geojsonContent,
    workbookContext,
    localMountPath,
    localFileContext,
    priorTurns,
    inputParquetPath,
    wasmFetchInputs,
    wasmDuckDbAliases,
    purpose,
    remoteAuthSubst,
    allowedEgressHosts,
  } = options;
  // Mutable: active skills append their helper modules below.
  let additionalFiles = options.additionalFiles;
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

  // The container's real memory ceiling (memoized) — shared by the codegen
  // prompt, the geo guidance, and the review critic so all three reason against
  // the SAME cap. Hoisted so the retry loop / review redo reuse it.
  const memLabel = await getSandboxMemoryLimitGbLabel();
  // Activate skills ONCE per run (deterministic for a given schema+question, so
  // every retry shares the same prompt prefix). The active set drives all four
  // skill surfaces: codegen guidance (schema-triggered text flows through the
  // cached schema block via buildGeospatialGuidance; question-triggered text
  // rides the un-cached tail below), the review gate + its extra rules, and the
  // sandbox failure-hint router (via run-control). Activation is logged to the
  // console, the diagnostics journal, and data/runs/<id>/skills.json.
  const activeSkills = activateSkills({ schema, question });
  reportSkillActivation(activeSkills);
  setRunFailureHints(activeSkills.failureHints);
  // Ship active skills' helper modules and the user's data/user_lib modules
  // with every execution of this run (initial + retries share this local).
  // Guidance / the schema block advertise the import paths.
  const shippedModules = [...activeSkills.helperFiles, ...userModuleFiles()];
  if (shippedModules.length > 0) {
    additionalFiles = [...(additionalFiles ?? []), ...shippedModules];
  }
  // Skill prelude fragments run AFTER the shared prelude and BEFORE the
  // generated code (e.g. planet-scale wires its strategy hint onto the memory
  // guards). Prepended at execution time so post-processing and the recorded
  // attempt code stay the raw generated script.
  const skillPrelude =
    activeSkills.preludeSnippets.length > 0 ? activeSkills.preludeSnippets.join("\n") + "\n" : "";
  const skillRenderCtx = { schema, sandboxMemoryGb: memLabel };
  // Gate the pre-execution review to skills that ask for it (the geo/heavy path
  // built-ins do): that is where the OOM / memory-cap / prefer-engine failures
  // live and where a 15-min remote scan makes a few-thousand-token critic
  // obviously worth it. A plain CSV question activates nothing → never pays.
  const reviewEnabled = activeSkills.reviewGated;
  let questionGuidance = activeSkills.questionGuidance(skillRenderCtx);
  // Verified exemplar (learning-loops spec #3): working code from a previous
  // successful run over a similar schema/question, appended to the UN-CACHED
  // question tail (it varies per question — must never enter the cached
  // prefix). Skipped under replay so the recorded fixture surface stays
  // byte-stable; retrieval is local and deterministic.
  if (!llmReplayConfig() && !envConfig().VITEST) {
    const exemplar = await retrieveExemplar({
      question,
      columns: schema.columns.map((c) => ({ name: c.name, dtype: c.dtype })),
      detectedDomain: schema.detected_domain ?? null,
      activeSkills: activeSkills.skills.map((s) => s.def.name),
    }).catch(() => null);
    if (exemplar) {
      logger.debug("Learning: exemplar injected into code-gen tail", {
        exemplarRunId: exemplar.runId,
        attempts: exemplar.attempts,
      });
      questionGuidance +=
        `\n## Verified exemplar (previous successful analysis, similar schema/question)\n` +
        `A prior run answering "${exemplar.question}" on a matching schema executed, ` +
        `validated, and grounded with this code — ADAPT its approach to the current ` +
        `question; do not copy blindly:\n\`\`\`python\n${exemplar.code.slice(0, 6000)}\n\`\`\`\n`;
    }
  }

  // The system-prompt tail shared by every fix/retry generation (active skill
  // guidance — BOTH placements, retries are uncached anyway — + purpose scope +
  // local-file note). Computed lazily so it always reflects the hoisted memLabel.
  const retrySystemExtra = () => {
    const guidance = [activeSkills.prefixGuidance(skillRenderCtx), questionGuidance]
      .filter(Boolean)
      .join("\n");
    return (
      (localFileContext ? `\n\nIMPORTANT: ${localFileContext}` : "") +
      (guidance ? `\n${guidance}` : "") +
      (purpose ? `\n\n${getPurposeCodegenScope(purpose)}` : "")
    );
  };

  // Regenerate code from a history of prior (code, error) pairs — used by both
  // the execution-retry loop and the review redo (a severe review is just
  // another kind of "error" fed back to the model). Applies the same
  // post-generation fixups as the initial codegen.
  const generateFixedCode = async (
    priorAttempts: { code: string; error: string }[]
  ): Promise<string> => {
    // Stream (see generateAnalysisCode): stall-detected + /stop-killable.
    const retryResult = withPhaseSync("code_gen", () =>
      streamText({
        model: getModel(model),
        // FULL codegen constitution + repair addendum — NOT a stripped fixer
        // prompt. Observed twice on the covid dataset: a redo running with
        // only "fix the code" + feedback in context produced a hastier draft
        // that satisfied the findings but LOST rule-driven refinements the
        // first pass had (the like-for-like YoY, the headline set) — the
        // rules weren't in its context, so it couldn't know they were
        // deliberate. Repair must happen under the same rules as the draft.
        system: cachedSystem(
          buildCodeGenSystemPrompt(mode, !!workbookContext, schema.detected_domain, purpose) +
            "\n\n## REPAIR MODE\nYou are fixing the Python analysis code below based on the error/review history. Repair with a MINIMAL DIFF: change ONLY what the reported findings require and preserve every other line — key names, finding declarations, windowed comparisons, rounding, and refinements of the prior attempt stay VERBATIM. A rewrite that satisfies the findings but loses working refinements is a regression. The code must still write its JSON output to /data/output.json (not print to stdout). Output ONLY the corrected Python code. No markdown fencing.\n\n" +
            RETRY_GUIDANCE +
            retrySystemExtra()
        ),
        prompt: buildRetryPromptMulti(priorAttempts, schema),
        temperature: 0,
        maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
        abortSignal: getRunSignal(),
      })
    );
    const retryText = await retryResult.text;
    // Same repairs as the first generation, from the SAME function — this was a
    // hand-copied duplicate of that chain, which is how a retry could silently
    // repair code differently from the attempt it was fixing.
    return postProcessGeneratedCode(retryText, schema, {
      hasDataLocation: Boolean(localFileContext),
    });
  };

  // Deterministic checks-presence gate (declared-checks spec §2): whether
  // the model writes GOOD checks is the reviewer's judgment call; whether it
  // wrote ANY is a string search — and check presence must not be at the
  // mercy of model variability (run-24: 33 findings, 0 checks). One targeted
  // redo; if the model still declines, proceed (posture: never block) and
  // the manifest-level advisory takes over.
  const ensureChecksDeclared = async (currentCode: string): Promise<string> => {
    if (!currentCode.includes("declare_finding(") || currentCode.includes("declare_check(")) {
      // Journal the NON-firing case too (perf P11): the redo below is a full
      // code-gen round-trip (~10-40s, serial, before the sandbox), and whether
      // it is worth optimizing hinges entirely on how often it fires. Recording
      // both outcomes makes the trigger RATE greppable from journals:
      //   grep -h checks_redo data/runs/*/journal.jsonl | jq .fired
      recordRunEvent({ type: "checks_redo", fired: false });
      return currentCode;
    }
    logger.info("Generated code declares findings but zero checks — targeted redo");
    const redoStart = Date.now();
    try {
      return await generateFixedCode([
        {
          code: currentCode,
          error:
            "The code declares findings but ZERO checks. The declared-checks contract requires interrogating the data BEFORE analysis with declare_check(name, definition, passed, evidence={...}) — checks derived from domain knowledge of THIS dataset (completeness/coverage stability, magnitude plausibility, grain/hierarchy, join-vs-shortcut agreement, window comparability, model-form fit), with COMPUTED evidence. Add the checks that validate this code's semantic decisions and keep everything else verbatim.",
        },
      ]).then((redone) => {
        recordRunEvent({ type: "checks_redo", fired: true, ms: Date.now() - redoStart });
        return redone;
      });
    } catch {
      recordRunEvent({
        type: "checks_redo",
        fired: true,
        failed: true,
        ms: Date.now() - redoStart,
      });
      return currentCode;
    }
  };

  // Pre-execution "lint critic": review the code BEFORE running it and, on ANY
  // finding, feed ALL of them back for a fix-everything redo — the critic's
  // severity calibration proved unreliable (a "minor — won't OOM" finding caused
  // a 16-min OOM), so we no longer trust it to gate the redo. Severity is still
  // recorded in the journal for forensics. Bounded by MAX_REVIEW_REDOS. No-op off
  // the geo path, and fail-open (a broken critic returns "none" and never blocks).
  const reviewAndRevise = async (currentCode: string): Promise<string> => {
    if (!reviewEnabled) return currentCode;
    let code = currentCode;
    for (let redo = 0; redo <= MAX_REVIEW_REDOS; redo++) {
      onStage?.("reviewing_code");
      const review = await reviewGeneratedCode(
        code,
        question,
        memLabel,
        CODE_REVIEW_MODEL,
        activeSkills.reviewRules
      );
      recordRunEvent({
        type: "review",
        attempt: attemptIndex,
        severity: review.severity,
        findings: review.findings,
      });
      if (review.severity === "none" || redo === MAX_REVIEW_REDOS) {
        if (review.severity !== "none")
          logger.info("Code review still flagged issues after redo budget — running anyway", {
            attempt: attemptIndex,
            findings: review.findings.map((f) => f.rule),
          });
        return code;
      }
      logger.info("Code review flagged issues — regenerating before execution", {
        attempt: attemptIndex,
        findings: review.findings.map((f) => `${f.severity}/${f.rule}: ${f.message}`),
      });
      onStage?.("revising_code");
      try {
        code = await generateFixedCode([{ code, error: review.feedback }]);
      } catch (err) {
        // Redo generation failed — run the code we already have rather than abort.
        logger.warn("Review redo generation failed — executing pre-review code", {
          error: errMessage(err),
        });
        return code;
      }
    }
    return code;
  };

  // Step 1: Generate analysis code
  onStage?.("generating_code");
  // A transient CLI/backend stall on the FIRST code-gen call would otherwise kill
  // the whole run — the execution-retry loop below only kicks in AFTER a
  // successful codegen. Retry once on a transport failure (streaming's stall
  // timeout now surfaces a hang in minutes, not the old 10-min wall clock), but
  // NEVER after a user /stop — that abort is intentional.
  const MAX_CODEGEN_ATTEMPTS = 2;
  let code: string | undefined;
  let lastCodegenErr: unknown;
  for (let a = 1; a <= MAX_CODEGEN_ATTEMPTS; a++) {
    try {
      code = await generateAnalysisCode(
        schema,
        question,
        mode,
        model,
        workbookContext,
        localFileContext,
        priorTurns,
        purpose,
        // Question-triggered skill guidance rides the un-cached question tail
        // (schema-triggered guidance is already inside the cached schema block).
        questionGuidance || undefined,
        // llm/ never imports the run registry — the pipeline caller supplies
        // the stop signal (same injection rule as ambientSandboxHooks).
        { abortSignal: getRunSignal() }
      );
      break;
    } catch (err: unknown) {
      lastCodegenErr = err;
      if (isRunStopped()) break; // user cancelled — do not retry a stop
      if (a < MAX_CODEGEN_ATTEMPTS) {
        const m = errMessage(err);
        logger.warn("Initial code-gen failed — retrying once", {
          attempt: a,
          error: m.slice(0, 200),
        });
        recordRunEvent({ type: "codegen_retry", attempt: a, error: m.slice(0, 200) });
      }
    }
  }
  if (code === undefined) {
    const err = lastCodegenErr;
    const msg = errMessage(err);
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

  // Pre-execution review gate: catch OOM / memory-cap / wrong-region defects and
  // redo BEFORE spending a 15-min remote scan on them. No-op off the geo path.
  code = await ensureChecksDeclared(code);
  code = await reviewAndRevise(code);

  // Persist the code BEFORE executing — an OOM/crash during the run must not lose it.
  // (Records the post-review code — the exact bytes that will run.) Scrub S3
  // secret literals first (finding M1): a remote-auth script embeds KEY_ID/SECRET
  // values that must not land in a persisted run record or the debug log below.
  recordAttemptCode(attemptIndex, redactRemoteSecrets(code));

  // Step 2: Execute in sandbox
  logger.debug("Generated code", { chars: code.length, localMount: !!localMountPath });
  if (localMountPath) {
    logger.info("Local file execution", { localMountPath, fullCode: redactRemoteSecrets(code) });
  } else if (codeDoesRemoteIo(code)) {
    logger.info("Remote cloud execution", { fullCode: redactRemoteSecrets(code) });
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
  // applyRemoteAuth restores real S3 creds into the EXECUTED copy only; `code`
  // itself keeps placeholders so retry prompts and the forensic record stay
  // cred-free (finding C1).
  let result = await executeSandbox(
    csvContent,
    skillPrelude + applyRemoteAuth(code, remoteAuthSubst),
    {
      runtime,
      geojsonContent,
      additionalFiles,
      csvId: schema.csv_id,
      localMountPath,
      inputParquetPath,
      wasmFetchInputs,
      wasmDuckDbAliases,
      allowedEgressHosts,
      hooks: ambientSandboxHooks(),
      wasmExecutor: ambientWasmExecutor(),
      // Container attribution label — like hooks, injected here because the
      // sandbox layer never reads run-context itself.
      runId: getRunId(),
    }
  );
  recordAttemptOutcome(attemptIndex, {
    success: result.success,
    error: result.success ? undefined : result.error,
    errorKind: result.success ? undefined : result.errorKind,
    executionMs: result.execution_ms,
    hasResults: result.success && !!result.results,
    execDiag: result.success ? undefined : result.execDiag,
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
      // regenerate and re-run something the user just cancelled. Same for
      // "user-config" (a preloaded user/skill module needs a package the
      // sandbox image lacks): no regenerated code can fix configuration.
      // "network" joins the fast-fail set: a remote source the sandbox can't
      // reach (no egress / DNS / endpoint down) is an environment failure, and
      // regenerating code against the same network config fails identically.
      // "infra" too: the runtime itself THREW (SDK/daemon/transport) so the code
      // never ran — regenerating it can't help (finding M7).
      if (
        result.errorKind === "timeout" ||
        result.errorKind === "stopped" ||
        result.errorKind === "user-config" ||
        result.errorKind === "network" ||
        result.errorKind === "infra" ||
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
      // Same reason as the executor's log: the head of a traceback never says
      // what failed, so a reader watching retries scroll by learned nothing.
      errorPreview: pythonErrorSummary(retryError),
    });
    void recordFailure({
      stage: "code-exec",
      attempt,
      kind: result.success ? "semantic" : "execution",
      step: question,
      errorText: retryError,
      // A semantic failure already carries the producer's stable class — pass
      // it as errorClass so classifyFailure uses it directly instead of
      // regexing the human `reason` prose (an execution failure has no such
      // code, so it falls through to the traceback classifier).
      errorClass: semanticVerdict && !semanticVerdict.ok ? semanticVerdict.code : undefined,
    });

    // Regenerate from the full history of prior (code, error) pairs. The geo
    // recipe / purpose scope is re-injected via retrySystemExtra() inside the
    // shared helper — without it a retry rebuilt from scratch drops the spatial
    // guidance and "repairs" a superlative by downsampling.
    let retryCode: string;
    try {
      retryCode = await generateFixedCode(priorAttempts);
      // Gate the retry the same way as the initial code: review + redo before the
      // (expensive) re-execution, so a retry doesn't reintroduce an OOM pattern.
      retryCode = await reviewAndRevise(retryCode);
    } catch (err) {
      // LLM call itself failed — surface the underlying error since
      // that's what the user actually cares about diagnosing.
      const llmErr = errMessage(err);
      const lastSandboxErr = result.success
        ? "(execution succeeded but result was degenerate)"
        : result.error;
      throw new Error(
        `Analysis failed and retry LLM call also failed.\nLast sandbox error: ${lastSandboxErr}\nLLM error: ${llmErr}`
      );
    }

    attemptIndex++;
    recordAttemptCode(attemptIndex, redactRemoteSecrets(retryCode));

    onStage?.("executing");
    result = await executeSandbox(
      csvContent,
      skillPrelude + applyRemoteAuth(retryCode, remoteAuthSubst),
      {
        runtime,
        geojsonContent,
        additionalFiles,
        csvId: schema.csv_id,
        localMountPath,
        inputParquetPath,
        wasmFetchInputs,
        wasmDuckDbAliases,
        allowedEgressHosts,
        hooks: ambientSandboxHooks(),
        wasmExecutor: ambientWasmExecutor(),
        runId: getRunId(),
      }
    );
    recordAttemptOutcome(attemptIndex, {
      success: result.success,
      error: result.success ? undefined : result.error,
      errorKind: result.success ? undefined : result.errorKind,
      executionMs: result.execution_ms,
      hasResults: result.success && !!result.results,
      execDiag: result.success ? undefined : result.execDiag,
    });

    code = retryCode;
    semanticVerdict = result.success ? validateExecutionResult(result) : null;
  }

  // Persist the final code + outcome regardless of success/degraded/failure, so
  // the run's record is complete even when history saves only a stub.
  recordRunArtifact("code.py", code);
  recordRunEvent({ type: "final", success: result.success, attempts: attemptIndex });
  // Learning harvest (learning-loops spec): failures → ledger candidates
  // (graduation → proposal), verified success → exemplar bank. Fire-and-forget
  // — the loop must never delay or fail the run's own epilogue. "Verified"
  // means executed AND semantically valid (a degenerate-output success would
  // poison the bank with garbage exemplars).
  void harvestRun({
    runId: getRunId() ?? "unknown",
    question,
    schema,
    activeSkills: activeSkills.skills.map((s) => s.def.name),
    failedAttempts: priorAttempts,
    finalCode: code,
    success: result.success && (semanticVerdict?.ok ?? true),
  });
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
    // A user Stop is not a failure — surface the plain stop message, never
    // "Analysis failed after N attempts" with the cancellation buried in an
    // attempt log the user has to read to learn they did this themselves.
    if (result.errorKind === "stopped") {
      throw new Error(result.error || "Analysis stopped.");
    }
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
    /** Real S3 creds spliced into the executed copy only (finding C1). */
    remoteAuthSubst?: RemoteAuthSubst;
    /** Explicit docker egress allowlist (multi-host manifest questions). */
    allowedEgressHosts?: string[];
  } = {}
): Promise<PipelineResult> {
  logger.debug("Re-executing edited code", {
    chars: code.length,
    localMount: !!options.localMountPath,
    parquet: !!options.inputParquetPath,
  });

  const result = await executeSandbox(csvContent, applyRemoteAuth(code, options.remoteAuthSubst), {
    runtime: options.runtime,
    geojsonContent: options.geojsonContent,
    additionalFiles: options.additionalFiles,
    csvId: options.csvId,
    localMountPath: options.localMountPath,
    inputParquetPath: options.inputParquetPath,
    allowedEgressHosts: options.allowedEgressHosts,
    hooks: ambientSandboxHooks(),
    wasmExecutor: ambientWasmExecutor(),
    runId: getRunId(),
  });

  if (!result.success) {
    throw new Error(result.error || "Edited code failed to execute.");
  }

  return {
    executionResult: result,
    generatedCode: code,
    question,
  };
}
