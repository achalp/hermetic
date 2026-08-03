// @vitest-environment jsdom
//
// Modularization M0-0c: render smoke harness. Every catalog sample and every
// committed spec fixture must MOUNT through the real registry + Renderer —
// schema validation alone proved props parse, not that components render.
// WebGL/canvas leaf libraries (plotly dists, maplibre, deck.gl, globe.gl) are
// stubbed; everything above them (chart data prep, registry wiring, wrappers)
// runs for real. Charts load through the renderer's own clientLazy
// (React.lazy + Suspense; M5-5c) whose fallback carries data-testid
// lazy-loading — renderAndSettle awaits full resolution.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";

const stubComponent = (name: string) => {
  const Stub = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid={`stub-${name}`}>{children}</div>
  );
  return Stub;
};

// Plotly: three dists + the react factory. The factory returns a component so
// plotly-based charts still execute their trace/layout preparation code.
vi.mock("plotly.js-cartesian-dist", () => ({ default: {} }));
vi.mock("plotly.js-gl3d-dist", () => ({ default: {} }));
vi.mock("plotly.js-finance-dist", () => ({ default: {} }));
vi.mock("react-plotly.js/factory", () => ({
  default: () => stubComponent("plotly"),
}));

// Maps / globe: stub the WebGL components, keep chart-level code real.
vi.mock("react-map-gl/maplibre", () => {
  return new Proxy(
    { default: stubComponent("maplibre") },
    { get: (t, prop) => (prop in t ? t[prop as keyof typeof t] : stubComponent(String(prop))) }
  );
});
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("react-globe.gl", () => ({ default: stubComponent("globe") }));
vi.mock("@/lib/deckgl-init", () => ({}));
vi.mock("@deck.gl/react", () => ({ default: stubComponent("deckgl") }));
const deckClassStub = () => new Proxy({}, { get: () => class Stub {} }) as Record<string, unknown>;
vi.mock("@deck.gl/layers", () => deckClassStub());
vi.mock("@deck.gl/core", () => deckClassStub());
vi.mock("@deck.gl/aggregation-layers", () => deckClassStub());
vi.mock("@deck.gl/geo-layers", () => deckClassStub());

import {
  StateProvider,
  ActionProvider,
  VisibilityProvider,
  Renderer,
  type Spec,
} from "@/spec/react";
import { registry, registryActionHandlers } from "@/components/registry";
import { RendererErrorBoundary } from "@/components/app/renderer-error-boundary";
import { catalogComponents } from "@/lib/catalog";
import { ALL_CATALOG_SAMPLES } from "@/lib/__tests__/fixtures/catalog-samples";
import dataControllerSpec from "../../../test-specs/data-controller-test.json";
import formControllerSpec from "../../../test-specs/form-controller-test.json";
import newChartsSpec from "../../../test-specs/new-charts-smoke.json";

const components = catalogComponents as unknown as Record<
  string,
  { props: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } }
>;

// JSDOM environment shims for chart libraries (theme media queries, nivo
// responsive wrappers). Behavior-free stubs — charts render at fixed size.
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

let consoleErrors: string[] = [];
let realConsoleError: typeof console.error;

beforeEach(() => {
  consoleErrors = [];
  realConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    // React act()/key warnings from async lazy resolution are test-harness
    // noise, not component defects; everything else counts as a failure.
    if (/not wrapped in act|ReactDOMTestUtils/.test(msg)) return;
    consoleErrors.push(msg);
  };
});
afterEach(() => {
  console.error = realConsoleError;
  cleanup();
});

function SpecHarness({ spec }: { spec: Spec }) {
  return (
    <StateProvider initialState={spec.state ?? {}}>
      <ActionProvider handlers={registryActionHandlers}>
        <VisibilityProvider>
          <RendererErrorBoundary>
            <Renderer spec={spec} registry={registry} />
          </RendererErrorBoundary>
        </VisibilityProvider>
      </ActionProvider>
    </StateProvider>
  );
}

async function renderAndSettle(spec: Spec) {
  const view = render(<SpecHarness spec={spec} />);
  // Wait for every lazy chart to resolve (or fail — which surfaces below).
  await waitFor(() => expect(view.queryAllByTestId("lazy-loading")).toHaveLength(0), {
    timeout: 15000,
  });
  return view;
}

describe("catalog sample render smoke", () => {
  for (const [name, sample] of Object.entries(ALL_CATALOG_SAMPLES)) {
    it(`${name} sample passes its schema and mounts`, async () => {
      const def = components[name];
      expect(def, `${name} is not in the catalog`).toBeTruthy();
      const parsed = def.props.safeParse(sample);
      expect(parsed.success, `${name} sample rejected by schema`).toBe(true);

      const spec: Spec = {
        root: "root",
        elements: { root: { type: name, props: sample } },
      } as unknown as Spec;
      const view = await renderAndSettle(spec);
      expect(view.container.innerHTML.length).toBeGreaterThan(0);
      expect(consoleErrors, `console.error during ${name} render`).toEqual([]);
    });
  }
});

describe("spec fixture render smoke", () => {
  const fixtures: Array<[string, unknown]> = [
    ["data-controller-test.json", dataControllerSpec],
    ["form-controller-test.json", formControllerSpec],
    ["new-charts-smoke.json", newChartsSpec],
  ];
  for (const [name, spec] of fixtures) {
    it(`${name} mounts without errors`, async () => {
      const view = await renderAndSettle(spec as Spec);
      expect(view.container.innerHTML.length).toBeGreaterThan(0);
      expect(view.container.textContent).not.toContain("Something went wrong");
      expect(consoleErrors, `console.error rendering ${name}`).toEqual([]);
    });
  }
});
