"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyFinanceChart } from "./plotly-finance-wrapper";
import { useChartColors, resolveColor } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface GaugeRange {
  to: number;
  color?: string | null;
  /** Accepted from LLM specs; bands render by color, labels are not drawn. */
  label?: string | null;
}

interface GaugeChartProps {
  title?: string | null;
  value: number;
  min?: number | null;
  max?: number | null;
  /** A target/threshold marker drawn as a line across the dial. */
  target?: number | null;
  /** Coloured qualitative bands, each spanning up to `to` (ascending). */
  ranges?: GaugeRange[] | null;
  /** Reference value to show a delta against. */
  reference?: number | null;
  bar_color?: string | null;
  suffix?: string | null;
  prefix?: string | null;
  number_format?: string | null;
  height?: number | null;
}

export function GaugeChartComponent({ props }: { props: GaugeChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();

  const value = Number(props.value) || 0;
  const min = props.min ?? 0;
  const max = props.max ?? Math.max(value, min + 1);
  const ranges = (Array.isArray(props.ranges) ? props.ranges : []).filter(
    (r) => r != null && Number.isFinite(Number(r.to))
  );

  let prev = min;
  const steps = ranges.map((r, i) => {
    const step = {
      range: [prev, Number(r.to)] as [number, number],
      // Bands without a color (label-only specs) fall back to the palette,
      // offset so band 0 doesn't blend into the value bar (palette[0]).
      color: resolveColor(r.color, palette[(i + 1) % palette.length]),
    };
    prev = Number(r.to);
    return step;
  });

  const trace: Data = {
    type: "indicator" as const,
    mode: props.reference != null ? "gauge+number+delta" : "gauge+number",
    value,
    number: {
      suffix: props.suffix ?? undefined,
      prefix: props.prefix ?? undefined,
      valueformat: props.number_format ?? undefined,
    },
    delta: props.reference != null ? { reference: props.reference } : undefined,
    gauge: {
      axis: { range: [min, max] },
      bar: { color: props.bar_color ? resolveColor(props.bar_color) : palette[0] },
      steps: steps.length ? steps : undefined,
      threshold:
        props.target != null
          ? { line: { color: "#dc2626", width: 3 }, thickness: 0.8, value: props.target }
          : undefined,
    },
  } as Data;

  const layout: Partial<Layout> = {
    margin: { l: 24, r: 24, t: 24, b: 8 },
  };

  const chartHeight = props.height ?? Math.round(chart.height * 0.7);

  return (
    <div className={`w-full${isExpanded ? " h-full flex flex-col" : ""}`}>
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
        </h3>
      )}
      <div className={isExpanded ? "flex-1" : ""}>
        <PlotlyFinanceChart
          data={[trace]}
          layout={layout}
          height={isExpanded ? undefined : chartHeight}
        />
      </div>
    </div>
  );
}
