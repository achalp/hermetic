"use client";

import { ResponsiveLine } from "@nivo/line";
import {
  useColorMap,
  toNivoLineSeries,
  useNivoTheme,
  pickTickValues,
  formatAxisNumber,
} from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface AreaChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  x_key: string;
  y_keys: string[];
  color_map?: Record<string, string> | null;
  stacked?: boolean | null;
  opacity?: number | null;
}

interface EventHandle {
  emit: () => void;
  bound: boolean;
  shouldPreventDefault: boolean;
}

export function AreaChartComponent({
  props,
  emit,
  on,
}: {
  props: AreaChartProps;
  emit?: (event: string) => void;
  on?: (event: string) => EventHandle;
}) {
  const clickHandle = on?.("click");
  const isDrillable = clickHandle?.bound ?? false;
  const theme = useNivoTheme();
  const tc = useThemeConfig();
  const { chart } = tc;
  const isExpanded = useChartExpanded();

  const raw = Array.isArray(props.data) ? props.data : [];
  const data = raw.filter((row) => row[props.x_key] != null);
  const colors = useColorMap(props.y_keys, props.color_map);
  const series = toNivoLineSeries(data, props.x_key, props.y_keys);
  const tickValues = pickTickValues(data, props.x_key);
  const hasRotatedLabels = !!tickValues;
  const hasLegend = props.y_keys.length > 1;
  const maxKeyLen = hasLegend ? Math.max(...props.y_keys.map((k) => k.length)) : 0;
  const legendItemWidth = Math.max(100, Math.min(180, maxKeyLen * 8 + 24));

  const truncateLabel = (v: string | number): string => {
    const s = String(v);
    return s.length > 16 ? s.slice(0, 15) + "\u2026" : s;
  };

  if (data.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  return (
    <div
      className={`w-full${isDrillable ? " cursor-pointer" : ""}${isExpanded ? " h-full flex flex-col" : ""}`}
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
      <div
        className={isExpanded ? "flex-1" : ""}
        style={{ height: isExpanded ? undefined : chart.height }}
      >
        <ResponsiveLine
          data={series}
          colors={colors}
          curve="monotoneX"
          lineWidth={chart.lineWidth}
          margin={{
            ...chart.margin,
            bottom: hasRotatedLabels
              ? chart.margin.bottom + (hasLegend ? 70 : 40)
              : chart.margin.bottom + (hasLegend ? 30 : 0),
          }}
          xScale={{ type: "point" }}
          yScale={{
            type: "linear",
            min: "auto",
            max: "auto",
            stacked: props.stacked ?? false,
          }}
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
          enableArea
          areaOpacity={props.opacity ?? 0.3}
          enablePoints={false}
          pointSize={chart.pointSize}
          useMesh
          enableSlices="x"
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
