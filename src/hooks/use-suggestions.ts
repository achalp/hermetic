"use client";

/**
 * Question suggestions for the current data source — extracted from page.tsx
 * (the ~230-line suggestions cluster was a third of the Home component's
 * effect surface).
 *
 * Two independent streams:
 * 1. INITIAL suggestions for a fresh source: instant heuristics, upgraded by
 *    an LLM call (falls back to heuristics on failure or an 8s timeout).
 *    Keyed on the source (csv id / warehouse id) so switching sources resets.
 * 2. FOLLOW-UP suggestions after each completed analysis: fires once per
 *    (source + question) key, enriched with the analysis's result summary
 *    and rendered-component types.
 *
 * IMPORTANT (preserved from the inline version): the follow-up effect must
 * NOT depend on any value it sets asynchronously (e.g. fetched artifacts) —
 * that re-render would tear the effect down and AbortController.abort() would
 * cancel the in-flight fetch. The artifacts fetch happens INSIDE the effect.
 */
import { useEffect, useMemo, useState } from "react";
import type { Spec } from "@json-render/react";
import type { CSVSchema, WarehouseTableSchema } from "@/lib/types";
import {
  generateSuggestions,
  generateWarehouseSuggestions,
  summarizeAnalysisResults,
} from "@/lib/suggest-questions";
import { extractSpecComponentTypes } from "@/lib/spec-summary";
import { getArtifacts, getFollowUpSuggestions } from "@/lib/api";

export function useSuggestions(args: {
  schema: CSVSchema | null;
  warehouse: {
    isConnected: boolean;
    warehouseId: string | null;
    tableSchemas: WarehouseTableSchema[];
  };
  isAnalyzing: boolean;
  currentQuestion: string | null;
  /** Spec of the most recently completed analysis (ResponsePanel callback). */
  lastCompleteSpec: Spec | null;
  effectiveCsvId: string | null;
  csvId: string | null;
  /** Fires when the data source changes (page clears source-scoped state). */
  onSourceChange?: () => void;
}): { suggestions: string[]; followUpSuggestions: string[] } {
  const { schema, warehouse, isAnalyzing, currentQuestion, lastCompleteSpec } = args;

  // ── Initial suggestions: heuristic (instant) + LLM (async upgrade) ──
  const heuristicSuggestions = useMemo(() => {
    if (schema) return generateSuggestions(schema);
    if (warehouse.isConnected && warehouse.tableSchemas.length > 0) {
      return generateWarehouseSuggestions(warehouse.tableSchemas);
    }
    return [];
  }, [schema, warehouse.isConnected, warehouse.tableSchemas]);

  const [llmSuggestions, setLlmSuggestions] = useState<string[] | null>(null);
  const [llmFailed, setLlmFailed] = useState(false);
  const [prevSchemaKey, setPrevSchemaKey] = useState<string | null>(null);
  const schemaKey = schema
    ? `csv:${schema.csv_id}`
    : warehouse.isConnected
      ? `wh:${warehouse.warehouseId}`
      : null;
  if (schemaKey !== prevSchemaKey) {
    setPrevSchemaKey(schemaKey);
    if (schemaKey) {
      setLlmSuggestions(null);
      setLlmFailed(false);
      args.onSourceChange?.();
    }
  }

  // Fetch LLM-powered suggestions; fall back to heuristics on failure or 8s timeout
  useEffect(() => {
    if (!schemaKey) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setLlmFailed(true);
    }, 8000);

    const body = schema
      ? {
          schema: {
            row_count: schema.row_count,
            columns: schema.columns,
            detected_domain: schema.detected_domain,
            correlations: schema.correlations,
          },
        }
      : { warehouseSchema: warehouse.tableSchemas };

    fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        clearTimeout(timeout);
        if (!controller.signal.aborted && data.questions?.length) {
          setLlmSuggestions(data.questions);
        } else {
          setLlmFailed(true);
        }
      })
      .catch(() => {
        clearTimeout(timeout);
        if (!controller.signal.aborted) setLlmFailed(true);
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  // ── Follow-up suggestions: fire after each successful analysis ──
  // Keyed on (source + question) so the same analysis doesn't re-fetch on
  // rerenders, and a fresh question/source clears the prior follow-ups.
  const [followUpSuggestions, setFollowUpSuggestions] = useState<string[]>([]);
  const [followUpKey, setFollowUpKey] = useState<string | null>(null);

  useEffect(() => {
    if (isAnalyzing) return;
    if (!lastCompleteSpec || !currentQuestion) return;
    if (!schema && !warehouse.tableSchemas.length) return;

    const key = `${args.effectiveCsvId ?? args.csvId ?? warehouse.warehouseId ?? ""}|${currentQuestion}`;
    if (key === followUpKey) return; // already fetched for this analysis

    setFollowUpKey(key);
    setFollowUpSuggestions([]); // clear previous while loading

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const body = schema
      ? {
          schema: {
            row_count: schema.row_count,
            columns: schema.columns,
            detected_domain: schema.detected_domain,
            correlations: schema.correlations,
          },
        }
      : { warehouseSchema: warehouse.tableSchemas };

    const cid = args.effectiveCsvId ?? args.csvId;
    const specSummary = extractSpecComponentTypes(lastCompleteSpec);

    (async () => {
      let resultsSummary: Record<string, string> | undefined;
      if (cid) {
        try {
          const artifacts = await getArtifacts(cid);
          if (controller.signal.aborted) return;
          resultsSummary = summarizeAnalysisResults(artifacts.results);
        } catch {
          // artifacts unavailable — continue without the result summary
        }
      }

      try {
        const questions = await getFollowUpSuggestions(
          { ...body, question: currentQuestion, resultsSummary, specSummary },
          controller.signal
        );
        clearTimeout(timeout);
        if (controller.signal.aborted) return;
        setFollowUpSuggestions(questions);
      } catch {
        clearTimeout(timeout);
        // best-effort — no follow-ups is a fine outcome
      }
    })();

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isAnalyzing,
    lastCompleteSpec,
    currentQuestion,
    args.effectiveCsvId,
    args.csvId,
    warehouse.warehouseId,
  ]);

  // Clear stale follow-ups while the next analysis streams.
  useEffect(() => {
    if (isAnalyzing) setFollowUpSuggestions([]);
  }, [isAnalyzing]);

  // LLM first; heuristics only if LLM failed or timed out
  const suggestions = llmSuggestions ?? (llmFailed ? heuristicSuggestions : []);
  return { suggestions, followUpSuggestions };
}
