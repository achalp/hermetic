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

  const data = Array.isArray(props.data) ? props.data : [];
  const colors = useColorMap(props.y_keys, props.color_map);
  const series = toNivoLineSeries(data, props.x_key, props.y_keys);
  const tickValues = pickTickValues(data, props.x_key);

  if (data.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

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
        <ResponsiveLine
          data={series}
          colors={colors}
          curve="monotoneX"
          lineWidth={chart.lineWidth}
          margin={chart.margin}
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
            tickRotation: tickValues ? -45 : 0,
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
            props.y_keys.length > 1
              ? [
                  {
                    anchor: "bottom",
                    direction: "row",
                    translateY: 46,
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
