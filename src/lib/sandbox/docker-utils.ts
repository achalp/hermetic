import { execFile } from "node:child_process";
import type { ExecutionResult } from "@/lib/types";
import { logger } from "@/lib/logger";

export function run(
  cmd: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = opts?.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;

    const child = execFile(
      cmd,
      args,
      { signal: ac.signal, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        if (err && (err as NodeJS.ErrnoException).code === "ABORT_ERR") {
          reject(new Error("Sandbox execution timed out"));
          return;
        }
        // execFile passes exit-code errors through `err`
        const exitCode = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ stdout, stderr, exitCode: typeof exitCode === "number" ? exitCode : 1 });
      }
    );

    // Close stdin whenever input was provided — INCLUDING an empty string. A
    // remote/cloud source writes an empty /data/input.csv (its data lives at the
    // URL); with a truthy check, "" was skipped, stdin never closed, and `cat`
    // blocked until the timeout fired — surfacing as a spurious "timed out".
    if (opts?.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * Whether generated code will do slow remote/network IO — a cloud Parquet read
 * over DuckDB httpfs (s3://, gs://, azure, or a remote https Parquet). Such reads
 * are far slower than local/in-container data, so the sandbox must budget the
 * extended timeout for them, same as a large local Parquet. Detected from the
 * code itself because that is exactly what determines the IO the sandbox does.
 */
export function codeDoesRemoteIo(code: string): boolean {
  return (
    /\bhttpfs\b/i.test(code) ||
    /['"](?:s3|s3a|gs|gcs|az|azure|abfss?):\/\//i.test(code) ||
    /read_parquet\(\s*['"]https?:\/\//i.test(code)
  );
}

/**
 * Parse execution output from a container that ran a Python script.
 * Reads output.json or stdout.txt, parses JSON, returns ExecutionResult.
 */
export async function parseExecutionOutput(
  containerId: string,
  start: number,
  exitCodeStdout: string
): Promise<ExecutionResult> {
  const executionMs = Date.now() - start;
  const exitCode = parseInt(exitCodeStdout.trim(), 10);

  if (exitCode !== 0) {
    const stderrResult = await run("docker", [
      "exec",
      containerId,
      "cat",
      "/data/stderr.txt",
    ]).catch(() => ({ stdout: "Unknown execution error", stderr: "", exitCode: 1 }));
    const stderr = stderrResult.stdout || "";

    // Exit 137 = SIGKILL, and a bare "Killed" is the classic out-of-memory
    // signature (the kernel OOM-killer reaps the process). Surface it as OOM with
    // actionable guidance so the retry writes a leaner script instead of guessing.
    if (exitCode === 137 || /\bKilled\b/.test(stderr)) {
      return {
        success: false,
        error:
          "Out of memory — the analysis process was killed (OOM). Do NOT load millions of rows into pandas. " +
          "For a large spatial region: pull ONLY the coordinate columns (lon, lat) into the KD-tree (not all attributes), " +
          "compute nearest-neighbor distances, then fetch full attributes for ONLY the top-N results via a follow-up query. " +
          "Keep datasets['main'] to a bounded subset (e.g. the top-N), never the full multi-million-row frame.",
        execution_ms: executionMs,
      };
    }

    return {
      success: false,
      error: stderr || "Unknown execution error",
      execution_ms: executionMs,
    };
  }

  // Read output: prefer /data/output.json, fallback to /data/stdout.txt
  let outputJson: string;
  let outputSource: string;

  const jsonResult = await run("docker", ["exec", containerId, "cat", "/data/output.json"]).catch(
    () => null
  );

  if (jsonResult && jsonResult.exitCode === 0 && jsonResult.stdout.trim()) {
    outputJson = jsonResult.stdout;
    outputSource = "file:/data/output.json";
  } else {
    const stdoutResult = await run("docker", [
      "exec",
      containerId,
      "cat",
      "/data/stdout.txt",
    ]).catch(() => null);
    if (stdoutResult && stdoutResult.exitCode === 0 && stdoutResult.stdout.trim()) {
      outputJson = stdoutResult.stdout;
      outputSource = "file:/data/stdout.txt";
    } else {
      return {
        success: false,
        error:
          "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
        execution_ms: executionMs,
      };
    }
  }

  logger.debug("Docker executor output", { source: outputSource, len: outputJson.length });

  if (!outputJson.trim()) {
    return {
      success: false,
      error:
        "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
      execution_ms: executionMs,
    };
  }

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

  const images: Record<string, string> = (parsed.images as Record<string, string>) ?? {};

  return {
    success: true,
    results: (parsed.results as Record<string, unknown>) ?? {},
    chart_data: (parsed.chart_data as Record<string, unknown>) ?? {},
    images,
    datasets: (parsed.datasets as Record<string, Record<string, unknown>[]>) ?? undefined,
    execution_ms: executionMs,
  };
}
