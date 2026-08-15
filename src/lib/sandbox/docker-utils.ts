import { execFile } from "node:child_process";
import type { ExecutionResult } from "@/lib/contracts/execution";
import { parseSandboxOutput } from "./parse-output";

export function run(
  cmd: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = opts?.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
    // An external signal (a user Stop) aborts the same child — without this the
    // warm path could only kill on its own timeout, leaving the exec running.
    if (opts?.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }

    const child = execFile(
      cmd,
      args,
      { signal: ac.signal, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (timer) clearTimeout(timer);
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
 * pyflakes catches it in milliseconds. It MUST run on the FULL script so the
 * prelude's injected helpers (progress/write_output/safe_float/assert_fits) are
 * seen as bound and never false-flagged.
 *
 * Prefers pyflakes (precise scope analysis); falls back to a conservative
 * stdlib-AST check when pyflakes isn't in the image (older build) — that fallback
 * flags a loaded name only when it is bound in NO scope anywhere in the module,
 * so it under-reports rather than risk blocking a valid run on a false positive.
 */
export const UNDEFINED_NAME_CHECKER = `
import ast, sys, builtins
try:
    src = open('/data/script.py').read()
except Exception:
    sys.exit(0)
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print("SYNTAX:%s:%s" % ((e.msg or 'syntax error').replace(chr(10), ' '), e.lineno or 0))
    sys.exit(0)
# Precise path: pyflakes UndefinedName messages.
try:
    from pyflakes.api import check as _pf_check
    from pyflakes import messages as _M
    class _R:
        def __init__(self): self.msgs = []
        def unexpectedError(self, *a): pass
        def syntaxError(self, *a): pass
        def flake(self, m): self.msgs.append(m)
    _r = _R(); _pf_check(src, '<script>', _r)
    _seen = set()
    for _m in _r.msgs:
        if isinstance(_m, _M.UndefinedName):
            _n = _m.message_args[0]
            if (_n, _m.lineno) in _seen: continue
            _seen.add((_n, _m.lineno))
            print("UNDEFINED:%s:%s" % (_n, _m.lineno))
    sys.exit(0)
except ImportError:
    pass
# Fallback: union-of-all-bindings. A loaded Name is undefined only if bound in NO
# scope module-wide and not a builtin — conservative (near-zero false positives).
bound = set(); loaded = {}
class _B(ast.NodeVisitor):
    def visit_Import(self, n):
        for a in n.names: bound.add((a.asname or a.name).split('.')[0])
    def visit_ImportFrom(self, n):
        for a in n.names: bound.add('*' if a.name == '*' else (a.asname or a.name))
    def visit_FunctionDef(self, n): bound.add(n.name); self.generic_visit(n)
    visit_AsyncFunctionDef = visit_FunctionDef
    def visit_ClassDef(self, n): bound.add(n.name); self.generic_visit(n)
    def visit_ExceptHandler(self, n):
        if n.name: bound.add(n.name)
        self.generic_visit(n)
    def visit_arg(self, n): bound.add(n.arg)
    def visit_Global(self, n): bound.update(n.names)
    def visit_Nonlocal(self, n): bound.update(n.names)
    def visit_Name(self, n):
        if isinstance(n.ctx, (ast.Store, ast.Del)): bound.add(n.id)
        elif isinstance(n.ctx, ast.Load): loaded.setdefault(n.id, n.lineno)
_B().visit(tree)
if '*' in bound:
    sys.exit(0)  # a star import can define anything — don't risk a false positive
_bi = set(dir(builtins)) | {'__name__', '__file__', '__doc__', '__builtins__'}
for _name, _line in loaded.items():
    if _name not in bound and _name not in _bi:
        print("UNDEFINED:%s:%s" % (_name, _line))
`;

export interface PreflightLintResult {
  /** Names used but never bound/imported anywhere (F821). */
  undefinedNames: { name: string; line: number }[];
  /** A syntax error, if the script won't even parse. */
  syntaxError?: { message: string; line: number };
}

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
  const undefinedNames: { name: string; line: number }[] = [];
  let syntaxError: { message: string; line: number } | undefined;
  for (const line of res.stdout.split("\n")) {
    const t = line.trim();
    if (t.startsWith("UNDEFINED:")) {
      const rest = t.slice("UNDEFINED:".length);
      const i = rest.lastIndexOf(":");
      const name = i >= 0 ? rest.slice(0, i) : rest;
      const ln = i >= 0 ? parseInt(rest.slice(i + 1), 10) : 0;
      if (name) undefinedNames.push({ name, line: Number.isFinite(ln) ? ln : 0 });
    } else if (t.startsWith("SYNTAX:")) {
      const rest = t.slice("SYNTAX:".length);
      const i = rest.lastIndexOf(":");
      const message = i >= 0 ? rest.slice(0, i) : rest;
      const ln = i >= 0 ? parseInt(rest.slice(i + 1), 10) : 0;
      syntaxError = { message, line: Number.isFinite(ln) ? ln : 0 };
    }
  }
  return { undefinedNames, syntaxError };
}

/**
 * Build the retry-facing error for a failed pre-flight lint. The prelude adds a
 * fixed number of lines ahead of the generated code; report the RAW line so the
 * message stays useful even though the model can't see the prelude.
 */
export function preflightLintError(lint: PreflightLintResult): string | null {
  if (lint.syntaxError) {
    return (
      `SyntaxError before running: ${lint.syntaxError.message}. ` +
      `Fix the syntax and re-emit the full script.`
    );
  }
  if (lint.undefinedNames.length) {
    const names = [...new Set(lint.undefinedNames.map((u) => u.name))];
    const list = names.map((n) => `\`${n}\``).join(", ");
    return (
      `Undefined name(s) — used but never imported or defined: ${list}. ` +
      `This would crash with NameError at runtime (often AFTER a multi-minute scan), so it is ` +
      `caught before running. Add the missing import(s) at the top and re-emit the full script — ` +
      `e.g. \`from scipy.spatial import cKDTree\`, \`import numpy as np\`, \`from math import cos, radians\`. ` +
      `Do NOT change your analysis approach; this is a missing-import bug only.`
    );
  }
  return null;
}

/**
 * Parse execution output from a container that ran a Python script — a thin
 * Docker adapter over the shared runtime-agnostic parser (see parse-output.ts).
 */
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
    readFile: async (path) => {
      const result = await run("docker", ["exec", containerId, "cat", path]).catch(() => null);
      return result && result.exitCode === 0 ? result.stdout : null;
    },
  });
}
