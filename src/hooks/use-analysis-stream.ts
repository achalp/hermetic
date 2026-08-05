"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useUIStream } from "@/spec/react";
import type { Spec } from "@/lib/contracts/spec";
import type { AnalysisRequestContext } from "@/lib/contracts/analysis-request";
import type { SchemaMode } from "@/lib/contracts/data-schema";
import { readStreamState, type CostInfo } from "@/lib/contracts/stream-state";
import { buildInvestigateScope } from "@/components/app/spec-insights";
import { logClient } from "@/app/lib/client-log";

/**
 * The analysis stream lifecycle (modularization M5-5d), extracted from
 * ResponsePanel — which mixed transport (endpoint selection, request
 * building, the seq latch, reattach recovery) with presentation. The hook
 * owns the stream and its three spec holders (streaming spec, previousSpec
 * shown dimmed during follow-ups, and the last-completed currentSpecRef);
 * the panel keeps restore/display state and supplies two callbacks.
 *
 * The StrictMode/reattach subtleties are preserved verbatim — each carries
 * the comment documenting the bug it prevents (see the reattach effect).
 */
export interface UseAnalysisStreamArgs {
  mode: "ask" | "investigate";
  questionSeq: number;
  question: string | null | undefined;
  csvId: string | null | undefined;
  warehouseId: string | null | undefined;
  reattachRunId: string | null | undefined;
  schemaMode: SchemaMode | undefined;
  codeGenModel: string | undefined;
  uiComposeModel: string | undefined;
  sandboxRuntime: string | undefined;
  purpose: string | undefined;
  rerunCode?: string | null;
  rerunSql?: string | null;
  /** Eager notebook-cell compose only when the Notebook view is active. */
  composeCells: boolean;
  /** Panel-side resets when a new stream begins (drill stack, artifacts, flags). */
  onStreamStarting?: () => void;
  /** A stream produced a complete dashboard. */
  onCompleted?: (spec: Spec, question: string) => void;
  onCost?: (cost: CostInfo) => void;
  /** Stream ended (complete OR error) — parent clears reattachRunId etc. */
  onStreamEnd?: () => void;
  /** A reattach could not produce a dashboard — parent re-runs fresh. */
  onReattachFailed?: () => void;
}

