"use client";

import { useCallback, useEffect, useState } from "react";
import { getActiveRuns, type ActiveRun } from "@/lib/api";

/**
 * Discover analyses still running server-side (they survive a client drop —
 * reload / dev HMR / navigation). Fetched on mount; the caller offers a
 * "resume" that reattaches to the live stream. Dismissals are local (session).
 */
export function useActiveRuns(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    if (!enabled) {
      setRuns([]);
      return;
    }
    void getActiveRuns().then(setRuns);
  }, [enabled]);

  useEffect(() => refresh(), [refresh]);

  const dismiss = useCallback((runId: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(runId);
      return next;
    });
  }, []);

  return { runs: runs.filter((r) => !dismissed.has(r.runId)), refresh, dismiss };
}
