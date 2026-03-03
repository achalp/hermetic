"use client";

import { ResponsiveRadar } from "@nivo/radar";
import { useColorMap, useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface RadarChartProps {
  title: string | null;
  data: Record<string, unknown>[];
  index_key: string;
  keys: string[];
  color_map: Record<string, string> | null;
  max_value: number | null;
  fill_opacity: number | null;
  dot_size: number | null;
}

export function RadarChartComponent({ props }: { props: RadarChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];
  const colors = useColorMap(props.keys, props.color_map);

  if (data.length === 0) {
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
        <ResponsiveRadar
          data={data as Record<string, string | number>[]}
          keys={props.keys}
          indexBy={props.index_key}
          theme={theme}
          colors={colors}
          maxValue={props.max_value ?? "auto"}
          fillOpacity={props.fill_opacity ?? 0.25}
          dotSize={props.dot_size ?? 8}
          dotColor={{ theme: "background" }}
          dotBorderWidth={2}
          dotBorderColor={{ from: "color" }}
          blendMode="multiply"
          margin={{ top: 40, right: 80, bottom: 40, left: 80 }}
          legends={
            props.keys.length > 1
              ? [
                  {
                    anchor: "top-left",
                    direction: "column",
                    translateX: -50,
                    translateY: -40,
                    itemWidth: 80,
                    itemHeight: 20,
                    symbolSize: chart.legendSymbolSize,
                    symbolShape: "circle",
                  },
                ]
              : []
          }
        />
      </div>
    </div>
  );
}
