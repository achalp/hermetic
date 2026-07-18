import "server-only";
import { execFile } from "node:child_process";
import type { ExecutionResult } from "@/lib/types";
import { parseSandboxOutput } from "./parse-output";

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
 * Whether generated code needs NETWORK at all — a deliberate superset of
 * codeDoesRemoteIo. That predicate answers "is this a slow cloud read that
 * needs the extended timeout"; this one answers "may the container have a
 * network namespace". Anything without a URL or a network library runs under
 * `--network none`, which is what makes the sandbox's isolation claim true
 * for the common local-data case. Kept permissive on purpose: a missed
 * network need is a hard failure, while a false positive only loses the
 * no-network hardening for that one run. (DuckDB INSTALL of httpfs/spatial
 * is pre-bundled in the image and verified to work offline, so a bare
 * `INSTALL spatial` does NOT need network.)
 */
export function codeNeedsNetwork(code: string): boolean {
  return (
    codeDoesRemoteIo(code) ||
    /\bhttps?:\/\//i.test(code) ||
    /\b(?:import\s+(?:requests|urllib|aiohttp|httpx|socket)|from\s+(?:requests|urllib|aiohttp|httpx|socket)[\s.])/.test(
      code
    )
  );
}

/**
 * Parse execution output from a container that ran a Python script — a thin
 * Docker adapter over the shared runtime-agnostic parser (see parse-output.ts).
 */
export async function parseExecutionOutput(
  containerId: string,
  start: number,
  exitCodeStdout: string
): Promise<ExecutionResult> {
  return parseSandboxOutput({
    runtime: "docker",
    exitCode: parseInt(exitCodeStdout.trim(), 10),
    executionMs: Date.now() - start,
    readFile: async (path) => {
      const result = await run("docker", ["exec", containerId, "cat", path]).catch(() => null);
      return result && result.exitCode === 0 ? result.stdout : null;
    },
  });
}
