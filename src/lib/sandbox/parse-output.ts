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
import type { ExecutionResult } from "@/lib/types";
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
});

const NO_OUTPUT_ERROR =
  "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.";

/** The watchdog / assert_fits fast-fail marker — its stderr line already carries
 *  the precise, strategy-switching guidance, so surface that verbatim. */
const OOM_PREDICTED_MARKER = "HERMETIC_OOM_PREDICTED:";

/**
 * Phase-keyed OOM guidance. A generic pandas-OOM blob ("drop string columns /
 * switch to counting") is a MISDIAGNOSIS for the planet-scale spatial path: that
 * code is ALREADY coordinates-only and counting, so the retry reproduces the same
 * shape (observed: attempt-02 ≡ attempt-01). The watchdog tags the abort with the
 * progress phase where memory peaked; a hard kernel kill leaves the last phase in
 * stdout or (when the container is reaped) in the host-captured livePhase.
 * Matching that phase to WHERE the memory went yields a fix the model can act on.
 * Returns undefined when the phase doesn't match a known pattern → caller falls
 * back to the verbatim marker (predicted) or the scan-side hard-kill hint.
 */
const POLYGON_OOM_HINT =
  "The OOM struck while BUILDING THE REGION/BOUNDARY POLYGON. ST_Union_Agg over a country/large-region " +
  "multipolygon decodes the single fattest geometry on the continent (millions of vertices) into memory. " +
  "FIXES: (1) simplify HARD — ST_Simplify(ST_Union_Agg(geometry), 0.01) (~1 km) or 0.02 for a whole country, " +
  "NOT 0.001. (2) bbox-prefilter the division rows to the target extent BEFORE the union so less geometry is " +
  "decoded. (3) You only need the polygon to EXCLUDE neighbouring countries when testing cell centroids — a " +
  "coarse simplified hull suffices; never union raw full-detail geometry.";
const GRID_OOM_HINT =
  "The OOM struck during the COARSE GRID COUNT/SCAN. TWO independent causes: (A) DuckDB's own PARALLEL SCAN " +
  "buffers over a billions-row REMOTE parquet scan — memory_limit does NOT bound the per-thread row-group " +
  "read/decompress buffers, so a default all-cores scan blows the cap even though the GROUP BY output is tiny. " +
  "The sandbox already SETs a low `threads` + `preserve_insertion_order=false` for this — do NOT raise `SET " +
  "threads`, and if you did, remove it. (B) The cell size may be too FINE for the region span (a fixed 10 km " +
  "cell over a ~5,000 km continent makes ~25x more cells): scale it — s = max(span_m/200, 2000). Keep the GROUP " +
  "BY streaming (never pull raw buildings into pandas); if the cells frame is still millions of rows, coarsen s.";
const LEAF_OOM_HINT =
  "The OOM struck during the PER-CANDIDATE LEAF / nearest-neighbour read. Do NOT read a whole ring of buildings " +
  "into pandas and do NOT accumulate rings across candidates — an isolated point's nearest neighbour can be a " +
  "dense metro edge, so its ring overlaps millions of rows. Compute the neighbour distance INSIDE DuckDB as a " +
  "bounded aggregate (SELECT min(ST_Distance_Sphere(...)) over a small bbox window), pulling only ONE scalar per " +
  "candidate. Never build a cKDTree over the buildings in a ring.";
const MATERIALIZE_OOM_HINT =
  "The OOM struck while MATERIALIZING A DATAFRAME (.df()/read into pandas). A DuckDB relation that streams fine " +
  "explodes when .df() pulls it all into memory — worst with string/struct columns. Pull ONLY the numeric columns " +
  "you need, aggregate/COUNT in DuckDB so nothing large lands in pandas, and hydrate only the top-N winners' " +
  "attributes at the very end by id.";
/**
 * Hard KERNEL OOM-kill (exit 137) with NO watchdog marker and no phase match.
 * Both pandas-side guards leave a signature: the `.df()` hard cap raises a clean
 * `MemoryError` (exit 1, not 137), and the memory watchdog writes the
 * HERMETIC_OOM_PREDICTED marker before exiting. A bare 137 that tripped NEITHER
 * is therefore almost never the pandas side — it is the DuckDB parallel-scan
 * buffers over a billions-row REMOTE parquet, which `memory_limit` does not
 * bound. The generic pandas-OOM blob ("pull only coordinates / switch to
 * counting") MISDIAGNOSES this: the code is usually already counting, so the
 * retry rearranges the (correct) pandas side and re-OOMs — OBSERVED: two
 * successive 137 kills on a USA most-isolated run, each reshuffling an
 * already-memory-safe pipeline. Point the retry at the actual sink.
 *
 * CAVEAT on that observation: exit 137 is just SIGKILL — an external
 * `docker rm -f` (a cleanup path, Docker itself) produces the IDENTICAL bare-137
 * signature, and the 2026-07 "scan-buffer OOM" runs were in fact the store
 * sweeper reaping live containers. `containerGone` now excludes that case
 * BEFORE any OOM classification: a genuine OOM (process- or init-level) leaves
 * the container inspectable, while an externally removed one is gone.
 */
