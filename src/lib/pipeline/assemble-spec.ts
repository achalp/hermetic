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
import type { PatchLike } from "./computed-key-audit";

export interface AssembledSpec {
  root: string;
  elements: Record<string, unknown>;
  state?: Record<string, unknown>;
}

/**
 * Apply the finalized patch stream into a spec. Returns null if no `/root` was
 * ever set (i.e. nothing renderable was composed — not worth persisting).
 */
export function assembleSpecFromPatches(patches: PatchLike[]): AssembledSpec | null {
  const spec: Spec = { root: "", elements: {} };
  for (const p of patches) {
    if (!p || typeof p.path !== "string") continue;
    applySpecPatch(spec, p as SpecStreamLine);
  }
  return spec.root ? (spec as unknown as AssembledSpec) : null;
}
