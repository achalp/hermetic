/**
 * Runtime-agnostic sandbox output parsing — the shared contract for turning a
 * finished script run (exit code + files in the work dir) into an
 * ExecutionResult.
 *
 * This logic used to be copy-pasted across the four executors (Docker,
 * microsandbox, microsandbox-warm, E2B) and had drifted: only the Docker copy
 * detected OOM kills and returned the actionable lean-script guidance, so the
 * identical failure on another runtime burned the retry budget with a raw
 * stderr dump. It lives here now; each executor supplies a tiny `readFile`
 * adapter.
 */
import { z } from "zod";
import type { ExecutionResult } from "@/lib/contracts/execution";
import type { SkillFailureHint } from "@/lib/skills/types";
import { diagEvent } from "@/lib/diagnostics/run-diagnostics";
import { logger } from "@/lib/logger";

/**
 * The write_output envelope contract. Previously the parsed JSON was
 * cast-and-plucked (`(parsed.results as Record<string, unknown>) ?? {}`), so
 * a script emitting e.g. `results: "none"` or `datasets: [...]` flowed
 * typed-as-object into downstream code and errored far from the cause. A
 * shape violation now fails HERE with a precise message — which feeds the
 * existing code-retry loop, so the model fixes its write_output call.
 * Missing keys stay lenient (default {}); only wrong TYPES reject.
 */
const SandboxEnvelopeSchema = z.object({
  results: z.record(z.string(), z.unknown()).optional(),
  chart_data: z.record(z.string(), z.unknown()).optional(),
  // Base64 PNGs — a non-string value would render a broken <img>.
  images: z.record(z.string(), z.string()).optional(),
  // Named datasets, each a list of row objects.
  datasets: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
  // Declared-findings registry (spec §2.1) — RAW entries; zod would silently
  // strip an unlisted key, which is exactly how v1 of the spec lost every
  // declaration in review. Validation happens in lib/findings, not here.
  findings: z.array(z.unknown()).optional(),
  // Analysis-product declarations (spec §1) — RAW like findings; role/context
  // validation happens in lib/product, not here.
  series: z.array(z.unknown()).optional(),
  values: z.array(z.unknown()).optional(),
  // Declared-payload licensing (id, format) — the runtime emits these so the
  // host can license derived views (e.g. declare_dendrogram). Without the key
  // here zod silently stripped it and licensing was always empty (finding M2).
  payloads: z.array(z.object({ id: z.string(), format: z.string() })).optional(),
  // Regime profiles per declared series (regime-matrix spec §2) — RAW.
  regimes: z.record(z.string(), z.unknown()).optional(),
  data_completeness: z.unknown().optional(),
  runtime_fallback: z.string().nullable().optional(),
});

const NO_OUTPUT_ERROR =
  "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.";

/** The watchdog / assert_fits fast-fail marker — its stderr line already carries
 *  the precise, strategy-switching guidance, so surface that verbatim. */
const OOM_PREDICTED_MARKER = "HERMETIC_OOM_PREDICTED:";

/**
 * DOMAIN-AGNOSTIC OOM guidance only. The geo/planet-scale phase hints that
 * used to live here (polygon build, coarse grid scan, per-candidate leaf, the
 * scan-buffer hard-kill blob) are now `failureHints` on the geo built-in
 * skills — matched FIRST via `skillFailureHints`, and only when those skills
 * are actually active. That fixes a real misrouting: the scan-buffer hint
 * used to fire on ANY bare 137, telling a non-geo OOM about parquet grids.
 */
const MATERIALIZE_OOM_HINT =
  "The OOM struck while MATERIALIZING A DATAFRAME (.df()/read into pandas). A DuckDB relation that streams fine " +
  "explodes when .df() pulls it all into memory — worst with string/struct columns. Pull ONLY the numeric columns " +
  "you need, aggregate/COUNT in DuckDB so nothing large lands in pandas, and hydrate only the top-N winners' " +
  "attributes at the very end by id.";
/**
 * Bare hard kill (exit 137) with no watchdog marker, no skill hint, no phase
 * match. Generic by design — anything sharper is domain knowledge and belongs
 * on a skill. (Exit 137 is just SIGKILL: `containerGone` has already excluded
 * the external-kill case before this is reached.)
 */
const GENERIC_HARD_KILL_HINT =
  "Out of memory — a HARD kernel OOM-kill (exit 137) with NO pandas-side guard tripped (the .df() cap raises a " +
  "clean error, not 137; the memory watchdog would have tagged a phase). Something allocated past the container " +
  "cap outside pandas' view — commonly a huge N-sized PYTHON object (a dict/list/set built over ALL rows), a " +
  "wide in-memory index, or engine-side buffers on a very large scan. Push the heavy work into DuckDB " +
  "(filter/COUNT/GROUP BY stream and spill), pull only small aggregated results into pandas, index arrays by " +
  "position instead of building N-sized maps, and do NOT raise `SET threads` on large scans.";

