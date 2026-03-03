"use client";

import { ResponsiveStream } from "@nivo/stream";
import { useColorMap, useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface StreamChartProps {
  title: string | null;
  data: Record<string, unknown>[];
  keys: string[];
  color_map: Record<string, string> | null;
  offset: "silhouette" | "wiggle" | "expand" | "none" | null;
  curve: "basis" | "cardinal" | "linear" | "monotoneX" | null;
}

export function StreamChartComponent({ props }: { props: StreamChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];
  const colors = useColorMap(props.keys, props.color_map);

  if (data.length === 0 || !props.keys || props.keys.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  return (
    <div className="w-full">
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
        </h3>
      )}
      <div style={{ height: chart.height }}>
        <ResponsiveStream
          data={data as Record<string, number>[]}
          keys={props.keys}
          theme={theme}
          colors={colors}
          margin={{ top: 20, right: 110, bottom: 40, left: 60 }}
          offsetType={props.offset ?? "silhouette"}
          curve={props.curve ?? "basis"}
          borderColor={{ theme: "background" }}
          enableGridX
          enableGridY={false}
          axisBottom={{
            tickSize: 5,
            tickPadding: 5,
            tickRotation: 0,
          }}
          axisLeft={{
            tickSize: 5,
            tickPadding: 5,
            tickRotation: 0,
          }}
          legends={[
            {
              anchor: "bottom-right",
              direction: "column",
              translateX: 100,
              itemWidth: 80,
              itemHeight: 20,
              symbolSize: chart.legendSymbolSize,
              symbolShape: "circle",
            },
          ]}
        />
      </div>
    </div>
  );
}
