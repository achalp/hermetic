/**
 * Assemble a full spec object from the stream of finalized patches the compose
 * step emits — replicating @json-render's client-side applyPatch/setSpecValue so
 * the SERVER holds the same spec the browser would. This lets the pipeline
 * persist history itself at the concluding stage (surviving a client that
 * disconnected mid-run) instead of relying on the client to POST it after render.
 */
import { setByPath, removeByPath } from "@json-render/core";
import type { PatchLike } from "./computed-key-audit";

export interface AssembledSpec {
  root: string;
  elements: Record<string, unknown>;
  state?: Record<string, unknown>;
}

// Mirror of @json-render/react's setSpecValue.
function setSpecValue(spec: AssembledSpec, path: string, value: unknown): void {
  if (path === "/root") {
    spec.root = value as string;
    return;
  }
  if (path === "/state") {
    spec.state = value as Record<string, unknown>;
    return;
  }
  if (path.startsWith("/state/")) {
    if (!spec.state) spec.state = {};
    setByPath(spec.state, path.slice("/state".length), value);
    return;
  }
  if (path.startsWith("/elements/")) {
    const parts = path.slice("/elements/".length).split("/");
    const key = parts[0];
    if (!key) return;
    if (parts.length === 1) {
      spec.elements[key] = value;
    } else {
      const el = spec.elements[key];
      if (el) {
        const next = { ...(el as Record<string, unknown>) };
        setByPath(next, "/" + parts.slice(1).join("/"), value);
        spec.elements[key] = next;
      }
    }
  }
}

// Mirror of @json-render/react's removeSpecValue.
function removeSpecValue(spec: AssembledSpec, path: string): void {
  if (path === "/state") {
    delete spec.state;
    return;
  }
  if (path.startsWith("/state/") && spec.state) {
    removeByPath(spec.state, path.slice("/state".length));
    return;
  }
  if (path.startsWith("/elements/")) {
    const parts = path.slice("/elements/".length).split("/");
    const key = parts[0];
    if (!key) return;
    if (parts.length === 1) {
      delete spec.elements[key];
    } else {
      const el = spec.elements[key];
      if (el) {
        const next = { ...(el as Record<string, unknown>) };
        removeByPath(next, "/" + parts.slice(1).join("/"));
        spec.elements[key] = next;
      }
    }
  }
}

/**
 * Apply the finalized patch stream into a spec. Returns null if no `/root` was
 * ever set (i.e. nothing renderable was composed — not worth persisting).
 */
export function assembleSpecFromPatches(patches: PatchLike[]): AssembledSpec | null {
  const spec: AssembledSpec = { root: "", elements: {} };
  for (const p of patches) {
    if (!p || typeof p.path !== "string") continue;
    if (p.op === "remove") removeSpecValue(spec, p.path);
    else setSpecValue(spec, p.path, p.value); // "add" | "replace" both set
  }
  return spec.root ? spec : null;
}