/**
 * Active skills' hints are matched FIRST — a skill that knows its own failure
 * mode beats the generic router. `phase` may be undefined (a hard kill that
 * left no heartbeat): only a catch-all pattern like `^` matches then, which is
 * how planet-scale claims the bare-137 case on runs where it is active. Which
 * skill's hint fired is logged and recorded in the diag bundle so a retry that
 * went sideways can be traced to the guidance that steered it.
 */
function skillHintForPhase(
  phase: string | undefined,
  hints: SkillFailureHint[] | undefined,
  includeFallback: boolean
): SkillFailureHint | undefined {
  if (!hints?.length) return undefined;
  const p = phase ?? "";
  return hints.find((h) => {
    if (h.fallback && !includeFallback) return false;
    try {
      return new RegExp(h.pattern, "i").test(p);
    } catch {
      return false; // parse-time validation should prevent this; never throw here
    }
  });
}

function oomGuidanceForPhase(phase: string | undefined): string | undefined {
  const p = (phase ?? "").toLowerCase();
  if (!p) return undefined;
  if (/load|read|materializ|fetch|frame|pandas|\.df/.test(p)) return MATERIALIZE_OOM_HINT;
  return undefined;
}

/**
 * Recover the progress phase active when the OOM happened, in priority order:
 * (1) the watchdog marker's `[phase=...]` tag if the soft watchdog fired;
 * (2) the last `{"__progress": {...}}` line in stdout (readable only when the
 *     container survived the kill);
 * (3) the host-captured live phase — the ONLY source that survives a hard cgroup
 *     OOM-kill that reaps the container init (post-mortem file reads then blank).
 * A remote-scan OOM is almost always case (3): without it the phase router can't
 * fire and the retry gets the misleading generic pandas-OOM blob.
 */
function extractOomPhase(
  predictedLine: string | undefined,
  stdout: string,
  livePhase?: string
): string | undefined {
  const tagged = predictedLine?.match(/\[phase=([^\]]*)\]/);
  if (tagged?.[1]?.trim()) return tagged[1].trim();
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("__progress")) continue;
    try {
      const parsed = JSON.parse(lines[i]) as { __progress?: { phase?: unknown } };
      const ph = parsed.__progress?.phase;
      if (typeof ph === "string" && ph.trim()) return ph.trim();
    } catch {
      // Partial/interleaved line — keep scanning older ones.
    }
  }
  if (livePhase?.trim()) return livePhase.trim();
  return undefined;
}

/**
 * Parse JSON that may contain Python's non-finite float tokens (NaN,
 * Infinity, -Infinity), which are invalid JSON.
 *
 * Parse FIRST, and only fall back to the token→null regex when JSON.parse
 * throws. Bare NaN/Infinity always makes JSON.parse fail, so the fallback is
 * reliably reached when needed — while valid JSON containing strings like
 * "NaN Zhu" or "Infinity Ward" is returned untouched. (The old
 * regex-unconditionally approach corrupted those to "null Zhu"/"null Ward"
 * in user-visible results.) The fallback regex can still touch string
 * contents, but only on output that was not valid JSON to begin with.
 *
 * Throws like JSON.parse when the fallback can't parse either.
 */
export function parseJsonWithPythonNonFinite(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // NOTE: the sign must be folded into the Infinity pattern — the old
    // `\b-Infinity\b` NEVER matched (no word boundary between a space and
    // `-`), so `-Infinity` became `-null` and still failed to parse.
    return JSON.parse(text.replace(/\bNaN\b/g, "null").replace(/-?\bInfinity\b/g, "null"));
  }
}

