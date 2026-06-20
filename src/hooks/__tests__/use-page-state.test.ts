import { describe, it, expect } from "vitest";
import { pageReducer } from "@/hooks/use-page-state";

// Rebuild the reducer's initial state by reading the source defaults.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeSpec = (id = "r") => ({ root: id, elements: {} }) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeArtifacts = (id = "a") => ({ id }) as any;

describe("pageReducer", () => {
  describe("QUERY", () => {
    it("sets question, increments seq, starts analyzing, clears loadedSpec + rerun fields", () => {
      const state = pageReducer(initial, { type: "QUERY", question: "How many rows?" });
      expect(state.currentQuestion).toBe("How many rows?");
      expect(state.questionSeq).toBe(1);
      expect(state.isAnalyzing).toBe(true);
      expect(state.loadedSpec).toBeNull();
      expect(state.rerunCode).toBeNull();
      expect(state.rerunSql).toBeNull();
    });

    it("defaults currentMode to 'ask' when no mode given", () => {
      const state = pageReducer(initial, { type: "QUERY", question: "Q" });
      expect(state.currentMode).toBe("ask");
    });

    it("sets currentMode='investigate' when mode provided", () => {
      const state = pageReducer(initial, {
        type: "QUERY",
        question: "Why did revenue dip?",
        mode: "investigate",
      });
      expect(state.currentMode).toBe("investigate");
      expect(state.isAnalyzing).toBe(true);
    });

    it("increments seq on each successive QUERY", () => {
      const s1 = pageReducer(initial, { type: "QUERY", question: "Q1" });
      const s2 = pageReducer(s1, { type: "QUERY", question: "Q2" });
      expect(s2.questionSeq).toBe(2);
      expect(s2.currentQuestion).toBe("Q2");
    });

    it("clears stale loadedSpec and rerun fields from a prior state", () => {
      const dirty = {
        ...initial,
        loadedSpec: makeSpec(),
        rerunCode: "x = 1",
        rerunSql: "SELECT 1",
        currentMode: "investigate" as const,
      };
      const state = pageReducer(dirty, { type: "QUERY", question: "New Q" });
      expect(state.loadedSpec).toBeNull();
      expect(state.rerunCode).toBeNull();
      expect(state.rerunSql).toBeNull();
      // mode falls back to default 'ask' because none was passed
      expect(state.currentMode).toBe("ask");
    });

    it("preserves unrelated fields (loadedArtifacts, savedRefreshKey, showSaved, pendingRerunVizId)", () => {
      const prior = {
        ...initial,
        loadedArtifacts: makeArtifacts(),
        savedRefreshKey: 7,
        showSaved: true,
        pendingRerunVizId: "viz-9",
      };
      const state = pageReducer(prior, { type: "QUERY", question: "Q" });
      expect(state.loadedArtifacts).toBe(prior.loadedArtifacts);
      expect(state.savedRefreshKey).toBe(7);
      expect(state.showSaved).toBe(true);
      expect(state.pendingRerunVizId).toBe("viz-9");
    });
  });

  describe("RERUN_WITH_EDITS", () => {
    it("sets rerunCode and bumps seq when only code provided", () => {
      const state = pageReducer(initial, {
        type: "RERUN_WITH_EDITS",
        question: "What is the total?",
        code: "import pandas as pd",
      });
      expect(state.questionSeq).toBe(1);
      expect(state.rerunCode).toBe("import pandas as pd");
      expect(state.rerunSql).toBeNull();
      expect(state.isAnalyzing).toBe(true);
      expect(state.currentQuestion).toBe("What is the total?");
      expect(state.loadedSpec).toBeNull();
    });

    it("sets rerunSql when only sql provided", () => {
      const state = pageReducer(initial, {
        type: "RERUN_WITH_EDITS",
        question: "Top customers",
        sql: "SELECT * FROM customers LIMIT 10",
      });
      expect(state.rerunSql).toContain("SELECT");
      expect(state.rerunCode).toBeNull();
      expect(state.questionSeq).toBe(1);
      expect(state.isAnalyzing).toBe(true);
    });

    it("sets both rerunCode and rerunSql when both provided", () => {
      const state = pageReducer(initial, {
        type: "RERUN_WITH_EDITS",
        question: "Q",
        code: "x = 1",
        sql: "SELECT 1",
      });
      expect(state.rerunCode).toBe("x = 1");
      expect(state.rerunSql).toBe("SELECT 1");
    });

    it("defaults rerunCode/rerunSql to null when neither provided", () => {
      const state = pageReducer(initial, { type: "RERUN_WITH_EDITS", question: "Q" });
      expect(state.rerunCode).toBeNull();
      expect(state.rerunSql).toBeNull();
    });

    it("forces currentMode back to 'ask' even from investigate", () => {
      const investigating = { ...initial, currentMode: "investigate" as const };
      const state = pageReducer(investigating, {
        type: "RERUN_WITH_EDITS",
        question: "Q",
        code: "x = 1",
      });
      expect(state.currentMode).toBe("ask");
    });

    it("preserves unrelated fields (savedRefreshKey, loadedArtifacts, pendingRerunVizId)", () => {
      const prior = {
        ...initial,
        savedRefreshKey: 4,
        loadedArtifacts: makeArtifacts(),
        pendingRerunVizId: "v1",
      };
      const state = pageReducer(prior, { type: "RERUN_WITH_EDITS", question: "Q", code: "c" });
      expect(state.savedRefreshKey).toBe(4);
      expect(state.loadedArtifacts).toBe(prior.loadedArtifacts);
      expect(state.pendingRerunVizId).toBe("v1");
    });
  });

  describe("STREAM_END", () => {
    it("clears isAnalyzing, rerunCode and rerunSql", () => {
      const mid = {
        ...initial,
        isAnalyzing: true,
        rerunCode: "x = 1",
        rerunSql: "SELECT 1",
      };
      const state = pageReducer(mid, { type: "STREAM_END" });
      expect(state.isAnalyzing).toBe(false);
      expect(state.rerunCode).toBeNull();
      expect(state.rerunSql).toBeNull();
    });

    it("preserves currentQuestion, questionSeq and loaded data", () => {
      const mid = {
        ...initial,
        isAnalyzing: true,
        currentQuestion: "Q",
        questionSeq: 5,
        loadedSpec: makeSpec(),
        loadedArtifacts: makeArtifacts(),
      };
      const state = pageReducer(mid, { type: "STREAM_END" });
      expect(state.currentQuestion).toBe("Q");
      expect(state.questionSeq).toBe(5);
      expect(state.loadedSpec).toBe(mid.loadedSpec);
      expect(state.loadedArtifacts).toBe(mid.loadedArtifacts);
    });
  });

  describe("RESET", () => {
    it("returns to initial defaults but preserves showSaved and savedRefreshKey", () => {
      const dirty = {
        ...initial,
        currentQuestion: "Q",
        questionSeq: 3,
        isAnalyzing: true,
        currentMode: "investigate" as const,
        loadedSpec: makeSpec(),
        loadedArtifacts: makeArtifacts(),
        loadingViz: true,
        rerunningViz: true,
        pendingRerunVizId: "v9",
        rerunCode: "c",
        rerunSql: "s",
        showSaved: true,
        savedRefreshKey: 5,
      };
      const state = pageReducer(dirty, { type: "RESET" });
      expect(state.currentQuestion).toBeNull();
      expect(state.questionSeq).toBe(0);
      expect(state.isAnalyzing).toBe(false);
      expect(state.currentMode).toBe("ask");
      expect(state.loadedSpec).toBeNull();
      expect(state.loadedArtifacts).toBeNull();
      expect(state.loadingViz).toBe(false);
      expect(state.rerunningViz).toBe(false);
      expect(state.pendingRerunVizId).toBeNull();
      expect(state.rerunCode).toBeNull();
      expect(state.rerunSql).toBeNull();
      // preserved:
      expect(state.showSaved).toBe(true);
      expect(state.savedRefreshKey).toBe(5);
    });
  });

  describe("LOAD_VIZ_START", () => {
    it("sets loadingViz and clears loaded spec + artifacts", () => {
      const prior = { ...initial, loadedSpec: makeSpec(), loadedArtifacts: makeArtifacts() };
      const state = pageReducer(prior, { type: "LOAD_VIZ_START" });
      expect(state.loadingViz).toBe(true);
      expect(state.loadedSpec).toBeNull();
      expect(state.loadedArtifacts).toBeNull();
    });

    it("preserves currentQuestion and savedRefreshKey", () => {
      const prior = { ...initial, currentQuestion: "Q", savedRefreshKey: 2 };
      const state = pageReducer(prior, { type: "LOAD_VIZ_START" });
      expect(state.currentQuestion).toBe("Q");
      expect(state.savedRefreshKey).toBe(2);
    });
  });

  describe("LOAD_VIZ_SUCCESS", () => {
    it("sets loaded state, question, and hides saved panel", () => {
      const spec = makeSpec();
      const artifacts = makeArtifacts();
      const loading = { ...initial, loadingViz: true, showSaved: true };
      const state = pageReducer(loading, {
        type: "LOAD_VIZ_SUCCESS",
        question: "Q",
        spec,
        artifacts,
      });
      expect(state.loadingViz).toBe(false);
      expect(state.currentQuestion).toBe("Q");
      expect(state.loadedSpec).toBe(spec);
      expect(state.loadedArtifacts).toBe(artifacts);
      expect(state.showSaved).toBe(false);
    });

    it("accepts null artifacts", () => {
      const state = pageReducer(initial, {
        type: "LOAD_VIZ_SUCCESS",
        question: "Q",
        spec: makeSpec(),
        artifacts: null,
      });
      expect(state.loadedArtifacts).toBeNull();
    });

    it("preserves savedRefreshKey and questionSeq", () => {
      const prior = { ...initial, savedRefreshKey: 9, questionSeq: 4 };
      const state = pageReducer(prior, {
        type: "LOAD_VIZ_SUCCESS",
        question: "Q",
        spec: makeSpec(),
        artifacts: null,
      });
      expect(state.savedRefreshKey).toBe(9);
      expect(state.questionSeq).toBe(4);
    });
  });

  describe("LOAD_VIZ_ERROR", () => {
    it("clears loadingViz and preserves everything else", () => {
      const loading = { ...initial, loadingViz: true, currentQuestion: "Q", savedRefreshKey: 3 };
      const state = pageReducer(loading, { type: "LOAD_VIZ_ERROR" });
      expect(state.loadingViz).toBe(false);
      expect(state.currentQuestion).toBe("Q");
      expect(state.savedRefreshKey).toBe(3);
    });
  });

  describe("TOGGLE_SAVED", () => {
    it("flips showSaved from false to true and back", () => {
      const s1 = pageReducer(initial, { type: "TOGGLE_SAVED" });
      expect(s1.showSaved).toBe(true);
      const s2 = pageReducer(s1, { type: "TOGGLE_SAVED" });
      expect(s2.showSaved).toBe(false);
    });

    it("does not touch other fields", () => {
      const prior = { ...initial, currentQuestion: "Q", savedRefreshKey: 2 };
      const state = pageReducer(prior, { type: "TOGGLE_SAVED" });
      expect(state.currentQuestion).toBe("Q");
      expect(state.savedRefreshKey).toBe(2);
    });
  });

  describe("VIZ_SAVED", () => {
    it("increments savedRefreshKey", () => {
      const state = pageReducer(initial, { type: "VIZ_SAVED" });
      expect(state.savedRefreshKey).toBe(1);
      const again = pageReducer(state, { type: "VIZ_SAVED" });
      expect(again.savedRefreshKey).toBe(2);
    });

    it("does not change showSaved or loaded data", () => {
      const prior = { ...initial, showSaved: true, loadedSpec: makeSpec() };
      const state = pageReducer(prior, { type: "VIZ_SAVED" });
      expect(state.showSaved).toBe(true);
      expect(state.loadedSpec).toBe(prior.loadedSpec);
    });
  });

  describe("RERUN_START", () => {
    it("sets rerunningViz true and preserves rest", () => {
      const prior = { ...initial, currentQuestion: "Q", loadedSpec: makeSpec() };
      const state = pageReducer(prior, { type: "RERUN_START" });
      expect(state.rerunningViz).toBe(true);
      expect(state.currentQuestion).toBe("Q");
      expect(state.loadedSpec).toBe(prior.loadedSpec);
    });
  });

  describe("RERUN_FAST_SUCCESS", () => {
    it("clears rerunningViz, sets new spec/artifacts, hides saved, bumps savedRefreshKey", () => {
      const spec = makeSpec("new");
      const artifacts = makeArtifacts("new");
      const mid = { ...initial, rerunningViz: true, showSaved: true, savedRefreshKey: 2 };
      const state = pageReducer(mid, {
        type: "RERUN_FAST_SUCCESS",
        spec,
        artifacts,
      });
      expect(state.rerunningViz).toBe(false);
      expect(state.loadedSpec).toBe(spec);
      expect(state.loadedArtifacts).toBe(artifacts);
      expect(state.showSaved).toBe(false);
      expect(state.savedRefreshKey).toBe(3);
    });

    it("accepts null artifacts and preserves currentQuestion", () => {
      const mid = { ...initial, rerunningViz: true, currentQuestion: "Q" };
      const state = pageReducer(mid, {
        type: "RERUN_FAST_SUCCESS",
        spec: makeSpec(),
        artifacts: null,
      });
      expect(state.loadedArtifacts).toBeNull();
      expect(state.currentQuestion).toBe("Q");
    });
  });

  describe("RERUN_STREAM_START", () => {
    it("transitions to a fresh streaming query carrying the pending viz id", () => {
      const mid = { ...initial, rerunningViz: true, loadedSpec: makeSpec(), questionSeq: 2 };
      const state = pageReducer(mid, {
        type: "RERUN_STREAM_START",
        question: "Rerun Q",
        vizId: "viz-123",
      });
      expect(state.rerunningViz).toBe(false);
      expect(state.pendingRerunVizId).toBe("viz-123");
      expect(state.currentQuestion).toBe("Rerun Q");
      expect(state.questionSeq).toBe(3);
      expect(state.isAnalyzing).toBe(true);
      expect(state.currentMode).toBe("ask");
      expect(state.loadedSpec).toBeNull();
    });

    it("forces currentMode to 'ask' even when previously investigating", () => {
      const investigating = { ...initial, currentMode: "investigate" as const };
      const state = pageReducer(investigating, {
        type: "RERUN_STREAM_START",
        question: "Q",
        vizId: "v",
      });
      expect(state.currentMode).toBe("ask");
    });

    it("preserves savedRefreshKey and loadedArtifacts", () => {
      const prior = { ...initial, savedRefreshKey: 6, loadedArtifacts: makeArtifacts() };
      const state = pageReducer(prior, {
        type: "RERUN_STREAM_START",
        question: "Q",
        vizId: "v",
      });
      expect(state.savedRefreshKey).toBe(6);
      expect(state.loadedArtifacts).toBe(prior.loadedArtifacts);
    });
  });

  describe("RERUN_ERROR", () => {
    it("clears rerunningViz and preserves the rest", () => {
      const mid = { ...initial, rerunningViz: true, currentQuestion: "Q", loadedSpec: makeSpec() };
      const state = pageReducer(mid, { type: "RERUN_ERROR" });
      expect(state.rerunningViz).toBe(false);
      expect(state.currentQuestion).toBe("Q");
      expect(state.loadedSpec).toBe(mid.loadedSpec);
    });
  });

  describe("CLEAR_PENDING_RERUN", () => {
    it("clears pendingRerunVizId and preserves the rest", () => {
      const mid = {
        ...initial,
        pendingRerunVizId: "viz-1",
        currentQuestion: "Q",
        isAnalyzing: true,
      };
      const state = pageReducer(mid, { type: "CLEAR_PENDING_RERUN" });
      expect(state.pendingRerunVizId).toBeNull();
      expect(state.currentQuestion).toBe("Q");
      expect(state.isAnalyzing).toBe(true);
    });

    it("is a no-op on the id when already null", () => {
      const state = pageReducer(initial, { type: "CLEAR_PENDING_RERUN" });
      expect(state.pendingRerunVizId).toBeNull();
    });
  });

  describe("purity / immutability", () => {
    it("does not mutate the input state object", () => {
      const input = { ...initial, questionSeq: 1 };
      const snapshot = JSON.parse(JSON.stringify(input));
      pageReducer(input, { type: "QUERY", question: "Q", mode: "investigate" });
      expect(input).toEqual(snapshot);
    });

    it("returns a new object reference for state-changing actions", () => {
      const out = pageReducer(initial, { type: "TOGGLE_SAVED" });
      expect(out).not.toBe(initial);
    });

    it("RESET does not mutate input and yields a new reference", () => {
      const input = { ...initial, currentQuestion: "Q", showSaved: true };
      const snapshot = JSON.parse(JSON.stringify(input));
      const out = pageReducer(input, { type: "RESET" });
      expect(input).toEqual(snapshot);
      expect(out).not.toBe(input);
    });
  });

  describe("state-machine transitions", () => {
    it("QUERY -> STREAM_END moves from streaming to idle with question retained", () => {
      const streaming = pageReducer(initial, { type: "QUERY", question: "Q" });
      expect(streaming.isAnalyzing).toBe(true);
      const done = pageReducer(streaming, { type: "STREAM_END" });
      expect(done.isAnalyzing).toBe(false);
      expect(done.currentQuestion).toBe("Q");
      expect(done.questionSeq).toBe(1);
    });

    it("LOAD_VIZ_START -> LOAD_VIZ_SUCCESS yields a loaded has-data state", () => {
      const loading = pageReducer(initial, { type: "LOAD_VIZ_START" });
      const loaded = pageReducer(loading, {
        type: "LOAD_VIZ_SUCCESS",
        question: "Q",
        spec: makeSpec(),
        artifacts: makeArtifacts(),
      });
      expect(loaded.loadingViz).toBe(false);
      expect(loaded.loadedSpec).not.toBeNull();
      expect(loaded.loadedArtifacts).not.toBeNull();
    });

    it("RERUN_START -> RERUN_STREAM_START -> CLEAR_PENDING_RERUN full cycle", () => {
      const s1 = pageReducer(initial, { type: "RERUN_START" });
      expect(s1.rerunningViz).toBe(true);
      const s2 = pageReducer(s1, { type: "RERUN_STREAM_START", question: "Q", vizId: "v1" });
      expect(s2.rerunningViz).toBe(false);
      expect(s2.pendingRerunVizId).toBe("v1");
      expect(s2.isAnalyzing).toBe(true);
      const s3 = pageReducer(s2, { type: "CLEAR_PENDING_RERUN" });
      expect(s3.pendingRerunVizId).toBeNull();
    });

    it("RERUN_START -> RERUN_ERROR aborts back to non-rerunning", () => {
      const s1 = pageReducer(initial, { type: "RERUN_START" });
      const s2 = pageReducer(s1, { type: "RERUN_ERROR" });
      expect(s2.rerunningViz).toBe(false);
    });
  });
});
