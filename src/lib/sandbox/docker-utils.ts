import { execFile } from "node:child_process";
import type { ExecutionResult } from "@/lib/contracts/execution";
import { parseSandboxOutput } from "./parse-output";

export function run(
  cmd: string,
  args: string[],
  opts?: { input?: string | Buffer; timeoutMs?: number; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = opts?.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
    // An external signal (a user Stop) aborts the same child — without this the
    // warm path could only kill on its own timeout, leaving the exec running.
    // Named so completion can REMOVE it: the signal is run-lifetime and run()
    // is called many times per run, so `{once:true}` alone accumulated one
    // dead listener per call until the run actually aborted (if ever).
    const onAbort = () => ac.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const child = execFile(
      cmd,
      args,
      { signal: ac.signal, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        if (err && (err as NodeJS.ErrnoException).code === "ABORT_ERR") {
          // Distinguish a user abort from the internal timeout so the caller
          // isn't told "timed out" when the user pressed Stop.
          reject(
            new Error(
              opts?.signal?.aborted ? "Sandbox execution aborted" : "Sandbox execution timed out"
            )
          );
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
 * Static undefined-name (F821) pre-flight, run INSIDE the container against the
 * already-written /data/script.py (prelude + generated code) BEFORE the real run.
 *
 * Why: a forgotten import — `cKDTree` used without `from scipy.spatial import
 * cKDTree` — is a runtime NameError that, on a superlative over a billions-row
 * remote parquet, only fires on the LAST line AFTER a ~10-minute scan (OBSERVED:
 * attempt-1 of a USA most-isolated run). py_compile can't see it (NameError is
 * runtime, not syntax) and the LLM review gate is strategy-focused and misses it.
 * pyflakes catches it in milliseconds.
 *
 * The checker + result parsing + retry-facing formatter live in the shared
 * runtime-agnostic module (./preflight-lint) so the WASM worker embeds the
 * IDENTICAL checker — one checker, never two drifting copies. This module keeps
 * only the docker-exec adapter, and re-exports the rest for existing importers.
 */
import {
  UNDEFINED_NAME_CHECKER,
  parsePreflightLintOutput,
  preflightLintError,
  type PreflightLintResult,
} from "./preflight-lint";
export { UNDEFINED_NAME_CHECKER, preflightLintError, type PreflightLintResult };

/**
 * Run the undefined-name pre-flight in an existing container. Best-effort:
 * returns null (→ caller proceeds to run) if the checker can't run at all, so a
 * lint hiccup never blocks a legitimate analysis.
 */
export async function lintScript(containerId: string): Promise<PreflightLintResult | null> {
  const res = await run("docker", ["exec", containerId, "python3", "-c", UNDEFINED_NAME_CHECKER], {
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!res || res.exitCode !== 0) return null;
  return parsePreflightLintOutput(res.stdout);
}

/**
 * Parse execution output from a container that ran a Python script — a thin
 * Docker adapter over the shared runtime-agnostic parser (see parse-output.ts).
 */
/**
 * Fetch several container files in ONE `docker exec` (perf P3 — the post-run
 * read was 4-5 separate `docker exec cat` round-trips per run). The shell
 * prints, per file, a marker line carrying the exact BYTE size followed by the
 * raw content, so the host can split byte-accurately no matter what the content
 * contains (including the marker string itself). A missing file reports size
 * -1 → null, matching the single-file `cat` behavior.
 *
 * Returns null when the exec itself failed (container gone / daemon error) —
 * the caller falls back to per-file reads, which preserve the legacy
 * every-read-fails-to-null behavior.
 */
const SIDECAR_MARKER = "===HERMETIC-SIDECAR===";

export async function batchReadContainerFiles(
  containerId: string,
  paths: string[],
  /** Injection seam for tests — intra-module calls bypass vi.mock. */
  exec: typeof run = run
): Promise<Map<string, string | null> | null> {
  const script = paths
    .map(
      (p) =>
        `if [ -f '${p}' ]; then s=$(wc -c < '${p}'); ` +
        `printf '${SIDECAR_MARKER} %s %s\\n' '${p}' "$s"; cat '${p}'; ` +
        `else printf '${SIDECAR_MARKER} %s -1\\n' '${p}'; fi`
    )
    .join("; ");
  const result = await exec("docker", ["exec", containerId, "sh", "-c", script], {
    timeoutMs: 30_000,
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;

  // Byte-accurate split: sizes are byte counts, so scan a Buffer, not the
  // JS string (multi-byte UTF-8 would desynchronize string indices).
  const buf = Buffer.from(result.stdout, "utf-8");
  const marker = Buffer.from(SIDECAR_MARKER, "ascii");
  const out = new Map<string, string | null>();
  let off = 0;
  while (off < buf.length) {
    const at = buf.indexOf(marker, off);
    if (at === -1) break;
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1) break;
    const headerLine = buf.subarray(at, nl).toString("ascii");
    const m = headerLine.match(/^===HERMETIC-SIDECAR=== (\S+) (-?\d+)\s*$/);
    if (!m) {
      off = nl + 1;
      continue;
    }
    const [, path, sizeStr] = m;
    const size = parseInt(sizeStr, 10);
    if (size < 0) {
      out.set(path, null);
      off = nl + 1;
    } else {
      out.set(path, buf.subarray(nl + 1, nl + 1 + size).toString("utf-8"));
      off = nl + 1 + size;
    }
  }
  // A partial map (interrupted output) must not masquerade as complete —
  // unresolved paths fall back to per-file reads via the adapter below.
  return out;
}

export async function parseExecutionOutput(
  containerId: string,
  start: number,
  exitCodeStdout: string,
  /** Host-captured live-stream fallbacks that survive a hard container death. */
  live?: { lastPhase?: string; duckdbCfg?: string },
  /** Active skills' failure remedies — injected by the caller (M4-4c). */
  failureHints?: () => import("@/lib/contracts/execution").SkillFailureHint[]
): Promise<ExecutionResult> {
  const exitCode = parseInt(exitCodeStdout.trim(), 10);
  // 137 is just SIGKILL — probe whether the container still EXISTS before the
  // shared parser reaches for OOM guidance. A genuine OOM (process- or
  // init-level) leaves the container inspectable; a vanished one was `rm -f`ed
  // externally (a cleanup path / Docker itself) and must not be diagnosed as
  // a memory problem.
  let containerGone = false;
  if (exitCode === 137) {
    const probe = await run("docker", ["inspect", "--format", "{{.State.Status}}", containerId], {
      timeoutMs: 5_000,
    }).catch(() => null);
    containerGone = !probe || probe.exitCode !== 0;
  }
  return parseSandboxOutput({
    runtime: "docker",
    exitCode,
    executionMs: Date.now() - start,
    livePhase: live?.lastPhase,
    liveDuckdbCfg: live?.duckdbCfg,
    containerGone,
    // Active skills' phase-keyed OOM remedies (empty when the caller has none).
    skillFailureHints: failureHints?.() ?? [],
    readFile: (() => {
      // Prefetch the known sidecars in ONE exec (perf P3), lazily on first read
      // so a parse that never reads files (none today) pays nothing. Unknown
      // paths and a failed batch fall back to the legacy per-file cat.
      let prefetch: Promise<Map<string, string | null> | null> | undefined;
      const KNOWN = [
        "/data/stderr.txt",
        "/data/stdout.txt",
        "/data/hermetic_duckdb_cfg.txt",
        "/data/output.json",
      ];
      return async (path: string) => {
        prefetch ??= batchReadContainerFiles(containerId, KNOWN);
        const map = await prefetch;
        if (map && map.has(path)) return map.get(path) ?? null;
        const result = await run("docker", ["exec", containerId, "cat", path]).catch(() => null);
        return result && result.exitCode === 0 ? result.stdout : null;
      };
    })(),
  });
}
