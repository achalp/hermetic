/**
 * In-flight connect-time schema extractions, keyed by requestId (build log D27).
 *
 * The connect round trip is TWO requests — "here is a job" then "here is its
 * result" — so the server needs somewhere to remember what it handed out. Pinned to
 * a globalThis slot for the same reason the other wasm registries are: the route
 * modules compile into separate dev module graphs.
 *
 * A lease is NOT a capability — the range tokens are. This only records which
 * tokens belong to which connect so they can be released together, and refuses a
 * completion whose id it never issued. Leases expire on the same clock as the
 * tokens they name, so an abandoned connect cannot pin them forever.
 */
import { stateBox } from "@/lib/state-store";
import type { WasmSchemaLease } from "./wasm-schema-job";

export interface WasmSchemaLeaseStore {
  put(lease: WasmSchemaLease): void;
  /** The lease for this id, or undefined if unknown, already taken, or expired. */
  take(requestId: string, now?: number): WasmSchemaLease | undefined;
  /** Drop every expired lease; returns how many were reaped. */
  sweep(now?: number): number;
  size(): number;
}

export function createWasmSchemaLeaseStore(): WasmSchemaLeaseStore {
  const leases = new Map<string, WasmSchemaLease>();
  return {
    put(lease) {
      leases.set(lease.requestId, lease);
    },
    take(requestId, now = Date.now()) {
      const lease = leases.get(requestId);
      if (!lease) return undefined;
      // Single-use: taken on completion so a replayed envelope cannot re-enter the
      // cache-write path with a stale profile.
      leases.delete(requestId);
      return now >= lease.expiresAt ? undefined : lease;
    },
    sweep(now = Date.now()) {
      let n = 0;
      for (const [id, lease] of leases) {
        if (now >= lease.expiresAt) {
          leases.delete(id);
          n++;
        }
      }
      return n;
    },
    size() {
      return leases.size;
    },
  };
}

const box = stateBox<WasmSchemaLeaseStore>("wasm-schema-leases", createWasmSchemaLeaseStore);

/** The shared store — written by the schema route, read by the completion route. */
export function getWasmSchemaLeaseStore(): WasmSchemaLeaseStore {
  return box.get();
}
