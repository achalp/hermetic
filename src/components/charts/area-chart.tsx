"use client";

import { ResponsiveLine } from "@nivo/line";
import {
  useColorMap,
  toNivoLineSeries,
  useNivoTheme,
  pickTickValues,
  formatAxisNumber,
  unwrapChartData,
  truncateLabel,
  legendItemWidth,
} from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { useDrillClickRef } from "@/components/drill-down-context";
import { lineClickRecord } from "@/lib/drill-resolve";
import { ChartEmptyState } from "./chart-empty-state";
import { ChartShell } from "./chart-shell";

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
  const drillClickValueRef = useDrillClickRef();
  const clickHandle = on?.("click");
  const isDrillable = clickHandle?.bound ?? false;
  const theme = useNivoTheme();
  const tc = useThemeConfig();
  const { chart } = tc;
  const isExpanded = useChartExpanded();

  // Coerce array-typed props: a misbound placeholder can deliver a non-array.
  const y_keys = Array.isArray(props.y_keys) ? props.y_keys : [];

  const raw = unwrapChartData(props.data);
  const data = raw.filter((row) => row[props.x_key] != null);
  const colors = useColorMap(y_keys, props.color_map);
  const series = toNivoLineSeries(data, props.x_key, y_keys);
  const tickValues = pickTickValues(data, props.x_key);
  const hasRotatedLabels = !!tickValues;
  const hasLegend = y_keys.length > 1;

  if (data.length === 0) {
    return <ChartEmptyState height={chart.height} />;
  }

  return (
    <ChartShell
      title={props.title}
      height={chart.height}
      isExpanded={isExpanded}
      isDrillable={isDrillable}
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
        onClick={
          isDrillable
            ? (datum) => {
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
                  itemWidth: legendItemWidth(hasLegend ? y_keys : [], 180),
                  itemHeight: 20,
                  symbolSize: chart.legendSymbolSize,
                },
              ]
            : []
        }
      />
    </ChartShell>
  );
}
