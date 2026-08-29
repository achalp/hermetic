/**
 * The process-wide WASM handoff registry (spec §4a / build log D6).
 *
 * ONE registry must be shared between two callers that would otherwise never
 * meet: the run pipeline `create()`s a pending handoff and awaits it, while the
 * `/api/wasm-result` route `resolve()`s it when the browser POSTs the worker's
 * result. In dev those two compile into SEPARATE module graphs (the same reason
 * run-control keeps its container-owner map on globalThis) — a plain module-level
 * singleton would split, and the route would resolve a handoff the pipeline never
 * created. `stateBox` pins it to the shared globalThis slot so both sides hold the
 * same instance. Handoff ids are crypto UUIDs → unguessable + unique per run.
 *
 * Integration glue (globalThis-backed, id source) → coverage-excluded; the
 * registry logic it wraps is 100%-covered in handoff-registry.test.ts.
 */
import { stateBox } from "@/lib/state-store";
import { createHandoffRegistry, type HandoffRegistry } from "./handoff-registry";

const box = stateBox<HandoffRegistry>("wasm-handoff-registry", () =>
  createHandoffRegistry(() => crypto.randomUUID())
);

/** The shared registry — same instance for the pipeline and the result route. */
export function getHandoffRegistry(): HandoffRegistry {
  return box.get();
}
