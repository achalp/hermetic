import { readdirSync, statSync } from "fs";
/**
 * Hermetic runtime shipping — the tested Python package under
 * docker/sandbox/hermetic_runtime/ is attached to EVERY sandbox run as
 * additional files (/data/hermetic_runtime/), and the prelude imports it,
 * overriding its legacy inline helper copies. Shipping per-run instead of
 * baking into the image means the package version always matches the host
 * code that generated the prompt — no image-rebuild coupling, no version skew.
 *
 * This module also generates the "Preloaded Python API" prompt section FROM
 * the package source (def signatures + first docstring lines), so the prompt
 * can never advertise a helper that doesn't exist — sync by construction.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { logger, errMessage } from "@/lib/logger";
import type { AdditionalFile } from "@/lib/contracts/execution";
import { hermeticPaths } from "@/lib/paths";

// Derived from the package directory, never hand-maintained: run 88e5d443
// shipped without checks.py because this was a hand-edited list — __init__'s
// import failed in the sandbox, the prelude silently fell back to stubs, and
// 13 of 17 findings came back null with perfect inputs. Any *.py in the
// package (minus tests) ships.
function runtimeModules(): string[] {
  return readdirSync(runtimeDir())
    .filter((f) => f.endsWith(".py") && !f.startsWith("test_"))
    .sort((a, b) => (a === "__init__.py" ? -1 : b === "__init__.py" ? 1 : a.localeCompare(b)));
}

function runtimeDir(): string {
  return hermeticPaths.sandboxRuntimeAssetsDir();
}

let cachedFiles: AdditionalFile[] | null = null;
let cachedStamp = "";
let warnedMissing = false;

/** Test-only: reset the module caches. */
export function resetRuntimeFilesCacheForTests(): void {
  cachedFiles = null;
  cachedStamp = "";
  cachedApi = null;
  cachedExtras = null;
  warnedMissing = false;
}

/** Fingerprint of the package directory (names + mtimes) — a handful of
 *  stats per run, so an edited helper reaches the NEXT sandbox without a
 *  server restart. The stale-cache failure was live and expensive: the
 *  O(n^2) modal fix (run f4c8d66b) was committed, the long-lived dev server
 *  kept injecting its cached pre-fix copy, and the validation run burned
 *  another 22 minutes proving nothing. */
function runtimeStamp(names: string[]): string {
  return names.map((n) => `${n}:${statSync(path.join(runtimeDir(), n)).mtimeMs}`).join("|");
}

/**
 * The runtime package as sandbox files. [] (with one warn) when the package
 * directory is unreadable — the prelude then falls back to its inline copies,
 * so a broken deployment degrades instead of failing every run.
 */
export function hermeticRuntimeFiles(): AdditionalFile[] {
  try {
    const names = runtimeModules();
    const stamp = runtimeStamp(names);
    if (cachedFiles && stamp === cachedStamp) return cachedFiles;
    cachedFiles = names.map((name) => ({
      path: `/data/hermetic_runtime/${name}`,
      content: readFileSync(path.join(runtimeDir(), name), "utf8"),
    }));
    cachedStamp = stamp;
    // The prompt sections derive from these contents — refresh with them.
    cachedApi = null;
    cachedExtras = null;
  } catch (err) {
    if (!warnedMissing) {
      warnedMissing = true;
      logger.warn("Hermetic runtime package unreadable — sandbox falls back to inline helpers", {
        dir: runtimeDir(),
        error: errMessage(err),
      });
    }
    cachedFiles = [];
  }
  return cachedFiles;
}

export interface PreloadedFn {
  name: string;
  signature: string;
  summary: string;
}

/**
 * Public functions extracted from the package source: `def name(args):`
 * followed by a docstring — private (underscore) names and test files skipped.
 */
export function extractPreloadedFns(source: string): PreloadedFn[] {
  const fns: PreloadedFn[] = [];
  const defRe = /^def ([a-z][a-z0-9_]*)\(([^)]*)\):\n\s+"""(.*?)(?:\n|""")/gm;
  for (const m of source.matchAll(defRe)) {
    fns.push({ name: m[1], signature: m[2].replace(/\s+/g, " ").trim(), summary: m[3].trim() });
  }
  return fns;
}

let cachedApi: string | null = null;

/** Helpers the system prompt already documents with curated usage guidance —
 *  the generated inventory covers everything else so the two never overlap. */
const HAND_CURATED = new Set(["write_output", "to_num", "numeric", "safe_qcut"]);

/** Prelude/skill wiring functions — not for generated code, never advertised. */
const WIRING_FNS = new Set(["configure", "set_strategy_hint", "get_strategy_hint"]);

let cachedExtras: string | null = null;

/**
 * One generated bullet listing every preloaded helper the hand-curated prompt
 * list does NOT cover (safe_float, safe_int, assert_fits, to_native, ...),
 * built from package docstrings so the prompt can never advertise a helper
 * that doesn't exist — nor omit one that does. "" when the package is
 * unreadable. Closes codegen-retry-hardening TODO #3 ("preloaded wording").
 */
export function preloadedExtrasLine(): string {
  if (cachedExtras !== null) return cachedExtras;
  const fns = hermeticRuntimeFiles()
    .filter((f) => !f.path.endsWith("__init__.py"))
    .flatMap((f) => extractPreloadedFns(f.content))
    .filter((fn) => !WIRING_FNS.has(fn.name) && !HAND_CURATED.has(fn.name));
  cachedExtras =
    fns.length === 0
      ? ""
      : `\n  - Also preloaded (same rule — already defined, never re-implement): ` +
        fns
          .map((fn) => `${fn.name}(${fn.signature}) — ${fn.summary.replace(/\.$/, "")}`)
          .join("; ") +
        `.`;
  return cachedExtras;
}

/**
 * The "Preloaded Python API" prompt section, generated from package source.
 * Static per build → lives in the CACHED system prompt. "" when the package
 * is unreadable (prompt then simply omits the section, matching the fallback).
 */
export function buildPreloadedApiSection(): string {
  if (cachedApi !== null) return cachedApi;
  const files = hermeticRuntimeFiles();
  const fns = files
    .filter((f) => !f.path.endsWith("__init__.py"))
    .flatMap((f) => extractPreloadedFns(f.content))
    .filter((fn) => !WIRING_FNS.has(fn.name));
  if (fns.length === 0) {
    cachedApi = "";
    return cachedApi;
  }
  cachedApi =
    `\n## Preloaded Python API (already defined — import nothing, do NOT re-implement)\n` +
    fns.map((fn) => `- ${fn.name}(${fn.signature}): ${fn.summary}`).join("\n") +
    `\n- progress(phase=None, detail=None, **fields): Report a live progress phase; call at phase boundaries.\n`;
  return cachedApi;
}
