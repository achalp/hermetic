/**
 * Run correlation context (server-only).
 *
 * A short runId minted at route entry and carried through the whole run via
 * AsyncLocalStorage, so every log line, the diagnostics JSONL record, and the
 * cost row of one run can be joined — previously concurrent multi-minute runs
 * interleaved in the logs with no way to attribute a line to a run, and the
 * per-run artifacts correlated only by timestamp.
 *
 * The logger can't import node:async_hooks itself (it may be pulled into a
 * client bundle transitively), so this module registers a provider with it —
 * dependency inversion keeps the node-only import on the server side.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setRunIdProvider } from "@/lib/logger";

const store = new AsyncLocalStorage<{ runId: string }>();

// Every logger call inside a run scope picks up the runId automatically.
setRunIdProvider(() => store.getStore()?.runId);

/** The current run's id, or undefined outside a run scope. */
export function getRunId(): string | undefined {
  return store.getStore()?.runId;
}

/** Enter a run scope with a fresh short id (8 hex chars). */
export function runWithRunId<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ runId: randomUUID().slice(0, 8) }, fn);
}