const HARD_KILL_SCAN_HINT =
  "Out of memory — a HARD kernel OOM-kill (exit 137) with NO pandas-side guard tripped (the .df() cap raises a " +
  "clean error, not 137; the memory watchdog would have tagged a phase). That signature means the memory sink is " +
  "NOT your pandas code — it is almost certainly DuckDB's PARALLEL SCAN BUFFERS over the billions-row remote " +
  "parquet: memory_limit does NOT bound the per-thread row-group read/decompress buffers, so the scan itself blows " +
  "the cap even when your GROUP BY output and KD-tree are tiny. So do NOT (again) trim columns, re-verify " +
  "coordinates-only, or restructure the candidate/branch-and-bound logic — that side is already fine. Instead: " +
  "(1) COARSEN the grid so fewer/larger cells stream through — s = max(span_m/300, 2000) rather than a fine fixed " +
  "cell; (2) keep every heavy step in DuckDB (COUNT/GROUP BY streams and spills) and pull only the tiny survivor " +
  "set into pandas; (3) do NOT add `SET threads=<high>` — the sandbox already caps scan threads low for exactly " +
  "this reason. If you genuinely just built a huge N-sized PYTHON object (a dict/list over ALL rows, e.g. to label " +
  "a map sample) that is the one pandas-side way to hard-kill — index by position instead, never build an N-sized map.";

/**
 * Active skills' hints are matched FIRST — a skill that knows its own failure
 * mode beats the generic built-in router. Which skill's hint fired is logged
 * and recorded in the diag bundle so a retry that went sideways can be traced
 * to the guidance that steered it.
 */
function skillHintForPhase(
  phase: string | undefined,
  hints: SkillFailureHint[] | undefined
): SkillFailureHint | undefined {
  if (!phase || !hints?.length) return undefined;
  return hints.find((h) => {
    try {
      return new RegExp(h.pattern, "i").test(phase);
    } catch {
      return false; // parse-time validation should prevent this; never throw here
    }
  });
}

function oomGuidanceForPhase(phase: string | undefined): string | undefined {
  const p = (phase ?? "").toLowerCase();
  if (!p) return undefined;
  if (/polygon|boundary|union|simplif|region|dissolve|divisions?/.test(p)) return POLYGON_OOM_HINT;
  if (/leaf|neighbou?r|nearest|hydrat|candidate|winner/.test(p)) return LEAF_OOM_HINT;
  if (/cell|grid|coarse|group|bucket|count|superlativ/.test(p)) return GRID_OOM_HINT;
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
      const skillHint = skillHintForPhase(phase, opts.skillFailureHints);
      if (skillHint) {
        logger.info("Skill failure hint applied", {
          runtime: opts.runtime,
          skill: skillHint.skill,
          phase,
        });
        const error = `Out of memory — the analysis process was killed (OOM). Memory peaked during phase: "${phase}".\n${skillHint.hint}`;
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
      // No phase-specific hint matched. Route by the KILL SIGNATURE:
      //  • watchdog marker present → a real pandas-side climb the watchdog caught;
      //    its own text already carries the strategy-switch guidance — surface it.
      //  • bare 137, no marker → neither pandas guard tripped, so it's the DuckDB
      //    scan buffers, NOT pandas. The generic pandas blob is a misdiagnosis
      //    here (it sends the retry to reshuffle already-correct code); point at
      //    the scan instead. Still prepend the phase when we have one.
      if (predicted) {
        const base = predicted
          .slice(predicted.indexOf(OOM_PREDICTED_MARKER))
          .replace(/\[phase=[^\]]*\]\s*/, "");
        const error = phase ? `Memory peaked during phase: "${phase}".\n${base}` : base;
        return { success: false, error, errorKind: "oom", execution_ms: executionMs, execDiag };
      }
      const error = phase
        ? `Memory peaked during phase: "${phase}".\n${HARD_KILL_SCAN_HINT}`
        : HARD_KILL_SCAN_HINT;
      return { success: false, error, errorKind: "oom", execution_ms: executionMs, execDiag };
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
    execution_ms: executionMs,
  };
}
