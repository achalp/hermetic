"use client";

import { ResponsiveScatterPlot, ScatterPlotCustomSvgLayer } from "@nivo/scatterplot";
import { useChartColors, useTrendColors, useNivoTheme, formatAxisNumber } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface ScatterChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  x_key?: string | null;
  y_key?: string | null;
  x_label?: string | null;
  y_label?: string | null;
  show_regression?: boolean | null;
  group_key?: string | null;
  /** @deprecated use group_key instead */
  color_by?: string | null;
}

interface EventHandle {
  emit: () => void;
  bound: boolean;
  shouldPreventDefault: boolean;
}

interface Point {
  x: number;
  y: number;
}

function linearRegression(data: Point[]) {
  const n = data.length;
  if (n < 2) return null;
  const sumX = data.reduce((s, p) => s + p.x, 0);
  const sumY = data.reduce((s, p) => s + p.y, 0);
  const sumXY = data.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = data.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export function ScatterChartComponent({
  props,
  emit,
  on,
}: {
  props: ScatterChartProps;
  emit?: (event: string) => void;
  on?: (event: string) => EventHandle;
}) {
  const clickHandle = on?.("click");
  const isDrillable = clickHandle?.bound ?? false;
  const theme = useNivoTheme();
  const tc = useThemeConfig();
  const { chart } = tc;
  const chartColors = useChartColors();
  const trendColors = useTrendColors();

  const rawData = Array.isArray(props.data) ? props.data : [];
  if (rawData.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  const xKey = props.x_key ?? "x";
  const yKey = props.y_key ?? "y";
  const groupKey = props.group_key ?? props.color_by ?? null;

  // Extract and validate points
  const points = rawData
    .map((d) => ({
      x: Number(d[xKey]),
      y: Number(d[yKey]),
      group: groupKey ? String(d[groupKey] ?? "default") : "default",
    }))
    .filter((p) => !isNaN(p.x) && !isNaN(p.y));

  if (points.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  // Group data into nivo series format
  const groupNames = groupKey ? Array.from(new Set(points.map((p) => p.group))) : ["default"];

  const nivoData = groupNames.map((group, i) => ({
    id: group,
    data: (groupKey ? points.filter((p) => p.group === group) : points).map((p) => ({
      x: p.x,
      y: p.y,
    })),
    color: chartColors[i % chartColors.length],
  }));

  const colors = nivoData.map((s) => s.color);

  // Regression line as a custom SVG layer
  const regression = props.show_regression ? linearRegression(points) : null;

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));

  const regressionLayer: ScatterPlotCustomSvgLayer<{ x: number; y: number }> = ({
    xScale,
    yScale,
  }) => {
    if (!regression) return null;
    const x1 = (xScale as (v: number) => number)(minX);
    const x2 = (xScale as (v: number) => number)(maxX);
    const y1 = (yScale as (v: number) => number)(regression.slope * minX + regression.intercept);
    const y2 = (yScale as (v: number) => number)(regression.slope * maxX + regression.intercept);
    return (
      <line
        x1={x1}
        x2={x2}
        y1={y1}
        y2={y2}
        stroke={trendColors.down}
        strokeDasharray="5 5"
        strokeWidth={2}
      />
    );
  };

  return (
    <div
      className={`w-full${isDrillable ? " cursor-pointer" : ""}`}
      onClick={isDrillable ? () => emit?.("click") : undefined}
    >
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
          {isDrillable && (
            <span className="ml-2 text-xs font-normal text-accent">Click to drill down</span>
          )}
        </h3>
      )}
      <div style={{ height: chart.height }}>
        <ResponsiveScatterPlot
          data={nivoData}
          colors={colors}
          margin={{
            top: chart.margin.top,
            right: chart.margin.right,
            bottom: chart.margin.bottom + 10,
            left: chart.margin.left + 10,
          }}
          xScale={{ type: "linear", min: "auto", max: "auto" }}
          yScale={{ type: "linear", min: "auto", max: "auto" }}
          theme={theme}
          axisBottom={{
            tickSize: chart.axisTickSize,
            tickPadding: 5,
            tickValues: 5,
            format: formatAxisNumber,
            legend: props.x_label ?? undefined,
            legendPosition: "middle",
            legendOffset: 46,
          }}
          axisLeft={{
            tickSize: chart.axisTickSize,
            tickPadding: 5,
            tickValues: 5,
            format: formatAxisNumber,
            legend: props.y_label ?? undefined,
            legendPosition: "middle",
            legendOffset: -56,
          }}
          nodeSize={chart.pointSize + 2}
          layers={[
            "grid",
            "axes",
            "nodes",
            "markers",
            "mesh",
            "legends",
            ...(regression ? [regressionLayer] : []),
          ]}
          legends={
            groupNames.length > 1
              ? [
                  {
                    anchor: "bottom-right" as const,
                    direction: "column" as const,
                    translateX: 0,
                    translateY: 0,
                    itemWidth: 100,
                    itemHeight: 20,
                    symbolSize: chart.legendSymbolSize,
                  },
                ]
              : []
          }
        />
      </div>
    </div>
  );
}
