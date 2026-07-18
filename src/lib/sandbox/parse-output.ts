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

/**
 * OOM guidance: exit 137 = SIGKILL, and a bare "Killed" is the classic
 * out-of-memory signature (the kernel OOM-killer reaps the process). Surface
 * it as OOM with actionable guidance so the retry writes a leaner script
 * instead of guessing.
 */
const OOM_ERROR =
  "Out of memory — the analysis process was killed (OOM). Do NOT load millions of rows into pandas. " +
  "TWO CASES: (1) If you pulled ATTRIBUTE/string columns (id, names, class, height) into the frame, " +
  "that is the OOM — pull ONLY numeric coordinates (SELECT rowid, lon, lat) into the KD-tree and hydrate " +
  "the top-N winners afterward by rowid. (2) If you were ALREADY coordinates-only and still OOM'd, N is too " +
  "large for an in-memory KD-tree (coordinates-only does not fit past ~30M because cKDTree.query allocates " +
  "two more N-sized arrays) — do NOT retry the direct approach with fewer columns. SWITCH to the DOESN'T-FIT " +
  "counting strategy: COUNT per grid cell in DuckDB (GROUP BY, nothing lands in pandas), branch-and-bound, " +
  "then pull only the sparse survivor set. Call assert_fits(N) after your COUNT to choose the path up front.";

/** The watchdog / assert_fits fast-fail marker — its stderr line already carries
 *  the precise, strategy-switching guidance, so surface that verbatim. */
const OOM_PREDICTED_MARKER = "HERMETIC_OOM_PREDICTED:";

/**
 * Phase-keyed OOM guidance. The generic OOM_ERROR blob is a MISDIAGNOSIS for the
 * planet-scale spatial path: it tells the model to "drop string columns / switch
 * to counting", but that code is ALREADY coordinates-only and counting — so the
 * retry reproduces the same shape (observed: attempt-02 ≡ attempt-01). The
 * watchdog now tags the abort with the progress phase where memory peaked, and a
 * hard kernel kill still leaves the last `__progress` line in stdout. Matching
 * that phase to WHERE the memory went yields a fix the model can actually act on.
 * Returns undefined when the phase doesn't match a known pattern → caller falls
 * back to the verbatim marker / generic OOM_ERROR (unchanged behavior).
 */
const POLYGON_OOM_HINT =
  "The OOM struck while BUILDING THE REGION/BOUNDARY POLYGON. ST_Union_Agg over a country/large-region " +
  "multipolygon decodes the single fattest geometry on the continent (millions of vertices) into memory. " +
  "FIXES: (1) simplify HARD — ST_Simplify(ST_Union_Agg(geometry), 0.01) (~1 km) or 0.02 for a whole country, " +
  "NOT 0.001. (2) bbox-prefilter the division rows to the target extent BEFORE the union so less geometry is " +
  "decoded. (3) You only need the polygon to EXCLUDE neighbouring countries when testing cell centroids — a " +
  "coarse simplified hull suffices; never union raw full-detail geometry.";
const GRID_OOM_HINT =
  "The OOM struck during the COARSE GRID COUNT/SCAN. Your cell size is likely too FINE for the region span, so " +
  "the GROUP BY emits far too many cells (a fixed 10 km cell over a ~5,000 km continent makes ~25x more cells " +
  "than a state). FIX: scale the cell size to the span — s = max(span_m/200, 2000) — so a larger region " +
  "auto-coarsens; keep the GROUP BY streaming (never pull the raw buildings into pandas). If the cells frame " +
  "itself is still millions of rows, coarsen s further before .df().";
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
 * Recover the progress phase active when the OOM happened: from the watchdog
 * marker's `[phase=...]` tag if it fired, else the last `{"__progress": {...}}`
 * line the script wrote to stdout (a hard kernel kill leaves no marker but the
 * progress heartbeat is still on disk).
 */
function extractOomPhase(predictedLine: string | undefined, stdout: string): string | undefined {
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

    if (opts.exitCode === 137 || /\bKilled\b/.test(stderr)) {
      const predicted = stderr
        .split("\n")
        .find((l) => l.includes(OOM_PREDICTED_MARKER))
        ?.trim();
      // Localize the OOM to the phase where memory peaked (watchdog tag, or the
      // last progress line on a hard kill) and feed a phase-SPECIFIC remedy. The
      // generic blob is unactionable when the code is already coordinates-only +
      // counting — the retry just reproduces the same shape.
      const phase = extractOomPhase(predicted, stdout);
      const phaseGuidance = oomGuidanceForPhase(phase);
      if (phaseGuidance) {
        const lead = predicted
          ? "Predicted OOM — the watchdog aborted before the kernel OOM-kill."
          : "Out of memory — the analysis process was killed (OOM).";
        const error = `${lead} Memory peaked during phase: "${phase}".\n${phaseGuidance}`;
        return { success: false, error, errorKind: "oom", execution_ms: executionMs };
      }
      // No phase match → preserve prior behavior: the watchdog's verbatim marker
      // (its own strategy-switch guidance) or the generic two-case OOM_ERROR.
      const error = predicted
        ? predicted
            .slice(predicted.indexOf(OOM_PREDICTED_MARKER))
            .replace(/\[phase=[^\]]*\]\s*/, "")
        : OOM_ERROR;
      return { success: false, error, errorKind: "oom", execution_ms: executionMs };
    }
    return {
      success: false,
      error: stderr || "Unknown execution error",
      execution_ms: executionMs,
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
