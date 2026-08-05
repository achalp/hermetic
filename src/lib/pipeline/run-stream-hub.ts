import { stateNamespace } from "@/lib/state-store";
import { registerSweepable } from "@/lib/store-ttl";
/**
 * Run output hub — lets a client that lost its connection (page reload, dev
 * HMR, navigation) REATTACH to an analysis that is still running server-side.
 *
 * A run's NDJSON patch output is buffered here and multicast: the original
 * request is fed directly by patch-stream, and any number of late reconnect
 * subscribers get the full buffer replayed then every subsequent line live.
 * When the run ends, the channel is closed (subscribers receive an end
 * sentinel) and kept briefly so a reconnect arriving right at completion still
 * gets the finished result before it falls back to history.
 *
 * Keyed by runId (the id patch-stream already assigns via AsyncLocalStorage) and
 * discoverable by csvId, so the UI can ask "is anything still running for this
 * source?". Lifecycle is driven entirely by patch-stream (open/publish/close);
 * the two HTTP entry points (/api/query/active, /api/query/attach) only read.
 */

/** A subscriber receives each NDJSON line, then `null` once the run ends. */
type Subscriber = (line: string | null) => void;

interface RunChannel {
  runId: string;
  route: string;
  csvId?: string;
  question?: string;
  /** Every NDJSON line emitted so far — the replay buffer for late subscribers. */
  buffer: string[];
  subscribers: Set<Subscriber>;
  closed: boolean;
  startedAt: number;
  closedAt?: number;
}

// globalThis so the map survives dev hot-reloads (the very event that reattach
// exists to recover from).
const channels = stateNamespace<RunChannel>("run-stream-hub");

/** How long a finished run's buffer lingers for a late reconnect before reaping. */
const CLOSED_GRACE_MS = 2 * 60 * 1000;

/** Open a channel for the current run. Returns its buffer array so patch-stream
 *  can use it as `emittedLines` (single source of truth — no double buffering). */
export function openRunChannel(runId: string, opts: { route: string }): string[] {
  const existing = channels.get(runId);
  if (existing) return existing.buffer;
  const channel: RunChannel = {
    runId,
    route: opts.route,
    buffer: [],
    subscribers: new Set(),
    closed: false,
    startedAt: Date.now(),
  };
  channels.set(runId, channel);
  return channel.buffer;
}

/** Attach the source/question once the handler has resolved them (for discovery). */
export function setRunChannelMeta(
  runId: string,
  meta: { csvId?: string; question?: string }
): void {
  const ch = channels.get(runId);
  if (!ch) return;
  if (meta.csvId !== undefined) ch.csvId = meta.csvId;
  if (meta.question !== undefined) ch.question = meta.question;
}

/** Buffer a line and fan it out to every live reconnect subscriber. */
export function publishRunLine(runId: string, line: string): void {
  const ch = channels.get(runId);
  if (!ch || ch.closed) return;
  ch.buffer.push(line);
  for (const cb of ch.subscribers) {
    try {
      cb(line);
    } catch {
      // A broken subscriber must not stall the run or its other subscribers.
    }
  }
}

/** End the channel: signal every subscriber, then keep it briefly for late
 *  reconnects (reaped by reapStaleRunChannels). Idempotent. */
export function closeRunChannel(runId: string): void {
  const ch = channels.get(runId);
  if (!ch || ch.closed) return;
  ch.closed = true;
  ch.closedAt = Date.now();
  for (const cb of ch.subscribers) {
    try {
      cb(null);
    } catch {
      /* ignore */
    }
  }
  ch.subscribers.clear();
}

/**
 * Subscribe to a run: synchronously replays the buffer so far, then delivers
 * every subsequent line, and finally `null` when the run ends. Returns an
 * unsubscribe fn, or null when no channel exists (caller → 404 / history).
 * A closed-but-retained channel replays its buffer then ends immediately.
 */
export function subscribeRunChannel(runId: string, cb: Subscriber): (() => void) | null {
  const ch = channels.get(runId);
  if (!ch) return null;
  // Snapshot BEFORE registering so a concurrent publish is delivered exactly
  // once. Single-threaded JS guarantees no emit interleaves these statements.
  const replay = ch.buffer.slice();
  if (ch.closed) {
    for (const line of replay) cb(line);
    cb(null);
    return () => {};
  }
  ch.subscribers.add(cb);
  for (const line of replay) cb(line);
  return () => {
    ch.subscribers.delete(cb);
  };
}

/** True if a channel exists for this run (open or in its post-close grace). */
export function hasRunChannel(runId: string): boolean {
  return channels.has(runId);
}

export interface ActiveRunInfo {
  runId: string;
  csvId?: string;
  question?: string;
  route: string;
  startedAt: number;
}

function toInfo(ch: RunChannel): ActiveRunInfo {
  return {
    runId: ch.runId,
    csvId: ch.csvId,
    question: ch.question,
    route: ch.route,
    startedAt: ch.startedAt,
  };
}

/** All still-running channels, most-recent first (for a global "still running" UI). */
export function listActiveRuns(): ActiveRunInfo[] {
  return [...channels.values()]
    .filter((ch) => !ch.closed)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toInfo);
}

/** The most-recent still-running channel for a given source, or null. */
export function findActiveRunForCsv(csvId: string): ActiveRunInfo | null {
  let best: RunChannel | null = null;
  for (const ch of channels.values()) {
    if (ch.closed || ch.csvId !== csvId) continue;
    // >= so that on a same-millisecond tie the later-INSERTED channel wins
    // (Map preserves insertion order) — "most recent" by both clock and arrival.
    if (!best || ch.startedAt >= best.startedAt) best = ch;
  }
  return best ? toInfo(best) : null;
}

/** Reap closed channels past the grace window (called by the store sweeper). */
export function reapStaleRunChannels(now: number = Date.now()): number {
  let reaped = 0;
  for (const [id, ch] of channels) {
    if (ch.closed && ch.closedAt != null && now - ch.closedAt > CLOSED_GRACE_MS) {
      channels.delete(id);
      reaped++;
    }
  }
  return reaped;
}

/** Test-only: clear all channels between cases. */
export function __resetRunStreamHubForTests(): void {
  channels.clear();
}

// Sweep enrollment at the definition site (store-ttl registry) — a new
// store cannot be forgotten by the sweeper's roll call.
registerSweepable("runChannels", () => reapStaleRunChannels());
