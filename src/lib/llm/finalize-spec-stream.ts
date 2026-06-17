/**
 * The single finalization stage for composed UI-spec streams.
 *
 * Every consumer of LLM-composed JSONL spec patches — Ask mode, Investigate
 * mode, dashboard recompose, and notebook step cells — runs each line through
 * the same pipeline:
 *
 *   1. inline image placeholders (IMAGE_PLACEHOLDER_<key> → data URI),
 *   2. resolve `$result:` / `$chartData:` placeholders (shared resolver),
 *   3. optionally mutate the patch (e.g. inject the full dataset into /state),
 *   4. harvest produced data keys and repair drifted chart `$state` bindings.
 *
 * Previously the Ask route carried its own copy of steps 1–2 and only it did
 * step 4, so hardening one path silently left the others behind (this is how
 * the empty-chart key-drift bug only bit one mode). Routing every consumer
 * through `createSpecFinalizer` keeps them at parity by construction.
 */

import {
  resolveSpecPlaceholders,
  repairStateBindings,
  harvestStateKeys,
  type ValidStateKeys,
} from "./resolve-placeholders";

/** A streamed JSON-Patch op as emitted by the composer. */
export interface SpecPatch {
  op?: string;
  path?: string;
  value?: unknown;
}

export interface SpecFinalizerConfig {
  /** Result scalars for `$result:` resolution (Ask: execution results; Investigate: merged per-step). */
  results: Record<string, unknown>;
  /** Chart-data tables for `$chartData:` resolution. */
  chartData: Record<string, unknown>;
  /** Ask only: IMAGE_PLACEHOLDER_<key> → base64 data URI. */
  imagePlaceholders?: Record<string, string>;
  /** Enables chart `$state` binding repair (Ask DataController flow). Null/omitted disables it. */
  validStateKeys?: ValidStateKeys | null;
  /**
   * Mutate the parsed patch in place before harvest/repair — e.g. Ask mode
   * injects the full dataset into the `/state` patch. Return true if it mutated
   * the patch (so the line is re-serialized).
   */
  mutatePatch?: (patch: SpecPatch) => boolean;
}

export interface FinalizedLine {
  /** True for blank / fenced (```), lines the caller should skip. */
  skip: boolean;
  /** The finalized JSONL line: placeholders resolved, images inlined, `$state` repaired. */
  line: string;
  /** The parsed patch (post-mutation) for side-effects, or null when the line isn't a JSON patch. */
  patch: SpecPatch | null;
  /** The trimmed pre-resolution line (e.g. for `$result:step_N_` citation extraction). */
  raw: string;
}

/**
 * Build a per-line finalizer bound to one composition's data + options. Call
 * the returned function on each raw streamed line. Streaming consumers emit
 * `result.line`; assembly consumers parse `result.line` with
 * `parseSpecStreamLine` and apply it.
 */
export function createSpecFinalizer(
  config: SpecFinalizerConfig
): (rawLine: string) => FinalizedLine {
  const SKIP: Omit<FinalizedLine, "raw"> = { skip: true, line: "", patch: null };

  return function finalize(rawLine: string): FinalizedLine {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("```")) {
      return { ...SKIP, raw: trimmed };
    }

    // 1. Inline image placeholders (Ask mode only).
    let processed = trimmed;
    if (config.imagePlaceholders) {
      for (const [key, dataUri] of Object.entries(config.imagePlaceholders)) {
        processed = processed.replaceAll(`IMAGE_PLACEHOLDER_${key}`, dataUri);
      }
    }

    // 2. Resolve $result / $chartData placeholders.
    processed = resolveSpecPlaceholders(processed, config.results, config.chartData);

    // 3-4. Structural passes need the parsed patch. Plain JSON.parse keeps a
    // safe round-trip for re-serialization; assembly consumers re-parse the
    // emitted line with parseSpecStreamLine for their applySpecPatch step.
    let patch: SpecPatch | null = null;
    try {
      patch = JSON.parse(processed) as SpecPatch;
    } catch {
      patch = null;
    }

    if (patch && typeof patch === "object") {
      let mutated = false;
      if (config.mutatePatch && config.mutatePatch(patch)) mutated = true;

      const valid = config.validStateKeys;
      if (valid) {
        harvestStateKeys(patch, valid);
        if (typeof patch.path === "string" && patch.path.startsWith("/elements/")) {
          if (repairStateBindings(patch.value, valid) > 0) mutated = true;
        }
      }

      if (mutated) processed = JSON.stringify(patch);
    }

    return { skip: false, line: processed, patch, raw: trimmed };
  };
}
