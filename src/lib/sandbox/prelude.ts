import { readFileSync } from "node:fs";
import { hermeticPaths } from "@/lib/paths";

/**
 * Every generated analysis script is prefixed with this prelude before
 * execution (modularization M4-4a):
 * - Emits {"__progress": {...}} JSONL heartbeats on stdout (the host's
 *   stream-exec parses them — the schema is shared by convention with
 *   parse-output.ts and stream-exec.ts)
 * - Patches json.dump/dumps to force allow_nan=True (prevents NaN crash)
 * - Patches DataFrame.corr/cov to auto-select numeric columns
 *
 * It lived as a 481-line template literal inside the dispatcher (87% of the
 * file); it is now real Python at docker/sandbox/prelude.py, next to the
 * runtime it belongs to — editable with Python tooling and diffable as
 * Python. Loaded once per process from the asset root.
 */

let cached: string | undefined;

export function pythonNanPrelude(): string {
  if (cached === undefined) {
    cached = readFileSync(hermeticPaths.sandboxPreludeFile(), "utf-8");
  }
  return cached;
}
