"use client";

import { clientLazy } from "@/components/lazy-client";
import type { Data, Layout, Config } from "plotly.js";
import { useRef, useEffect, type CSSProperties, type ComponentType, type ReactNode } from "react";

/** Shared modebar/interaction config for every Plotly wrapper. */
const PLOTLY_CONFIG: Partial<Config> = {
  displayModeBar: "hover",
  modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"],
  displaylogo: false,
  responsive: true,
};

/**
 * The minimal surface of a Plotly bundle the wrappers rely on: enough to
 * build a react-plotly.js component from and to force a resize. Every
 * prebuilt dist (cartesian/finance/gl3d) and the custom polar bundle
 * satisfies this shape.
 */
export interface PlotlyDist {
  Plots: { resize(el: HTMLElement): unknown };
}

export interface PlotlyWrapperProps {
  data: Data[];
  layout?: Partial<Layout>;
  height?: number;
}

/**
 * Take finished hover labels out of Plotly's reuse pool.
 *
 * Chrome 151 defers SVG transform-attribute invalidation past forced reflows:
 * a getBoundingClientRect in the same tick returns the PRE-change geometry.
 * Plotly's createHoverText resets a REUSED label's transform and immediately
 * measures its text to derive the text position, so the measurement is stale
 * by exactly the label's previous offset and the text lands that far outside
 * the bubble — an empty-looking hover label from the second event onward. A
 * FRESH label has no prior layout and measures correctly (the first hover
 * always renders right), so before every mouse event that could trigger a
 * hover pass we rename the finished label's class: Plotly's pass no longer
 * selects it, builds a fresh label, and we drop the retired one. The retired
 * label keeps rendering between throttled hover passes, so there is no
 * flicker. This runs in the capture phase so it precedes Plotly's own
 * bubble-phase handlers on the drag rect.
 */
const RETIRED = "hovertext-retired";
const LIVE_LABELS = "g.hoverlayer g.hovertext, g.hoverlayer g.axistext";

function retireHoverLabels(container: HTMLElement | null) {
  if (!container) return;
  const live = container.querySelectorAll<SVGGElement>(LIVE_LABELS);
  if (live.length === 0) return;
  for (const stale of container.querySelectorAll(`g.hoverlayer .${RETIRED}`)) stale.remove();
  for (const label of live) {
    // A label that was never revealed (see the reveal loop below) has never
    // painted at its real position — its deferred transform may still be
    // pending, so renaming it visible could flash it at the origin. It was
    // never seen, so dropping it loses nothing.
    if (label.style.visibility === "visible") {
      label.setAttribute("class", RETIRED);
    } else {
      label.remove();
    }
  }
}

function clearRetiredHoverLabels(container: HTMLElement | null) {
  if (!container) return;
  for (const stale of container.querySelectorAll(`g.hoverlayer .${RETIRED}`)) stale.remove();
}

/**
 * Builds a themed, lazily-loaded Plotly chart component around a specific
 * Plotly bundle. `loadDist` stays a closure over the caller's dynamic
 * `import()` expressions so each wrapper file keeps its own lazy chunk —
 * the bundle only loads when that chart type actually renders.
 */
export function makePlotlyWrapper(
  loadDist: () => Promise<PlotlyDist>,
  {
    fallback,
    useBaseLayout,
    mergeLayout,
    containerStyle,
  }: {
    fallback: ReactNode;
    /** Theme hook providing the base layout (called unconditionally). */
    useBaseLayout: () => Record<string, unknown>;
    /** Combines the themed base layout with the caller's layout overrides. */
    mergeLayout: (base: Record<string, unknown>, layout?: Partial<Layout>) => Partial<Layout>;
    /** Extra styles merged onto the sizing container. */
    containerStyle?: CSSProperties;
  }
): ComponentType<PlotlyWrapperProps> {
  const PlotlyPlot = clientLazy(async () => {
    const Plotly = await loadDist();
    const createPlotlyComponent = (await import("react-plotly.js/factory")).default;
    return createPlotlyComponent(Plotly);
  }, fallback);

  return function PlotlyWrapper({ data, layout, height }: PlotlyWrapperProps) {
    const baseLayout = useBaseLayout();
    const containerRef = useRef<HTMLDivElement>(null);

    // Observe the container for size changes. When inside a CSS grid cell,
    // Plotly can render at 0-width before the grid assigns track sizes,
    // leaving charts (especially heatmaps) blank. ResizeObserver catches
    // the grid settling and forces Plotly to recalculate.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      let disposed = false;
      const ro = new ResizeObserver(() => {
        if (disposed) return;
        const plotDiv = el.querySelector(".js-plotly-plot") as HTMLElement | null;
        if (!plotDiv) return;
        loadDist().then((Plotly) => {
          if (disposed || !plotDiv.isConnected) return;
          try {
            Plotly.Plots.resize(plotDiv);
          } catch {
            /* element detached */
          }
        });
      });
      ro.observe(el);
      return () => {
        disposed = true;
        ro.disconnect();
      };
    }, []);

    // Retire labels ahead of every event Plotly's hover pipeline listens to
    // (see retireHoverLabels). Capture phase runs before Plotly's handlers.
    // Fresh labels are born hidden (globals.css) because their deferred
    // attributes paint late — text content renders immediately but the
    // transform and path do not, so an unhidden fresh label flashes bare
    // text at the chart origin. The painted state is readable through
    // getCTM(), so the reveal loop shows each label only once its painted
    // transform matches its transform attribute — however many frames the
    // deferral takes — and keeps running briefly past the last event to
    // catch labels created by Plotly's trailing throttled hover pass.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      let raf = 0;
      let lastEvent = 0;
      const reveal = () => {
        raf = 0;
        let pending = false;
        for (const label of el.querySelectorAll<SVGGElement>(LIVE_LABELS)) {
          if (label.style.visibility === "visible") continue;
          const m = /translate\((-?[\d.]+),\s*(-?[\d.]+)\)/.exec(
            label.getAttribute("transform") ?? ""
          );
          const ctm = label.getCTM();
          if (
            m &&
            ctm &&
            Math.abs(ctm.e - Number(m[1])) < 2 &&
            Math.abs(ctm.f - Number(m[2])) < 2
          ) {
            label.style.visibility = "visible";
          } else {
            pending = true;
          }
        }
        if (pending || performance.now() - lastEvent < 300) raf = requestAnimationFrame(reveal);
      };
      const onEvent = () => {
        retireHoverLabels(el);
        lastEvent = performance.now();
        if (!raf) raf = requestAnimationFrame(reveal);
      };
      const events = ["mousemove", "mouseover", "mouseout", "touchmove", "touchstart"] as const;
      for (const ev of events) el.addEventListener(ev, onEvent, { capture: true, passive: true });
      return () => {
        for (const ev of events) el.removeEventListener(ev, onEvent, { capture: true });
        if (raf) cancelAnimationFrame(raf);
      };
    }, []);

    const mergedLayout = mergeLayout(baseLayout, layout);

    return (
      <div ref={containerRef} style={{ height: height ?? "100%", ...containerStyle }}>
        <PlotlyPlot
          data={data}
          layout={mergedLayout}
          config={PLOTLY_CONFIG}
          useResizeHandler
          onUnhover={() => clearRetiredHoverLabels(containerRef.current)}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    );
  };
}
