import { logger } from "@/lib/logger";
import type { ConversationTurn } from "@/lib/types";
import type { CachedArtifacts } from "./artifacts-cache";
import { summarizeSpec } from "@/lib/spec-summary";
import { isIdleExpired, touch } from "@/lib/store-ttl";

// SLIDING idle window (see lib/store-ttl.ts): refreshed on every read AND every
// appended turn, and pinned during an in-flight run — so a follow-up after a
// long analysis doesn't silently lose the prior-turn context.
const TTL_MS = 60 * 60 * 1000; // 1 hour idle
const MAX_TURNS = 5;

interface SessionEntry {
  turns: ConversationTurn[];
  updatedAt: number;
  lastAccessedAt?: number;
  ownerRunId?: string;
}

const globalCache = globalThis as unknown as {
  __conversationCache?: Map<string, SessionEntry>;
};
if (!globalCache.__conversationCache) {
  globalCache.__conversationCache = new Map();
}
const cache = globalCache.__conversationCache;

/** Get prior conversation turns for a data source. */
export function getConversationTurns(csvId: string): ConversationTurn[] {
  const entry = cache.get(csvId);
  if (!entry) return [];
  const now = Date.now();
  if (isIdleExpired(entry, entry.updatedAt, TTL_MS, now)) {
    // Logged: an expired conversation silently drops the follow-up context.
    logger.debug("Conversation cache entry expired", { csvId });
    cache.delete(csvId);
    return [];
  }
  touch(entry, now);
  return entry.turns;
}

/** Append a new turn after a successful analysis. */
export function appendConversationTurn(csvId: string, turn: ConversationTurn): void {
  const entry = cache.get(csvId);
  const turns = entry ? [...entry.turns, turn] : [turn];
  // Keep only the most recent turns to avoid prompt bloat
  const trimmed = turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
  cache.set(csvId, { turns: trimmed, updatedAt: Date.now() });
}

/** Clear conversation history for a data source (e.g. on reset). */
export function clearConversationTurns(csvId: string): void {
  cache.delete(csvId);
}

/** Build a ConversationTurn from artifacts we already have. */
export function buildTurnFromArtifacts(
  question: string,
  artifacts: CachedArtifacts,
  spec: Record<string, unknown>
): ConversationTurn {
  const resultKeys: Record<string, string> = {};
  if (artifacts.results && typeof artifacts.results === "object") {
    for (const [k, v] of Object.entries(artifacts.results)) {
      if (v === null || v === undefined) {
        resultKeys[k] = "null";
      } else if (typeof v === "number") {
        resultKeys[k] = Number.isInteger(v) ? "integer" : "number";
      } else {
        resultKeys[k] = typeof v;
      }
    }
  }

  const chartDataShapes: Record<string, { columns: string[]; rows: number }> = {};
  if (artifacts.chart_data && typeof artifacts.chart_data === "object") {
    for (const [k, v] of Object.entries(artifacts.chart_data)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
        chartDataShapes[k] = {
          columns: Object.keys(v[0] as Record<string, unknown>),
          rows: v.length,
        };
      }
    }
  }

  return {
    question,
    analysisSummary: { resultKeys, chartDataShapes },
    specSummary: summarizeSpec(spec),
  };
}

/** Active sweep (see lib/store-sweeper.ts) — expiry was lazy-read-only. */
export function sweepExpiredConversations(): number {
  const now = Date.now();
  let swept = 0;
  for (const [k, v] of cache) {
    if (isIdleExpired(v, v.updatedAt, TTL_MS, now)) {
      cache.delete(k);
      swept++;
    }
  }
  return swept;
}
