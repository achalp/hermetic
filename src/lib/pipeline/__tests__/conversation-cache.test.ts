import { describe, it, expect, beforeEach } from "vitest";
import {
  getConversationTurns,
  appendConversationTurn,
  clearConversationTurns,
  buildTurnFromArtifacts,
  aliasConversationKey,
} from "@/lib/pipeline/conversation-cache";
import type { ConversationTurn } from "@/lib/contracts/storage-types";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";

function makeTurn(question: string): ConversationTurn {
  return {
    question,
    analysisSummary: { resultKeys: {}, chartDataShapes: {} },
    specSummary: "",
  };
}

describe("conversation-cache", () => {
  // Use a fresh csvId per test where practical, but also clear explicitly so
  // module-level cache state never leaks between tests.
  beforeEach(() => {
    clearConversationTurns("c1");
    clearConversationTurns("c2");
    clearConversationTurns("cap");
  });

  describe("getConversationTurns", () => {
    it("returns [] for an unknown csvId", () => {
      expect(getConversationTurns("never-seen")).toEqual([]);
    });
  });

  describe("appendConversationTurn", () => {
    it("appends a single turn and returns it via get", () => {
      const t = makeTurn("q1");
      appendConversationTurn("c1", t);
      expect(getConversationTurns("c1")).toEqual([t]);
    });

    it("preserves insertion order across multiple appends", () => {
      appendConversationTurn("c1", makeTurn("q1"));
      appendConversationTurn("c1", makeTurn("q2"));
      appendConversationTurn("c1", makeTurn("q3"));
      expect(getConversationTurns("c1").map((t) => t.question)).toEqual(["q1", "q2", "q3"]);
    });

    it("isolates turns between different csvIds", () => {
      appendConversationTurn("c1", makeTurn("a"));
      appendConversationTurn("c2", makeTurn("b"));
      expect(getConversationTurns("c1").map((t) => t.question)).toEqual(["a"]);
      expect(getConversationTurns("c2").map((t) => t.question)).toEqual(["b"]);
    });

    it("caps history at MAX_TURNS (5), evicting the oldest", () => {
      for (let i = 1; i <= 7; i++) {
        appendConversationTurn("cap", makeTurn(`q${i}`));
      }
      const turns = getConversationTurns("cap");
      expect(turns).toHaveLength(5);
      // Oldest two (q1, q2) evicted; keeps the most recent five.
      expect(turns.map((t) => t.question)).toEqual(["q3", "q4", "q5", "q6", "q7"]);
    });
  });

  describe("clearConversationTurns", () => {
    it("empties one key without affecting others", () => {
      appendConversationTurn("c1", makeTurn("a"));
      appendConversationTurn("c2", makeTurn("b"));
      clearConversationTurns("c1");
      expect(getConversationTurns("c1")).toEqual([]);
      expect(getConversationTurns("c2").map((t) => t.question)).toEqual(["b"]);
    });

    it("is a no-op for an unknown csvId", () => {
      expect(() => clearConversationTurns("nope")).not.toThrow();
      expect(getConversationTurns("nope")).toEqual([]);
    });
  });

  describe("buildTurnFromArtifacts", () => {
    function makeArtifacts(over: Partial<CachedArtifacts> = {}): CachedArtifacts {
      return {
        code: "",
        question: "",
        results: {},
        chart_data: {},
        datasets: {},
        execution_ms: 0,
        ...over,
      };
    }

    it("classifies result value types (integer/number/string/null)", () => {
      const turn = buildTurnFromArtifacts(
        "How much revenue?",
        makeArtifacts({
          results: {
            total: 42,
            ratio: 3.5,
            region: "west",
            missing: null,
          },
        }),
        { root: "r", elements: {} }
      );
      expect(turn.question).toBe("How much revenue?");
      expect(turn.analysisSummary.resultKeys).toEqual({
        total: "integer",
        ratio: "number",
        region: "string",
        missing: "null",
      });
    });

    it("treats undefined result values as 'null'", () => {
      const turn = buildTurnFromArtifacts("q", makeArtifacts({ results: { gone: undefined } }), {
        root: "r",
        elements: {},
      });
      expect(turn.analysisSummary.resultKeys).toEqual({ gone: "null" });
    });

    it("summarizes chart_data into columns + row count, skipping empty/non-array", () => {
      const turn = buildTurnFromArtifacts(
        "q",
        makeArtifacts({
          chart_data: {
            sales: [
              { month: "Jan", revenue: 100 },
              { month: "Feb", revenue: 200 },
            ],
            empty: [],
            notArray: { foo: 1 },
          },
        }),
        { root: "r", elements: {} }
      );
      expect(turn.analysisSummary.chartDataShapes).toEqual({
        sales: { columns: ["month", "revenue"], rows: 2 },
      });
    });

    it("includes a specSummary derived from the spec", () => {
      const spec = {
        root: "root",
        elements: {
          root: { type: "TextBlock", props: { content: "Hello" }, children: [] },
        },
      };
      const turn = buildTurnFromArtifacts("q", makeArtifacts(), spec);
      expect(turn.specSummary).toContain("TextBlock");
      expect(turn.specSummary).toContain("Hello");
    });

    it("produces empty summaries when artifacts have no results or chart_data", () => {
      const turn = buildTurnFromArtifacts("q", makeArtifacts(), { root: "r", elements: {} });
      expect(turn.analysisSummary.resultKeys).toEqual({});
      expect(turn.analysisSummary.chartDataShapes).toEqual({});
    });
  });

  describe("sql on warehouse turns", () => {
    it("buildTurnFromArtifacts carries artifacts.sql into the turn", () => {
      const turn = buildTurnFromArtifacts(
        "revenue by region?",
        {
          code: "",
          question: "",
          results: {},
          chart_data: {},
          datasets: {},
          execution_ms: 0,
          sql: "SELECT region, SUM(revenue) FROM orders GROUP BY 1",
        },
        { root: "r", elements: {} }
      );
      expect(turn.sql).toBe("SELECT region, SUM(revenue) FROM orders GROUP BY 1");
    });

    it("omits the sql field entirely for non-warehouse turns", () => {
      const turn = buildTurnFromArtifacts(
        "q",
        { code: "", question: "", results: {}, chart_data: {}, datasets: {}, execution_ms: 0 },
        { root: "r", elements: {} }
      );
      expect("sql" in turn).toBe(false);
    });
  });

  describe("conversation key aliases", () => {
    it("reads via an alias land on the canonical conversation", () => {
      appendConversationTurn("wh-stable", makeTurn("first"));
      aliasConversationKey("snapshot-abc", "wh-stable");
      expect(getConversationTurns("snapshot-abc").map((t) => t.question)).toEqual(["first"]);
    });

    it("appends via an alias land on the canonical conversation", () => {
      aliasConversationKey("snapshot-def", "wh-stable2");
      appendConversationTurn("snapshot-def", makeTurn("via-alias"));
      expect(getConversationTurns("wh-stable2").map((t) => t.question)).toEqual(["via-alias"]);
    });

    it("clearing via an alias clears the canonical conversation", () => {
      appendConversationTurn("wh-stable3", makeTurn("x"));
      aliasConversationKey("snapshot-ghi", "wh-stable3");
      clearConversationTurns("snapshot-ghi");
      expect(getConversationTurns("wh-stable3")).toEqual([]);
    });

    it("self-aliases are ignored", () => {
      aliasConversationKey("same", "same");
      appendConversationTurn("same", makeTurn("ok"));
      expect(getConversationTurns("same").map((t) => t.question)).toEqual(["ok"]);
    });
  });
});
