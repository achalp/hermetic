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
import type { ExecutionResult } from "@/lib/types";
import { logger } from "@/lib/logger";

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
  "For a large spatial region: pull ONLY the coordinate columns (lon, lat) into the KD-tree (not all attributes), " +
  "compute nearest-neighbor distances, then fetch full attributes for ONLY the top-N results via a follow-up query. " +
  "Keep datasets['main'] to a bounded subset (e.g. the top-N), never the full multi-million-row frame.";

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

    if (opts.exitCode === 137 || /\bKilled\b/.test(stderr)) {
      return { success: false, error: OOM_ERROR, execution_ms: executionMs };
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

  // Replace Python NaN/Infinity with null for valid JSON
  outputJson = outputJson
    .replace(/\bNaN\b/g, "null")
    .replace(/\b-Infinity\b/g, "null")
    .replace(/\bInfinity\b/g, "null");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(outputJson);
  } catch {
    return {
      success: false,
      error: `Failed to parse output as JSON. Output was: ${outputJson.slice(0, 500)}`,
      execution_ms: executionMs,
    };
  }

  return {
    success: true,
    results: (parsed.results as Record<string, unknown>) ?? {},
    chart_data: (parsed.chart_data as Record<string, unknown>) ?? {},
    images: (parsed.images as Record<string, string>) ?? {},
    datasets: (parsed.datasets as Record<string, Record<string, unknown>[]>) ?? undefined,
    execution_ms: executionMs,
  };
}
