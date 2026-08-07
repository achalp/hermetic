import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots } from "@/lib/paths";
import { saveConventions, conventionsGuidance } from "@/lib/learning/conventions";

const COLS = ["year", "avg_price", "median_price", "menu_item_count"];
const check = (name: string, passed: boolean) => ({
  name,
  definition: `${name} policy settled over the year/median_price columns`,
  dtype: "check",
  tags: ["check", "caveat"],
  value: { passed, threshold: 124.9 },
});

describe("per-dataset conventions — judgment survives re-runs", () => {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "hermetic-conv-"));
    setPathRoots({ dataRoot: root });
  });

  it("round-trips checks into a KEEP-unless-justified guidance block", () => {
    expect(conventionsGuidance(COLS)).toBeNull();
    saveConventions(
      COLS,
      [check("median_headline_choice", true), check("thin_decade_caveat", false)],
      "how have prices changed"
    );
    const g = conventionsGuidance(COLS);
    expect(g).toContain("Established Conventions");
    expect(g).toContain("median_headline_choice");
    expect(g).toContain("thin_decade_caveat (FAILED last run)");
    expect(g).toContain("convention_change_");
    // Different column shape → different dataset → no carry-over.
    expect(conventionsGuidance(["a", "b"])).toBeNull();
  });

  it("saves nothing when a run declared no checks", () => {
    saveConventions(COLS, [
      { name: "t", definition: "a trend", dtype: "trend", value: { direction: "rising" } },
    ]);
    expect(conventionsGuidance(COLS)).toBeNull();
  });
});