export function useAnalysisStream(args: UseAnalysisStreamArgs) {
  const {
    mode,
    questionSeq,
    question,
    csvId,
    warehouseId,
    reattachRunId,
    schemaMode,
    codeGenModel,
    uiComposeModel,
    sandboxRuntime,
    purpose,
    rerunCode,
    rerunSql,
    composeCells,
    onStreamStarting,
    onCompleted,
    onCost,
    onStreamEnd,
    onReattachFailed,
  } = args;

  const currentSpecRef = useRef<Spec | null>(null);
  const currentQuestionRef = useRef<string | null>(question);
  const [previousSpec, setPreviousSpec] = useState<Spec | null>(null);
  const lastSeqRef = useRef(0);
  // True while the in-flight stream is a REATTACH (replay of a run that survived
  // a client drop) rather than a fresh analysis. A reattach that ends without a
  // dashboard (run was stopped / channel raced closed / buffer incomplete) must
  // NOT leave a blank page — it re-runs fresh via onReattachFailed.
  const isReattachStreamRef = useRef(false);

  // Route the next stream to the right pipeline. The hook reads `api` per
  // call inside its useCallback, so toggling here before a new questionSeq
  // is enough — no remount required.
  const apiUrl = reattachRunId
    ? "/api/query/attach"
    : mode === "investigate"
      ? "/api/query/investigate"
      : "/api/query";

  // Diagnostics for the mid-stream abort: useUIStream aborts its fetch when the
  // panel unmounts, so a long query dies if anything tears the panel down.
  const streamStartedAtRef = useRef<number | null>(null);
  // The server-side run behind the live stream (`__runId`, first state patch) —
  // the join key that lets a client-side abort diagnostic name the run it
  // interrupted instead of leaving timestamp archaeology. Captured from the
  // streaming spec below (a ref, not state — reading it must never re-render).
  const liveRunIdRef = useRef<string | null>(null);

  const { spec, isStreaming, error, send, clear } = useUIStream({
    api: apiUrl,
    onComplete: (completedSpec) => {
      // A reattach that replayed to the end but produced no dashboard means the
      // run was stopped / its channel raced closed / its buffer was incomplete.
      // Replaying it would blank the page, so re-run the question fresh instead.
      if (isReattachStreamRef.current) {
        isReattachStreamRef.current = false;
        if (!completedSpec?.root) {
          onStreamEnd?.();
          onReattachFailed?.();
          return;
        }
      }
      currentSpecRef.current = completedSpec;
      setPreviousSpec(null);
      onStreamEnd?.();
      const cost = readStreamState(completedSpec).__cost;
      if (cost) onCost?.(cost);
      if (completedSpec?.root && currentQuestionRef.current) {
        onCompleted?.(
          JSON.parse(JSON.stringify(completedSpec)) as Spec,
          currentQuestionRef.current
        );
      }
    },
    onError: (err) => {
      // Diagnostic: a mid-stream error is almost always an abort from the panel
      // unmounting (useUIStream aborts its fetch on unmount).
      const elapsed = streamStartedAtRef.current ? Date.now() - streamStartedAtRef.current : null;
      logClient(
        "warn",
        "[useAnalysisStream] stream error",
        {
          elapsedMs: elapsed,
          name: (err as { name?: string })?.name,
          message: (err as { message?: string })?.message,
        },
        liveRunIdRef.current ?? undefined
      );
      setPreviousSpec(null);
      onStreamEnd?.();
      // A reattach that errored (e.g. the attach endpoint 404'd because the run
      // ended) — recover by re-running fresh rather than stranding a blank page.
      // But an AbortError is the panel unmounting (user navigated away), NOT a
      // failed reattach — don't kick off a spurious background run in that case.
      if (isReattachStreamRef.current) {
        isReattachStreamRef.current = false;
        const aborted = (err as { name?: string })?.name === "AbortError";
        if (!aborted) onReattachFailed?.();
      }
    },
  });

  // Keep current question in sync
  useEffect(() => {
    currentQuestionRef.current = question;
  }, [question]);

  // Capture the run id off the streaming spec as soon as the first state patch
  // lands (it never changes within a stream, so first-wins).
  useEffect(() => {
    if (liveRunIdRef.current) return;
    const runId = readStreamState(spec).__runId;
    if (runId) liveRunIdRef.current = runId;
  }, [spec]);

  // Watch questionSeq changes to trigger initial queries and follow-ups
  useEffect(() => {
    if (questionSeq === 0 || questionSeq === lastSeqRef.current) return;
    lastSeqRef.current = questionSeq;

    if ((!csvId && !warehouseId) || !question) return;

    // Capture the prior result's investigation plan BEFORE it's cleared below.
    // A follow-up asked in Investigate mode on an Investigate result becomes a
    // scoped sub-investigation: the planner sees what the parent already
    // explored and goes deeper instead of repeating it. No scope on a first
    // question or an Ask-mode follow-up.
    const followUpScope =
      mode === "investigate" ? buildInvestigateScope(currentSpecRef.current) : undefined;

    // Show previous spec dimmed while streaming
    if (currentSpecRef.current) {
      setPreviousSpec(currentSpecRef.current);
    }
    currentSpecRef.current = null;
    streamStartedAtRef.current = Date.now();
    liveRunIdRef.current = null;
    onStreamStarting?.();

    // Reattach is handled by its own effect (keyed on reattachRunId), NOT here.
    // On resume the panel mounts with questionSeq already advanced, so a send in
    // this effect would fire during the initial mount — where React StrictMode's
    // dev mount→unmount→remount aborts the fetch (useUIStream aborts on unmount)
    // and this effect's lastSeqRef guard then blocks the re-send on remount,
    // stranding the attach stream (blank progress). See the reattach effect below.
    if (reattachRunId) return;

    isReattachStreamRef.current = false;
    send("", {
      csv_id: csvId ?? undefined,
      warehouse_id: warehouseId ?? undefined,
      question: question,
      schema_mode: schemaMode,
      code_gen_model: codeGenModel,
      ui_compose_model: uiComposeModel,
      sandbox_runtime: sandboxRuntime,
      purpose,
      // When set, the server uses these instead of generating fresh code/SQL
      // (Edit-and-Rerun).
      code: rerunCode ?? undefined,
      sql: rerunSql ?? undefined,
      // Scoped follow-up on a prior Investigate (investigate route only).
      scope: followUpScope,
      compose_cells: composeCells,
    } satisfies AnalysisRequestContext);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionSeq]);

  // Reattach to a run still executing server-side (replay so far, then live to
  // completion). Kept in its OWN effect keyed on reattachRunId — deliberately
  // NOT the questionSeq effect above — so it survives a remount. On resume the
  // panel mounts with reattachRunId already set, so the attach send fires during
  // the initial mount; React StrictMode (dev) then aborts that fetch on its
  // simulated unmount. Because this effect re-runs on the remount (no lastSeqRef
  // latch), useUIStream aborts the first fetch and the second one streams — the
  // questionSeq effect's guard used to swallow that retry, leaving the panel
  // stuck on the progressless seed ("Building visualization…"). Also correct in
  // production, where the effect simply runs once.
  useEffect(() => {
    if (!reattachRunId) return;
    isReattachStreamRef.current = true;
    send("", { runId: reattachRunId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reattachRunId]);

  return {
    spec,
    isStreaming,
    error,
    send,
    clear,
    previousSpec,
    setPreviousSpec,
    currentSpecRef: currentSpecRef as MutableRefObject<Spec | null>,
    currentQuestionRef: currentQuestionRef as MutableRefObject<string | null>,
    liveRunIdRef: liveRunIdRef as MutableRefObject<string | null>,
  };
}
