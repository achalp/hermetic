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
import { logger } from "@/lib/logger";
import type { AdditionalFile } from "./index";

const RUNTIME_MODULES = ["__init__.py", "coerce.py", "frames.py", "guards.py", "output.py"];

function runtimeDir(): string {
  return path.join(process.cwd(), "docker", "sandbox", "hermetic_runtime");
}

let cachedFiles: AdditionalFile[] | null = null;
let warnedMissing = false;

/** Test-only: reset the module caches. */
export function resetRuntimeFilesCacheForTests(): void {
  cachedFiles = null;
  cachedApi = null;
  cachedExtras = null;
  warnedMissing = false;
}

/**
 * The runtime package as sandbox files. [] (with one warn) when the package
 * directory is unreadable — the prelude then falls back to its inline copies,
 * so a broken deployment degrades instead of failing every run.
 */
export function hermeticRuntimeFiles(): AdditionalFile[] {
  if (cachedFiles) return cachedFiles;
  try {
    cachedFiles = RUNTIME_MODULES.map((name) => ({
      path: `/data/hermetic_runtime/${name}`,
      content: readFileSync(path.join(runtimeDir(), name), "utf8"),
    }));
  } catch (err) {
    if (!warnedMissing) {
      warnedMissing = true;
      logger.warn("Hermetic runtime package unreadable — sandbox falls back to inline helpers", {
        dir: runtimeDir(),
        error: err instanceof Error ? err.message : String(err),
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
    .filter((fn) => fn.name !== "configure" && !HAND_CURATED.has(fn.name));
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
    .filter((fn) => fn.name !== "configure"); // prelude-internal wiring, not for generated code
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
