"use client";

import { useCallback, useEffect, useState } from "react";
import type { QueryMode } from "@/app/components/query-input";

export interface PendingAsk {
  question: string;
  mode: QueryMode;
}

/**
 * Ask-first flow glue: the home composer lets users type the question BEFORE
 * any data exists. Attaching a source is asynchronous (upload, warehouse
 * connect, schema extraction), so the question is "armed" here and fired
 * exactly once when the app reaches the ready state (data loaded, not yet
 * analyzing). Arming again replaces the previous pending ask; disarm cancels.
 */
export function usePendingAsk(ready: boolean, run: (question: string, mode: QueryMode) => void) {
  const [pending, setPending] = useState<PendingAsk | null>(null);

  useEffect(() => {
    if (!ready || !pending) return;
    // Clear BEFORE running: if run() throws or re-renders synchronously, the
    // ask must not fire twice.
    setPending(null);
    run(pending.question, pending.mode);
  }, [ready, pending, run]);

  const arm = useCallback((ask: PendingAsk) => setPending(ask), []);
  const disarm = useCallback(() => setPending(null), []);

  return { arm, disarm, isArmed: pending !== null };
}
