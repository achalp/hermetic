/**
 * Assemble a full spec object from the stream of finalized patches the compose
 * step emits, so the SERVER holds the same spec the browser would. This lets
 * the pipeline persist history itself at the concluding stage (surviving a
 * client that disconnected mid-run) instead of relying on the client to POST
 * it after render.
 *
 * WS2-A5: this file used to hand-mirror @json-render/react's client-side
 * setSpecValue/removeSpecValue ("replicating" per its own comment) with no
 * test tying the copy to the original — the audit's latent-divergence
 * finding. The spec runtime is ours now (src/spec), so assembly calls the
 * SAME applySpecPatch the client renderer uses; one implementation, already
 * covered by the vendored suite and the patch-stream protocol tests.
 */
import { applySpecPatch, type Spec, type SpecStreamLine } from "@/spec/core";
import type { PatchLine } from "@/lib/contracts/stream-state";

/**
 * A type ALIAS (not an interface) on purpose: aliases carry an implicit
 * index signature, so an AssembledSpec passes directly where persistence
 * takes a `Record<string, unknown>` (history/persist) — the `as unknown as`
 * bridges that every consumer repeated are gone.
 */
export type AssembledSpec = {
  root: string;
  elements: Record<string, unknown>;
  state?: Record<string, unknown>;
};

/**
 * Apply the finalized patch stream into a spec. Returns null if no `/root` was
 * ever set (i.e. nothing renderable was composed — not worth persisting).
 */
export function assembleSpecFromPatches(patches: PatchLine[]): AssembledSpec | null {
  const spec: Spec = { root: "", elements: {} };
  for (const p of patches) {
    if (!p || typeof p.path !== "string" || typeof p.op !== "string") continue;
    // The wire carries `op: string` (anything can be parsed off NDJSON);
    // applySpecPatch no-ops on ops outside the RFC 6902 set, so the narrow
    // to SpecStreamLine is a boundary formality, not a hidden assumption.
    applySpecPatch(spec, p as SpecStreamLine);
  }
  return spec.root ? spec : null;
}
