"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Spec } from "@/lib/contracts/spec";

/**
 * THE page-level holder for "the analysis on screen" (modularization M5-5e).
 *
 * Replaces three of the audit's seven competing spec holders —
 * currentSpecRef, currentQuestionRef, and lastCompleteSpec — whose manual
 * synchronization was the documented source of the "Save / Export / Schedule
 * silently no-op for fresh streams" bug class: pageState.loadedSpec is only
 * set when LOADING a saved viz, so every consumer needed its own freshly-
 * streamed copy, each synced by hand in a different callback.
 *
 * One state, two write paths:
 *   - complete(spec, question)  — a stream finished (ResponsePanel)
 *   - load(spec, question)      — a saved viz / history entry was loaded
 *
 * The refs are DERIVED (kept in sync here, in one place) for consumers that
 * need render-stable identity (useSaveExport, slides export).
 */

interface CurrentAnalysis {
  spec: Spec | null;
  question: string | null;
  /** True when `spec` came from a completed stream (not a load). */
  fromStream: boolean;
}

export function useCurrentAnalysis(args: {
  loadedSpec: Spec | null | undefined;
  currentQuestion: string | null | undefined;
  isAnalyzing: boolean;
}) {
  const { loadedSpec, currentQuestion, isAnalyzing } = args;
  const [current, setCurrent] = useState<CurrentAnalysis>({
    spec: loadedSpec ?? null,
    question: currentQuestion ?? null,
    fromStream: false,
  });

  const specRef = useRef<Spec | null>(current.spec);
  const questionRef = useRef<string | null>(current.question);
  specRef.current = current.spec;
  questionRef.current = current.question;

  /** A stream completed — the freshly streamed spec is now THE analysis. */
  const complete = useCallback((spec: Spec, question: string) => {
    setCurrent({ spec, question, fromStream: true });
  }, []);

  // Loading a saved viz / history entry replaces the analysis (and clearing
  // loadedSpec clears it — matching the old currentSpecRef effect).
  useEffect(() => {
    setCurrent({
      spec: loadedSpec ?? null,
      question: currentQuestion ?? null,
      fromStream: false,
    });
  }, [loadedSpec, currentQuestion]);

  // A new analysis starting clears the fresh-stream spec so stale follow-up
  // suggestions don't linger while the new dashboard composes (the old
  // lastCompleteSpec clear-on-analyzing effect).
  useEffect(() => {
    if (isAnalyzing) {
      setCurrent((prev) => (prev.fromStream ? { ...prev, spec: null, fromStream: false } : prev));
    }
  }, [isAnalyzing]);

  return {
    /** The spec on screen (stream or load). */
    spec: current.spec,
    question: current.question,
    /** The last COMPLETED stream's spec (null while analyzing / after load). */
    freshSpec: current.fromStream ? current.spec : null,
    specRef: specRef as MutableRefObject<Spec | null>,
    questionRef: questionRef as MutableRefObject<string | null>,
    complete,
  };
}
