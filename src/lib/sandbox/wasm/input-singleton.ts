/**
 * The process-wide host-input registry (build log D11, delivery option B) — one
 * instance shared by the sidecar (which `register()`s materialized files) and the
 * `/api/wasm-input/[token]` route (which `resolve()`s them). Pinned to a globalThis
 * slot because those compile into separate dev module graphs (same rationale as the
 * handoff singleton). Tokens are crypto UUIDs → unguessable capabilities.
 *
 * Integration glue (globalThis + crypto) → coverage-excluded; the registry logic it
 * wraps is 100%-covered in input-registry.test.ts.
 */
import { stateBox } from "@/lib/state-store";
import { createInputRegistry, type InputRegistry } from "./input-registry";

const box = stateBox<InputRegistry>("wasm-input-registry", () =>
  createInputRegistry(() => crypto.randomUUID())
);

/** The shared registry — same instance for the sidecar and the input route. */
export function getInputRegistry(): InputRegistry {
  return box.get();
}