export interface ParseSandboxOutputOpts {
  /** Read a file from the sandbox work dir; null when unreadable/absent. */
  readFile: (path: string) => Promise<string | null>;
  exitCode: number;
  executionMs: number;
  /** Directory holding script.py/output.json/stdout.txt/stderr.txt. */
  workDir?: string;
  /** Label for the debug log, e.g. "docker" | "microsandbox" | "e2b". */
  runtime: string;
  /** Fallback stderr text when the stderr file itself can't be read. */
  stderrFallback?: string;
  /**
   * Last progress phase the host captured LIVE off the stdout stream. Used as the
   * OOM-phase fallback: a hard cgroup OOM-kill can reap the container's init, so
   * the stdout progress heartbeat (written to /data on kill) reads back blank —
   * but the host retained this as it streamed. Without it, the phase router can't
   * fire and the retry gets the misleading generic pandas-OOM blob.
   */
  livePhase?: string;
  /** Resolved DuckDB config captured live off the stream — fallback for the diag
   *  line when the /data config file is unreadable after a hard kill. */
  liveDuckdbCfg?: string;
  /**
   * True when the executor probed the sandbox after exit and the container no
   * longer EXISTS. Exit 137 is just SIGKILL: a genuine OOM (even one that kills
   * the container's init) leaves the container behind for `docker inspect`,
   * while a vanished container means something external `rm -f`ed it mid-run.
   * Classifying that as OOM sends the retry loop chasing a phantom memory bug
   * (observed: 11 mid-scan reaper kills misdiagnosed as OOM across three runs).
   */
  containerGone?: boolean;
  /**
   * Phase-keyed OOM remedies contributed by the run's active skills, matched
   * ahead of the built-in phase router (executors fetch these from
   * run-control's per-run registry).
   */
  skillFailureHints?: SkillFailureHint[];
}

/** Externally removed mid-run — an infrastructure failure, NOT a code failure.
 *  No errorKind: the ordinary retry path re-runs; the text pins the approach. */
const EXTERNAL_KILL_ERROR =
  "The sandbox container was removed externally mid-run (exit 137, and the container no longer exists — " +
  "a genuine OOM kill would have left it inspectable). This is an infrastructure failure, NOT a memory " +
  "or code problem: do NOT restructure the analysis or add memory workarounds. Keep the exact same " +
  "approach and re-run it.";

/**
 * Classify an error THROWN by the sandbox runtime itself (SDK/daemon call
 * rejected, container create failed, transport error) — as opposed to a clean
 * non-zero exit, which parseSandboxOutput handles. A throw means the user's code
 * never ran or its result was lost, so re-generating code can't help: the retry
 * loop fast-fails on both kinds. A timeout string maps to "timeout" (the E2B SDK
 * throws on its own deadline); everything else is "infra" (finding M7 — a
 * thrown SDK timeout that didn't match /timed out/i previously burned the whole
 * retry budget re-running an environment failure).
 */
export function classifyThrownError(message: string): "timeout" | "infra" {
  return /timed?\s*out|timeout|deadline\s*exceeded/i.test(message) ? "timeout" : "infra";
}

