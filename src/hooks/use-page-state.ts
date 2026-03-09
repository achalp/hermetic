"use client";

import { useReducer, useCallback } from "react";
import type { Spec } from "@json-render/react";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";

interface PageState {
  currentQuestion: string | null;
  questionSeq: number;
  isAnalyzing: boolean;
  loadedSpec: Spec | null;
  loadedArtifacts: CachedArtifacts | null;
  showSaved: boolean;
  savedRefreshKey: number;
  loadingViz: boolean;
  rerunningViz: boolean;
  pendingRerunVizId: string | null;
}

type PageAction =
  | { type: "QUERY"; question: string }
  | { type: "STREAM_END" }
  | { type: "RESET" }
  | { type: "LOAD_VIZ_START" }
  | { type: "LOAD_VIZ_SUCCESS"; question: string; spec: Spec; artifacts: CachedArtifacts | null }
  | { type: "LOAD_VIZ_ERROR" }
  | { type: "TOGGLE_SAVED" }
  | { type: "VIZ_SAVED" }
  | { type: "RERUN_START" }
  | { type: "RERUN_FAST_SUCCESS"; spec: Spec; artifacts: CachedArtifacts | null }
  | { type: "RERUN_STREAM_START"; question: string; vizId: string }
  | { type: "RERUN_ERROR" }
  | { type: "CLEAR_PENDING_RERUN" };

const initialState: PageState = {
  currentQuestion: null,
  questionSeq: 0,
  isAnalyzing: false,
  loadedSpec: null,
  loadedArtifacts: null,
  showSaved: false,
  savedRefreshKey: 0,
  loadingViz: false,
  rerunningViz: false,
  pendingRerunVizId: null,
};

export function pageReducer(state: PageState, action: PageAction): PageState {
  switch (action.type) {
    case "QUERY":
      return {
        ...state,
        currentQuestion: action.question,
        questionSeq: state.questionSeq + 1,
        isAnalyzing: true,
        loadedSpec: null,
      };
    case "STREAM_END":
      return { ...state, isAnalyzing: false };
    case "RESET":
      return {
        ...initialState,
        showSaved: state.showSaved,
        savedRefreshKey: state.savedRefreshKey,
      };
    case "LOAD_VIZ_START":
      return { ...state, loadingViz: true, loadedSpec: null, loadedArtifacts: null };
    case "LOAD_VIZ_SUCCESS":
      return {
        ...state,
        loadingViz: false,
        currentQuestion: action.question,
        loadedSpec: action.spec,
        loadedArtifacts: action.artifacts,
        showSaved: false,
      };
    case "LOAD_VIZ_ERROR":
      return { ...state, loadingViz: false };
    case "TOGGLE_SAVED":
      return { ...state, showSaved: !state.showSaved };
    case "VIZ_SAVED":
      return { ...state, savedRefreshKey: state.savedRefreshKey + 1 };
    case "RERUN_START":
      return { ...state, rerunningViz: true };
    case "RERUN_FAST_SUCCESS":
      return {
        ...state,
        rerunningViz: false,
        loadedSpec: action.spec,
        loadedArtifacts: action.artifacts,
        showSaved: false,
        savedRefreshKey: state.savedRefreshKey + 1,
      };
    case "RERUN_STREAM_START":
      return {
        ...state,
        rerunningViz: false,
        pendingRerunVizId: action.vizId,
        currentQuestion: action.question,
        questionSeq: state.questionSeq + 1,
        isAnalyzing: true,
        loadedSpec: null,
      };
    case "RERUN_ERROR":
      return { ...state, rerunningViz: false };
    case "CLEAR_PENDING_RERUN":
      return { ...state, pendingRerunVizId: null };
  }
}

export function usePageState() {
  const [state, dispatch] = useReducer(pageReducer, initialState);

  const query = useCallback((question: string) => {
    dispatch({ type: "QUERY", question });
  }, []);

  const streamEnd = useCallback(() => {
    dispatch({ type: "STREAM_END" });
  }, []);

  const resetPage = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  const toggleSaved = useCallback(() => {
    dispatch({ type: "TOGGLE_SAVED" });
  }, []);

  const vizSaved = useCallback(() => {
    dispatch({ type: "VIZ_SAVED" });
  }, []);

  return { state, dispatch, query, streamEnd, resetPage, toggleSaved, vizSaved };
}
