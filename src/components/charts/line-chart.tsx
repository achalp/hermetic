"use client";

import { ResponsiveLine } from "@nivo/line";
import {
  useColorMap,
  toNivoLineSeries,
  useNivoTheme,
  pickTickValues,
  formatAxisNumber,
  unwrapChartData,
} from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { drillClickValueRef } from "@/lib/drill-down-context";
import { lineClickRecord } from "@/lib/drill-resolve";
import { ChartEmptyState } from "./chart-empty-state";

type CurveType = "linear" | "monotone" | "step";

const CURVE_MAP: Record<CurveType, "linear" | "monotoneX" | "stepAfter"> = {
  linear: "linear",
  monotone: "monotoneX",
  step: "stepAfter",
};

interface LineChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  x_key: string;
  y_keys: string[];
  color_map?: Record<string, string> | null;
  show_dots?: boolean | null;
  curve?: CurveType | null;
}

interface EventHandle {
  emit: () => void;
  bound: boolean;
  shouldPreventDefault: boolean;
}

export function LineChartComponent({
  props,
  emit,
  on,
}: {
  props: LineChartProps;
  emit?: (event: string) => void;
  on?: (event: string) => EventHandle;
}) {
  const clickHandle = on?.("click");
  const isDrillable = clickHandle?.bound ?? false;
  const theme = useNivoTheme();
  const tc = useThemeConfig();
  const { chart } = tc;
  const isExpanded = useChartExpanded();

  // LLM-emitted specs occasionally omit y_keys entirely; treat as empty so
  // downstream `.map` / `.length` calls don't crash. The early-return below
  // catches the empty case before rendering.
  const y_keys = Array.isArray(props.y_keys) ? props.y_keys : [];

  const raw = unwrapChartData(props.data);
  const data = raw.filter((row) => row[props.x_key] != null);
  const colors = useColorMap(y_keys, props.color_map);
  const series = toNivoLineSeries(data, props.x_key, y_keys);
  const curve = CURVE_MAP[props.curve ?? "monotone"];
  const tickValues = pickTickValues(data, props.x_key);
  const hasRotatedLabels = !!tickValues;
  const hasLegend = y_keys.length > 1;

  // Compute legend item width from longest key name
  const maxKeyLen = hasLegend ? Math.max(...y_keys.map((k) => k.length)) : 0;
  const legendItemWidth = Math.max(100, Math.min(180, maxKeyLen * 8 + 24));

  // Truncate long x-axis labels
  const truncateLabel = (v: string | number): string => {
    const s = String(v);
    return s.length > 16 ? s.slice(0, 15) + "\u2026" : s;
  };

  if (data.length === 0 || y_keys.length === 0) {
    return <ChartEmptyState height={chart.height} />;
  }

  return (
    <div
      className={`w-full${isDrillable ? " cursor-pointer" : ""}${isExpanded ? " h-full flex flex-col" : ""}`}
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
      <div
        className={isExpanded ? "flex-1" : ""}
        style={{ height: isExpanded ? undefined : chart.height }}
      >
        <ResponsiveLine
          data={series}
          colors={colors}
          curve={curve}
          lineWidth={chart.lineWidth}
          margin={{
            ...chart.margin,
            bottom: hasRotatedLabels
              ? chart.margin.bottom + (hasLegend ? 70 : 40)
              : chart.margin.bottom + (hasLegend ? 30 : 0),
          }}
          xScale={{ type: "point" }}
          yScale={{ type: "linear", min: "auto", max: "auto" }}
          theme={theme}
          enableGridX={chart.enableGridX}
          enableGridY={chart.enableGridY}
          axisBottom={{
            tickSize: chart.axisTickSize,
            tickPadding: 5,
            tickRotation: hasRotatedLabels ? -45 : 0,
            format: hasRotatedLabels ? truncateLabel : undefined,
            ...(tickValues ? { tickValues } : {}),
          }}
          axisLeft={{
            tickSize: chart.axisTickSize,
            tickPadding: 5,
            tickRotation: 0,
            tickValues: 5,
            format: formatAxisNumber,
          }}
          enablePoints={props.show_dots ?? false}
          pointSize={chart.pointSize}
          pointBorderWidth={2}
          pointBorderColor={{ from: "serieColor" }}
          useMesh
          enableSlices="x"
          onClick={
            isDrillable
              ? (datum) => {
                  // Drill by the clicked x value (Nivo passes a point or, with
                  // enableSlices, an x-slice).
                  const rec = lineClickRecord(datum, props.x_key);
                  if (!rec) return;
                  drillClickValueRef.current = rec;
                  emit?.("click");
                }
              : undefined
          }
          legends={
            hasLegend
              ? [
                  {
                    anchor: "bottom" as const,
                    direction: "row" as const,
                    translateY: hasRotatedLabels ? 90 : 56,
                    itemWidth: legendItemWidth,
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