export async function parseSandboxOutput(opts: ParseSandboxOutputOpts): Promise<ExecutionResult> {
  const workDir = opts.workDir ?? "/data";
  const executionMs = opts.executionMs;

  if (opts.exitCode !== 0) {
    const stderr =
      (await opts.readFile(`${workDir}/stderr.txt`)) ??
      opts.stderrFallback ??
      "Unknown execution error";
    // Preserve the evidence: stdout (partial progress prints) was previously
    // never read on failure, and after a successful retry the failed
    // attempt's output was gone entirely. The diagnostics JSONL keeps a
    // bounded head/tail per failure for post-mortems.
    const stdout = (await opts.readFile(`${workDir}/stdout.txt`)) ?? "";
    diagEvent("sandbox_failure", {
      runtime: opts.runtime,
      exitCode: opts.exitCode,
      stderrHead: stderr.slice(0, 500),
      stderrTail: stderr.length > 1000 ? stderr.slice(-500) : undefined,
      stdoutTail: stdout ? stdout.slice(-500) : undefined,
    });
    // Surface the prelude's self-reported DuckDB config to the console log so we
    // can SEE which settings actually applied in the container (e.g. threads and
    // whether the cap even took) — critical for diagnosing a scan OOM. Read from
    // the dedicated file (the prelude writes it there, NOT stderr — a stderr write
    // polluted other error handlers' output). Fall back to a stderr scan for an
    // old container that still emits it to stderr.
    const cfg =
      (await opts.readFile(`${workDir}/hermetic_duckdb_cfg.txt`))?.trim() ||
      `${stderr}\n${stdout}`
        .split("\n")
        .find((l) => l.includes("HERMETIC_DUCKDB_CFG"))
        ?.trim() ||
      // Host-captured live-stream fallback: survives a hard kill that blanks the
      // /data config file (container init reaped by the OOM-killer).
      (opts.liveDuckdbCfg ? `HERMETIC_DUCKDB_CFG: ${opts.liveDuckdbCfg}` : undefined);
    if (cfg) logger.info("Sandbox DuckDB config", { runtime: opts.runtime, config: cfg });

    // Post-mortem bundle saved to the run recorder (attempt-NN.diag.txt): the
    // config line survives a HARD-kill OOM here even when the container is torn
    // down before the console can surface it. `(not emitted)` is itself a signal —
    // it means the prelude's config block never ran.
    const phaseNow = extractOomPhase(
      stderr.split("\n").find((l) => l.includes(OOM_PREDICTED_MARKER)),
      stdout,
      opts.livePhase
    );
    const execDiag = [
      `exitCode=${opts.exitCode} phase=${phaseNow ?? "(unknown)"}`,
      cfg ?? "HERMETIC_DUCKDB_CFG: (not emitted — prelude config block did not run)",
      `--- stderr tail ---\n${stderr.slice(-1500)}`,
      `--- stdout tail ---\n${stdout.slice(-800)}`,
    ].join("\n");

    // External kill trumps every OOM heuristic: a vanished container cannot
    // have been a kernel OOM (that leaves the container inspectable), so none
    // of the memory guidance below applies — it would misdirect the retry.
    if (opts.exitCode === 137 && opts.containerGone) {
      logger.warn("Sandbox container vanished mid-run — external kill, not OOM", {
        runtime: opts.runtime,
      });
      return { success: false, error: EXTERNAL_KILL_ERROR, execution_ms: executionMs, execDiag };
    }

    if (opts.exitCode === 137 || /\bKilled\b/.test(stderr)) {
      const predicted = stderr
        .split("\n")
        .find((l) => l.includes(OOM_PREDICTED_MARKER))
        ?.trim();
      // Localize the OOM to the phase where memory peaked (watchdog tag, or the
      // last progress line on a hard kill) and feed a phase-SPECIFIC remedy. The
      // generic blob is unactionable when the code is already coordinates-only +
      // counting — the retry just reproduces the same shape.
      const phase = extractOomPhase(predicted, stdout, opts.livePhase);
      // Fallback (catch-all) skill hints only apply to a BARE kill — a
      // watchdog-predicted abort keeps its own strategy-switch message below.
      const skillHint = skillHintForPhase(phase, opts.skillFailureHints, !predicted);
      if (skillHint) {
        logger.info("Skill failure hint applied", {
          runtime: opts.runtime,
          skill: skillHint.skill,
          phase,
        });
        const lead = predicted
          ? "Predicted OOM — the watchdog aborted before the kernel OOM-kill."
          : "Out of memory — the analysis process was killed (OOM).";
        const error = `${lead}${phase ? ` Memory peaked during phase: "${phase}".` : ""}\n${skillHint.hint}`;
        return {
          success: false,
          error,
          errorKind: "oom",
          execution_ms: executionMs,
          execDiag: `hint=skill:${skillHint.skill}\n${execDiag}`,
        };
      }
      const phaseGuidance = oomGuidanceForPhase(phase);
      if (phaseGuidance) {
        const lead = predicted
          ? "Predicted OOM — the watchdog aborted before the kernel OOM-kill."
          : "Out of memory — the analysis process was killed (OOM).";
        const error = `${lead} Memory peaked during phase: "${phase}".\n${phaseGuidance}`;
        return { success: false, error, errorKind: "oom", execution_ms: executionMs, execDiag };
      }
      // No skill or phase hint matched. Route by the KILL SIGNATURE:
      //  • watchdog marker present → a real pandas-side climb the watchdog
      //    caught; its own text carries the strategy-switch guidance (plus any
      //    skill-set strategy hint the prelude wired in) — surface it verbatim.
      //  • bare 137, no marker → generic hard-kill guidance; anything sharper
      //    (e.g. the scan-buffer diagnosis) is domain knowledge and fires via
      //    the active skills' fallback hints above.
      if (predicted) {
        const base = predicted
          .slice(predicted.indexOf(OOM_PREDICTED_MARKER))
          .replace(/\[phase=[^\]]*\]\s*/, "");
        const error = phase ? `Memory peaked during phase: "${phase}".\n${base}` : base;
        return { success: false, error, errorKind: "oom", execution_ms: executionMs, execDiag };
      }
      const error = phase
        ? `Memory peaked during phase: "${phase}".\n${GENERIC_HARD_KILL_HINT}`
        : GENERIC_HARD_KILL_HINT;
      return { success: false, error, errorKind: "oom", execution_ms: executionMs, execDiag };
    }
    // Missing-package residue from a user/skill module — a USER-CONFIG error,
    // not a code error: no regenerated analysis code can conjure the package,
    // so the retry loop must fail fast with the same wording as the save-time
    // validation (spec §4.5 runtime backstop; save-time validation should make
    // this unreachable).
    const missingModule = stderr.match(/ModuleNotFoundError: No module named '([^']+)'/);
    if (missingModule && /\/data\/(user_lib|skill_lib)\//.test(stderr)) {
      logger.warn("Sandbox import failed inside a user/skill module — user-config error", {
        runtime: opts.runtime,
        missing: missingModule[1],
      });
      return {
        success: false,
        error:
          `A preloaded user/skill module needs the Python package '${missingModule[1]}', which is ` +
          `not available in the sandbox image. This is a configuration issue, not a code issue — ` +
          `remove the import from the module (or extend the sandbox image) and re-run.`,
        errorKind: "user-config",
        execution_ms: executionMs,
        execDiag,
      };
    }
    // A remote read that can't reach the network is an ENVIRONMENT failure (no
    // egress / DNS / endpoint down), not a code bug — regenerating code with the
    // same network config fails identically, so retrying just burns the budget.
    // Fail fast like timeout/oom. Scoped to connection/DNS phrases so a local
    // file IOException doesn't match.
    // Proxy-deny wordings (Python requests/urllib behind the egress gateway:
    // a blocked host surfaces as "Tunnel connection failed: 403", a dead
    // gateway as "Cannot connect to proxy" / ProxyError) classify the same
    // way — the sandbox's network path failed, not the generated code.
    if (
      /Could not establish connection|Connection refused|Could not resolve host|Name or service not known|Temporary failure in name resolution|Network is unreachable|Failed to connect to|Connection reset by peer|Tunnel connection failed|Cannot connect to proxy|ProxyError/i.test(
        stderr
      )
    ) {
      logger.warn("Sandbox could not reach the remote data source — network error", {
        runtime: opts.runtime,
      });
      return {
        success: false,
        error:
          "Could not reach the remote data source: the sandbox failed to connect to the data " +
          "endpoint (network/egress failure). This is an environment issue, not a code issue — " +
          "check the sandbox's network access and re-run.",
        errorKind: "network",
        execution_ms: executionMs,
        execDiag,
      };
    }
    return {
      success: false,
      error: stderr || "Unknown execution error",
      execution_ms: executionMs,
      execDiag,
    };
  }

  // Read output: prefer output.json (written by write_output), fall back to
  // stdout.txt (captured from print() via shell redirect).
  let outputJson: string | null = await opts.readFile(`${workDir}/output.json`);
  let outputSource = `file:${workDir}/output.json`;
  if (!outputJson?.trim()) {
    outputJson = await opts.readFile(`${workDir}/stdout.txt`);
    outputSource = `file:${workDir}/stdout.txt`;
  }
  if (!outputJson?.trim()) {
    return { success: false, error: NO_OUTPUT_ERROR, execution_ms: executionMs };
  }

  logger.debug("Sandbox executor output", {
    runtime: opts.runtime,
    source: outputSource,
    len: outputJson.length,
  });

  let parsed: unknown;
  try {
    // Parse first; only regex-sanitize Python NaN/Infinity when the strict
    // parse fails — see parseJsonWithPythonNonFinite for why.
    parsed = parseJsonWithPythonNonFinite(outputJson);
  } catch {
    return {
      success: false,
      error: `Failed to parse output as JSON. Output was: ${outputJson.slice(0, 500)}`,
      execution_ms: executionMs,
    };
  }

  const envelope = SandboxEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    const issues = envelope.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      success: false,
      error:
        `Output JSON has the wrong shape for write_output — ${issues}. ` +
        `Expected: results (object), chart_data (object), datasets (object of row-object arrays), images (object of base64 strings).`,
      execution_ms: executionMs,
    };
  }

  return {
    success: true,
    results: envelope.data.results ?? {},
    chart_data: envelope.data.chart_data ?? {},
    images: envelope.data.images ?? {},
    datasets: envelope.data.datasets as Record<string, Record<string, unknown>[]> | undefined,
    ...(envelope.data.findings ? { findings: envelope.data.findings } : {}),
    ...(envelope.data.series ? { series: envelope.data.series } : {}),
    ...(envelope.data.values ? { values: envelope.data.values } : {}),
    ...(envelope.data.payloads ? { payloads: envelope.data.payloads } : {}),
    ...(envelope.data.regimes ? { regimes: envelope.data.regimes } : {}),
    // These two were validated but never returned — run-ask-query's
    // completeness lints and runtime-fallback surfacing read them off the
    // execution result, so dropping them here silently disabled both.
    ...(envelope.data.data_completeness !== undefined
      ? { data_completeness: envelope.data.data_completeness }
      : {}),
    ...(envelope.data.runtime_fallback !== undefined
      ? { runtime_fallback: envelope.data.runtime_fallback }
      : {}),
    execution_ms: executionMs,
  };
}
