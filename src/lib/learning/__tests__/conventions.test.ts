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

describe("bad conventions cannot bake in", () => {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "hermetic-conv2-"));
    setPathRoots({ dataRoot: root });
  });

  it("a later run MERGES — it cannot silently overwrite a settled convention", () => {
    saveConventions(COLS, [check("median_headline_choice", true)]);
    // A regression run declaring a DIFFERENT check must not erase the prior one.
    saveConventions(COLS, [check("mean_everywhere", true)]);
    const g = conventionsGuidance(COLS)!;
    expect(g).toContain("median_headline_choice");
    expect(g).toContain("mean_everywhere");
  });

  it("replacing a convention requires the explicit change protocol", () => {
    saveConventions(COLS, [check("median_headline_choice", true)]);
    saveConventions(COLS, [check("convention_change_median_headline_choice", true)]);
    const g = conventionsGuidance(COLS)!;
    expect(g).not.toMatch(/- median_headline_choice/);
    expect(g).toContain("convention_change_median_headline_choice");
  });

  it("a degraded run writes nothing", () => {
    saveConventions(COLS, [check("good_policy", true)]);
    saveConventions(COLS, [check("stub_garbage", true)], "q", { degraded: true });
    const g = conventionsGuidance(COLS)!;
    expect(g).toContain("good_policy");
    expect(g).not.toContain("stub_garbage");
  });

  it("conventions the model stops re-declaring decay after 5 saves", () => {
    saveConventions(COLS, [check("fading_policy", true)]);
    for (let i = 0; i < 6; i++) {
      saveConventions(COLS, [check("stable_policy", true)]);
    }
    const g = conventionsGuidance(COLS)!;
    expect(g).toContain("stable_policy");
    expect(g).not.toContain("fading_policy");
  });
});

describe("lint-flagged checks never persist (the 9-run boolean flag)", () => {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "hermetic-conv3-"));
    setPathRoots({ dataRoot: root });
  });

  it("excludeNames keeps a contradicted check out of the store", () => {
    saveConventions(
      COLS,
      [check("good_policy", true), check("min_price_boolean_flag", true)],
      "q",
      { excludeNames: ["min_price_boolean_flag"] }
    );
    const g = conventionsGuidance(COLS)!;
    expect(g).toContain("good_policy");
    expect(g).not.toContain("min_price_boolean_flag");
  });
});
