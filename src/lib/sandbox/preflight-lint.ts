/**
 * The undefined-name pre-flight, shared by BOTH sandbox tiers (extracted from
 * docker-utils so the wasm worker can embed the identical checker — parity
 * demands one checker, not two drifting copies).
 *
 * A generated script that references a name it never imported dies with
 * NameError at runtime — often AFTER a multi-minute scan. This catches it in
 * milliseconds. It MUST run on the FULL composed script so the prelude's
 * injected helpers (progress/write_output/safe_float/assert_fits) are seen as
 * bound and never false-flagged.
 *
 * Prefers pyflakes (precise scope analysis); falls back to a conservative
 * stdlib-AST check when pyflakes isn't available (older Docker build, and the
 * wasm tier — Pyodide ships no pyflakes) — that fallback flags a loaded name
 * only when it is bound in NO scope anywhere in the module, so it
 * under-reports rather than risk blocking a valid run on a false positive.
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
 * Parse the checker's marker lines (UNDEFINED:name:line / SYNTAX:msg:line) into
 * the structured result. Pure — shared by the Docker exec adapter and any
 * caller that captured the checker's stdout another way.
 */
export function parsePreflightLintOutput(stdout: string): PreflightLintResult {
  const undefinedNames: { name: string; line: number }[] = [];
  let syntaxError: { message: string; line: number } | undefined;
  for (const line of stdout.split("\n")) {
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
