// @vitest-environment jsdom
//
// Guards the sampled-dataset correctness fix: when /datasets/main is a SAMPLE
// (sample_note set), the DataController must KEEP the exact pre-computed seeds
// for /computed/* while no filter is active, instead of re-aggregating the
// truncated sample (which shows the wrong rows and drops Python-derived fields
// like a display label — the Seattle "top 20" bug).
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { StateProvider, useStateValue } from "@json-render/react";
import { DataControllerComponent } from "@/components/controllers/data-controller";

afterEach(cleanup);

// Seed = the exact full-data top row (has a `label` the sample rows lack).
const SEED = [{ id: "seed1", nn: 999, label: "KEEP" }];
// Sample = the truncated /datasets/main; re-aggregating it would win with s2.
const SAMPLE = [
  { id: "s1", nn: 10, subtype: "a" },
  { id: "s2", nn: 20, subtype: "b" },
];

function Readout() {
  const v = useStateValue<unknown[]>("/computed/top20");
  return <div data-testid="out">{JSON.stringify(v)}</div>;
}

function renderController(sampleNote: string | null) {
  const props = {
    source: { statePath: "/datasets/main" },
    filters: [
      {
        key: "subtype",
        column: "subtype",
        bindTo: "/filters/subtype",
        label: "Subtype",
        allowAll: true,
      },
    ],
    pipeline: [{ op: "filter" }],
    outputs: [
      {
        statePath: "/computed/top20",
        pipeline: [
          { op: "sort", column: "nn", direction: "desc" },
          { op: "limit", count: 20 },
        ],
      },
    ],
    sample_note: sampleNote,
  };
  return render(
    <StateProvider
      initialState={{
        datasets: { main: SAMPLE },
        computed: { top20: SEED },
        filters: { subtype: "All" },
      }}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <DataControllerComponent props={props as any}>
        <Readout />
      </DataControllerComponent>
    </StateProvider>
  );
}

describe("DataController — sampled data keeps exact seeds", () => {
  it("preserves the pre-computed seed (label + row) when sample_note is set and no filter is active", async () => {
    renderController("computed on a sample of 5,000 rows");
    await waitFor(() => {
      const out = screen.getByTestId("out").textContent ?? "";
      expect(out).toContain("KEEP"); // Python-derived label survived
      expect(out).toContain("seed1"); // the correct (full-data) row, not s2
      expect(out).not.toContain("s2");
    });
    // The caveat banner is shown.
    expect(screen.getByRole("note").textContent).toContain("sample");
  });

  it("re-aggregates the sample when NOT flagged (control: seed is overwritten)", async () => {
    renderController(null);
    await waitFor(() => {
      const out = screen.getByTestId("out").textContent ?? "";
      // Recomputed from the sample: s2 wins, seed label is gone.
      expect(out).toContain("s2");
      expect(out).not.toContain("KEEP");
    });
  });
});
