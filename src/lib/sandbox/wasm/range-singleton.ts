/**
 * The process-wide remote-range registry (build log D18) — one instance shared by
 * the sidecar (which `register()`s an authorized remote source) and the
 * `/api/wasm-range/[token]` route (which `resolve()`s it and serves byte ranges).
 * Pinned to a globalThis slot because those compile into separate dev module
 * graphs (same rationale as the input + handoff singletons). Tokens are crypto
 * UUIDs → unguessable capabilities.
 *
 * Integration glue (globalThis + crypto) → coverage-excluded; the registry logic it
 * wraps is covered in range-registry.test.ts.
 */
import { stateBox } from "@/lib/state-store";
import {
  createRangeRegistry,
  createWarmCache,
  type RangeRegistry,
  type WarmCache,
} from "./range-registry";

const box = stateBox<RangeRegistry>("wasm-range-registry", () =>
  createRangeRegistry(() => crypto.randomUUID())
);

/** The shared registry — same instance for the sidecar and the range route. */
export function getRangeRegistry(): RangeRegistry {
  return box.get();
}

const warmBox = stateBox<WarmCache>("wasm-range-warm-cache", () => createWarmCache());

/** The shared footer-prefetch cache — written by the prefetcher, read by the route. */
export function getWarmCache(): WarmCache {
  return warmBox.get();
}
