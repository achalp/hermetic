import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * The blank-basemap regression (issue #253 follow-up): maplibre-gl v6 spawns
 * its worker from `new URL("./maplibre-gl-worker.mjs", import.meta.url)`,
 * which resolves next to a bundled Next chunk where no such file exists. The
 * 404 is swallowed, so every map stalled with style metadata loaded, ZERO tile
 * requests, and no error — pins (DOM markers) rendered, the basemap stayed
 * blank. Same dev-state-masking family as the pyodide wheels.
 *
 * Two halves, both pinned here: the vendoring script must produce the worker
 * pair, and the side-effect module every map component imports must point
 * MapLibre at it.
 */

vi.mock("maplibre-gl", () => ({ setWorkerUrl: vi.fn() }));

describe("maplibre worker vendoring", () => {
  it("ensure-maplibre-worker.mjs vendors the worker AND its shared-chunk sibling", () => {
    execFileSync(process.execPath, [join(process.cwd(), "scripts", "ensure-maplibre-worker.mjs")]);
    const out = join(process.cwd(), "public", "vendor", "maplibre");
    // The worker imports ./maplibre-gl-shared.mjs relative to its own URL —
    // shipping one without the other fails only at runtime, silently.
    for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
      expect(statSync(join(out, f)).size, `${f} must be non-trivial`).toBeGreaterThan(10_000);
    }
  });

  it("the side-effect module points MapLibre at the vendored worker", async () => {
    const { setWorkerUrl } = await import("maplibre-gl");
    await import("@/components/charts/maplibre-worker-url");
    expect(vi.mocked(setWorkerUrl)).toHaveBeenCalledWith("/vendor/maplibre/maplibre-gl-worker.mjs");
  });
});
