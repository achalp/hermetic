import { describe, it, expect } from "vitest";
import { pageReducer } from "@/hooks/use-page-state";

const initial = {
  currentQuestion: null,
  questionSeq: 0,
  isAnalyzing: false,
  currentMode: "ask" as const,
  loadedSpec: null,
  loadedArtifacts: null,
  showSaved: false,
  savedRefreshKey: 0,
  loadingViz: false,
  rerunningViz: false,
  pendingRerunVizId: null,
  rerunCode: null,
  rerunSql: null,
};

describe("pageReducer", () => {
  it("QUERY sets question, increments seq, starts analyzing", () => {
    const state = pageReducer(initial, { type: "QUERY", question: "How many rows?" });
    expect(state.currentQuestion).toBe("How many rows?");
    expect(state.questionSeq).toBe(1);
    expect(state.isAnalyzing).toBe(true);
    expect(state.loadedSpec).toBeNull();
  });

  it("QUERY increments seq each time", () => {
    const s1 = pageReducer(initial, { type: "QUERY", question: "Q1" });
    const s2 = pageReducer(s1, { type: "QUERY", question: "Q2" });
    expect(s2.questionSeq).toBe(2);
    expect(s2.currentQuestion).toBe("Q2");
  });

  it("QUERY defaults currentMode to 'ask' when no mode is given", () => {
    const state = pageReducer(initial, { type: "QUERY", question: "Q" });
    expect(state.currentMode).toBe("ask");
  });

  it("QUERY with mode='investigate' sets currentMode", () => {
    const state = pageReducer(initial, {
      type: "QUERY",
      question: "Why did revenue dip in Q3?",
      mode: "investigate",
    });
    expect(state.currentMode).toBe("investigate");
    expect(state.isAnalyzing).toBe(true);
  });

  it("RERUN_WITH_EDITS forces currentMode back to 'ask'", () => {
    const investigating = { ...initial, currentMode: "investigate" as const };
    const state = pageReducer(investigating, {
      type: "RERUN_WITH_EDITS",
      question: "Q",
      code: "x = 1",
    });
    expect(state.currentMode).toBe("ask");
  });

  it("STREAM_END clears isAnalyzing", () => {
    const analyzing = { ...initial, isAnalyzing: true };
    const state = pageReducer(analyzing, { type: "STREAM_END" });
    expect(state.isAnalyzing).toBe(false);
  });

  it("RESET returns to initial but preserves showSaved and savedRefreshKey", () => {
    const dirty = {
      ...initial,
      currentQuestion: "Q",
      questionSeq: 3,
      isAnalyzing: true,
      showSaved: true,
      savedRefreshKey: 5,
    };
    const state = pageReducer(dirty, { type: "RESET" });
    expect(state.currentQuestion).toBeNull();
    expect(state.questionSeq).toBe(0);
    expect(state.isAnalyzing).toBe(false);
    expect(state.showSaved).toBe(true);
    expect(state.savedRefreshKey).toBe(5);
  });

  it("LOAD_VIZ_START sets loadingViz", () => {
    const state = pageReducer(initial, { type: "LOAD_VIZ_START" });
    expect(state.loadingViz).toBe(true);
  });

  it("LOAD_VIZ_SUCCESS sets loaded state and hides saved panel", () => {
    const loading = { ...initial, loadingViz: true, showSaved: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec = { root: "r", elements: {} } as any;
    const state = pageReducer(loading, {
      type: "LOAD_VIZ_SUCCESS",
      question: "Q",
      spec,
      artifacts: null,
    });
    expect(state.loadingViz).toBe(false);
    expect(state.currentQuestion).toBe("Q");
    expect(state.loadedSpec).toBe(spec);
    expect(state.showSaved).toBe(false);
  });

  it("LOAD_VIZ_ERROR clears loadingViz", () => {
    const loading = { ...initial, loadingViz: true };
    const state = pageReducer(loading, { type: "LOAD_VIZ_ERROR" });
    expect(state.loadingViz).toBe(false);
  });

  it("TOGGLE_SAVED flips showSaved", () => {
    const s1 = pageReducer(initial, { type: "TOGGLE_SAVED" });
    expect(s1.showSaved).toBe(true);
    const s2 = pageReducer(s1, { type: "TOGGLE_SAVED" });
    expect(s2.showSaved).toBe(false);
  });

  it("VIZ_SAVED increments savedRefreshKey", () => {
    const state = pageReducer(initial, { type: "VIZ_SAVED" });
    expect(state.savedRefreshKey).toBe(1);
  });

  it("prevents impossible state: QUERY clears loadedSpec", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withLoaded = { ...initial, loadedSpec: { root: "r", elements: {} } as any };
    const state = pageReducer(withLoaded, { type: "QUERY", question: "New Q" });
    expect(state.loadedSpec).toBeNull();
    expect(state.isAnalyzing).toBe(true);
  });

  describe("RERUN_WITH_EDITS", () => {
    it("sets rerunCode and bumps questionSeq when only code is provided", () => {
      const state = pageReducer(initial, {
        type: "RERUN_WITH_EDITS",
        question: "What is the total?",
        code: "import pandas as pd\n# edited code",
      });
      expect(state.questionSeq).toBe(1);
      expect(state.rerunCode).toBe("import pandas as pd\n# edited code");
      expect(state.rerunSql).toBeNull();
      expect(state.isAnalyzing).toBe(true);
      expect(state.currentQuestion).toBe("What is the total?");
      expect(state.loadedSpec).toBeNull();
    });

    it("sets rerunSql when only sql is provided", () => {
      const state = pageReducer(initial, {
        type: "RERUN_WITH_EDITS",
        question: "Top customers",
        sql: "SELECT * FROM customers WHERE active = TRUE LIMIT 10",
      });
      expect(state.rerunSql).toContain("SELECT");
      expect(state.rerunCode).toBeNull();
      expect(state.questionSeq).toBe(1);
      expect(state.isAnalyzing).toBe(true);
    });

    it("sets both rerunCode and rerunSql when both are provided", () => {
      const state = pageReducer(initial, {
        type: "RERUN_WITH_EDITS",
        question: "Q",
        code: "x = 1",
        sql: "SELECT 1",
      });
      expect(state.rerunCode).toBe("x = 1");
      expect(state.rerunSql).toBe("SELECT 1");
    });

    it("STREAM_END clears both rerunCode and rerunSql", () => {
      const mid = pageReducer(initial, {
        type: "RERUN_WITH_EDITS",
        question: "Q",
        code: "x = 1",
        sql: "SELECT 1",
      });
      const after = pageReducer(mid, { type: "STREAM_END" });
      expect(after.rerunCode).toBeNull();
      expect(after.rerunSql).toBeNull();
      expect(after.isAnalyzing).toBe(false);
    });

    it("plain QUERY clears both rerunCode and rerunSql", () => {
      const mid = pageReducer(initial, {
        type: "RERUN_WITH_EDITS",
        question: "Q",
        code: "x = 1",
        sql: "SELECT 1",
      });
      const fresh = pageReducer(mid, { type: "QUERY", question: "fresh question" });
      expect(fresh.rerunCode).toBeNull();
      expect(fresh.rerunSql).toBeNull();
    });
  });
});
