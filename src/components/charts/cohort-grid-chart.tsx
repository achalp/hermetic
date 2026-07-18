"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface CohortGridProps {
  title?: string | null;
  /** Retention matrix: one row per cohort, one column per period. */
  z: number[][];
  row_labels: string[];
  col_labels: string[];
  /** Appended to cell labels (e.g. "%"). */
  value_suffix?: string | null;
  /** Decimal places shown in each cell. */
  precision?: number | null;
  colorscale?: string | null;
  x_label?: string | null;
  y_label?: string | null;
  height?: number | null;
}

export function CohortGridComponent({ props }: { props: CohortGridProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const z = Array.isArray(props.z) ? props.z : [];

  if (z.length === 0 || !Array.isArray(z[0])) return <ChartEmptyState height={chart.height} />;

  const rowLabels = Array.isArray(props.row_labels)
    ? props.row_labels
    : z.map((_, i) => `Cohort ${i + 1}`);
  const colLabels = Array.isArray(props.col_labels)
    ? props.col_labels
    : z[0].map((_, i) => `P${i}`);
  const suffix = props.value_suffix ?? "";
  const precision = props.precision ?? 0;

  const text = z.map((row) =>
    row.map((v) =>
      v == null || Number.isNaN(Number(v)) ? "" : `${Number(v).toFixed(precision)}${suffix}`
    )
  );

  // Reverse rows so the first cohort sits at the top of the grid.
  const trace: Data = {
    type: "heatmap" as const,
    z: [...z].reverse(),
    x: colLabels,
    y: [...rowLabels].reverse(),
    text: [...text].reverse() as unknown as string[],
    texttemplate: "%{text}",
    textfont: { size: 11 },
    colorscale: (props.colorscale ?? "Blues") as string,
    hoverongaps: false,
    xgap: 2,
    ygap: 2,
    colorbar: { thickness: 12 },
  } as Data;

  const layout: Partial<Layout> = {
    xaxis: { title: props.x_label ? { text: props.x_label } : undefined, side: "top" },
    yaxis: { title: props.y_label ? { text: props.y_label } : undefined, automargin: true },
    margin: { l: 120, r: 24, t: 40, b: 24 },
  };

  const chartHeight = props.height ?? Math.max(chart.height, 40 + rowLabels.length * 30);

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
        <PlotlyChart data={[trace]} layout={layout} height={isExpanded ? undefined : chartHeight} />
      </div>
    </div>
  );
}
