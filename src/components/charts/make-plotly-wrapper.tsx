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
 * Re-center hover label text inside its bubble one frame after the hover.
 *
 * Chrome 151 stopped invalidating layout synchronously when an SVG transform
 * attribute changes: a forced getBoundingClientRect in the same tick returns
 * the PRE-change geometry. Plotly's createHoverText resets a reused label's
 * transform and immediately measures the text to derive its y position, so
 * the measurement is stale by exactly the label's previous offset and the
 * text lands that far outside the bubble (an "empty" hover label). A fresh
 * label (first hover after entering a chart) measures clean, which is why
 * only the second and later events on a reused label go blank. By the next
 * animation frame layout is accurate, so measure the real path/text boxes
 * and shift the text back to the bubble's vertical center.
 */
function realignHoverText(container: HTMLElement) {
  for (const ht of container.querySelectorAll("g.hoverlayer g.hovertext")) {
    const path = ht.querySelector("path");
    const nums = ht.querySelector("text.nums");
    if (!path || !nums) continue;
    const pb = path.getBoundingClientRect();
    const tb = nums.getBoundingClientRect();
    if (!pb.height || !tb.height) continue;
    const scaleY = (nums as SVGGraphicsElement).getScreenCTM()?.d ?? 1;
    const dy = (pb.top + pb.height / 2 - (tb.top + tb.height / 2)) / scaleY;
    if (Math.abs(dy) <= 1) continue;
    // ty0 (the stale-measure term) feeds every text in the label, so shift
    // the secondary name text by the same amount as the nums text.
    for (const text of ht.querySelectorAll("text")) {
      const y = parseFloat(text.getAttribute("y") ?? "0");
      text.setAttribute("y", String(y + dy));
    }
  }
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

    // Fix hover label text stranded by Chrome's stale SVG measurement (see
    // realignHoverText). Plotly repositions labels during mouse movement, so
    // schedule one correction per frame while the pointer is over the chart.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      let raf = 0;
      const onMove = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          realignHoverText(el);
        });
      };
      el.addEventListener("mousemove", onMove, { passive: true });
      el.addEventListener("mouseover", onMove, { passive: true });
      return () => {
        el.removeEventListener("mousemove", onMove);
        el.removeEventListener("mouseover", onMove);
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
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    );
  };
}
