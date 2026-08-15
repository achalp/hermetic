/**
 * Edit-path geometry persistence (finding 08/H3): the edit recompile used to
 * run compileDashboard WITHOUT a geojsonKey, so after ANY edit the compiled
 * map was skipped and a MapView's polygons fell back to $chartData:geojson —
 * wrong under Investigate's step-prefixed keys (step_2_geojson) — and the map
 * silently vanished for good (the recompiled spec is persisted). The key is
 * now persisted on the PlanDocument and threaded through the recompile.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots } from "@/lib/paths";
import { editDashboard } from "@/lib/compose/edit";
import { cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import type { FindingsManifest } from "@/lib/contracts/findings";
import type { Spec } from "@/spec/core";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hermetic-edit-geojson-"));
  setPathRoots({ dataRoot: dir });
});
afterAll(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

const MANIFEST: FindingsManifest = {
  manifest_version: "1",
  findings: [
    {
      name: "step_2.zone_trend",
      dtype: "direction",
      definition: "trend of the zone metric",
      value: { direction: "rising", slope_per_period: 0.4 },
    },
  ],
} as FindingsManifest;

// A minimal FeatureCollection under Investigate's step-prefixed key. The
// $chartData:step_2_geojson binding on the injected map resolves against this.
const GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { zone: "A" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

const baseArtifacts = (planExtra: Record<string, unknown>): CachedArtifacts =>
  ({
    code: "",
    question: "map the zones",
    results: {},
    chart_data: { step_2_geojson: GEOJSON },
    datasets: {},
    execution_ms: 0,
    findings: MANIFEST,
    series: [],
    plan: {
      mode: "compiled",
      purpose: "dashboard",
      plan: { nodes: [{ id: "n_a", op: "ANSWER", refs: ["step_2.zone_trend"] }] },
      overlay: {},
      ...planExtra,
    },
  }) as unknown as CachedArtifacts;

describe("edit recompile preserves the run's geometry (finding 08/H3)", () => {
  it("re-injects compiled_geo_map on the persisted step-prefixed key after an edit", async () => {
    cacheArtifacts("csv-geo-persist", baseArtifacts({ geojsonKey: "step_2_geojson" }));
    const result = await editDashboard("csv-geo-persist", [
      { kind: "set_insight", text: "The northern zones lead." },
    ]);
    expect(result.ok, result.errors.join()).toBe(true);
    const spec = result.spec as Spec;
    // The map survived the recompile…
    const map = spec.elements["compiled_geo_map"] as { props?: { geojson?: unknown } } | undefined;
    expect(map, "compiled_geo_map dropped on edit recompile").toBeTruthy();
    // …and its polygons bound to the ACTUAL step-prefixed key — the binding
    // resolved to the FeatureCollection, not swept to null by the wrong key.
    expect(map!.props?.geojson).toMatchObject({ type: "FeatureCollection" });
  });

  it("without the persisted key, the recompile drops the map (guards the fix)", async () => {
    // Same artifacts, but the plan doc carries NO geojsonKey (the pre-fix
    // state) — proving the persisted key is what carries the map through.
    cacheArtifacts("csv-geo-absent", baseArtifacts({}));
    const result = await editDashboard("csv-geo-absent", [
      { kind: "set_insight", text: "The northern zones lead." },
    ]);
    expect(result.ok, result.errors.join()).toBe(true);
    expect((result.spec as Spec).elements["compiled_geo_map"]).toBeUndefined();
  });
});
