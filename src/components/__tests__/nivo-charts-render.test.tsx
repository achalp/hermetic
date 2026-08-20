// @vitest-environment jsdom
//
// Render sweep for nivo-based SVG charts that carry no catalog sample and were
// therefore never mounted by the smoke harness (all at 0% line coverage). Each
// renders directly with minimal valid props and must produce DOM without
// throwing. Nivo's Responsive wrappers measure via ResizeObserver and read
// prefers-reduced-motion via matchMedia — jsdom has neither, so both are
// shimmed. The theme hooks all fall back to defaults with no provider stack.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { RadarChartComponent } from "@/components/charts/radar-chart";
import { TreemapChartComponent } from "@/components/charts/treemap-chart";
import { SunburstChartComponent } from "@/components/charts/sunburst-chart";
import { ChordChartComponent } from "@/components/charts/chord-chart";
import { StreamChartComponent } from "@/components/charts/stream-chart";
import { BumpChartComponent } from "@/components/charts/bump-chart";
import { CalendarChartComponent } from "@/components/charts/calendar-chart";
import { MarimekkoChartComponent } from "@/components/charts/marimekko-chart";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

describe("nivo chart render sweep", () => {
  it("RadarChartComponent renders a titled container", () => {
    const { container } = render(
      <RadarChartComponent
        props={{
          title: "Skills",
          data: [
            { axis: "Speed", team_a: 80, team_b: 60 },
            { axis: "Power", team_a: 50, team_b: 90 },
            { axis: "Range", team_a: 70, team_b: 40 },
          ],
          index_key: "axis",
          keys: ["team_a", "team_b"],
          color_map: null,
          max_value: null,
          fill_opacity: null,
          dot_size: null,
        }}
      />
    );
    expect(container.querySelector("h3")?.textContent).toBe("Skills");
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("RadarChartComponent shows the empty state when data is empty", () => {
    const { container } = render(
      <RadarChartComponent
        props={{
          title: "Empty",
          data: [],
          index_key: "axis",
          keys: ["team_a"],
          color_map: null,
          max_value: null,
          fill_opacity: null,
          dot_size: null,
        }}
      />
    );
    // Empty state stands in for the chart; the h3 title is not rendered.
    expect(container.querySelector("h3")).toBeNull();
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("TreemapChartComponent renders hierarchical data", () => {
    const { container } = render(
      <TreemapChartComponent
        props={{
          title: "Storage",
          data: {
            name: "root",
            children: [
              { name: "a", value: 10 },
              { name: "b", value: 20 },
              { name: "c", value: 5 },
            ],
          } as unknown as Record<string, unknown>,
          colors: null,
          tile_mode: null,
          label_skip_size: null,
          border_width: null,
        }}
      />
    );
    expect(container.querySelector("h3")?.textContent).toBe("Storage");
  });

  it("SunburstChartComponent renders hierarchical data", () => {
    const { container } = render(
      <SunburstChartComponent
        props={{
          title: "Breakdown",
          data: {
            name: "root",
            children: [
              { name: "a", value: 30 },
              { name: "b", value: 70 },
            ],
          } as unknown as Record<string, unknown>,
          colors: null,
          corner_radius: null,
          border_width: null,
          child_color: null,
        }}
      />
    );
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("ChordChartComponent renders a flow matrix", () => {
    const { container } = render(
      <ChordChartComponent
        props={{
          title: "Flows",
          matrix: [
            [0, 5, 8],
            [5, 0, 3],
            [8, 3, 0],
          ],
          keys: ["X", "Y", "Z"],
          colors: null,
          pad_angle: null,
          inner_radius_ratio: null,
        }}
      />
    );
    expect(container.querySelector("h3")?.textContent).toBe("Flows");
  });

  it("StreamChartComponent renders stacked series", () => {
    const { container } = render(
      <StreamChartComponent
        props={{
          title: "Traffic",
          data: [
            { direct: 10, organic: 20 },
            { direct: 15, organic: 18 },
            { direct: 12, organic: 25 },
          ],
          keys: ["direct", "organic"],
          color_map: null,
          offset: null,
          curve: null,
        }}
      />
    );
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("BumpChartComponent renders ranking series", () => {
    const { container } = render(
      <BumpChartComponent
        props={{
          title: "Rankings",
          data: [
            {
              id: "A",
              data: [
                { x: "2021", y: 1 },
                { x: "2022", y: 2 },
              ],
            },
            {
              id: "B",
              data: [
                { x: "2021", y: 2 },
                { x: "2022", y: 1 },
              ],
            },
          ],
          color_map: null,
          line_width: null,
          point_size: null,
        }}
      />
    );
    expect(container.querySelector("h3")?.textContent).toBe("Rankings");
  });

  it("CalendarChartComponent renders daily values", () => {
    const { container } = render(
      <CalendarChartComponent
        props={{
          title: "Activity",
          data: [
            { day: "2023-01-01", value: 3 },
            { day: "2023-06-15", value: 8 },
            { day: "2023-12-31", value: 5 },
          ],
          from: "2023-01-01",
          to: "2023-12-31",
          color_scale: null,
          empty_color: null,
          direction: null,
        }}
      />
    );
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("MarimekkoChartComponent renders dimensioned bars", () => {
    const { container } = render(
      <MarimekkoChartComponent
        props={{
          title: "Segments",
          data: [
            { region: "North", desktop: 40, mobile: 60 },
            { region: "South", desktop: 55, mobile: 45 },
          ],
          id_key: "region",
          value_key: "desktop",
          dimensions: [
            { id: "Desktop", value: "desktop" },
            { id: "Mobile", value: "mobile" },
          ],
          color_map: null,
        }}
      />
    );
    expect(container.querySelector("h3")?.textContent).toBe("Segments");
  });
});
