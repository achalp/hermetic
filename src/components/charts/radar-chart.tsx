"use client";

import { ResponsiveRadar } from "@nivo/radar";
import {
  useColorMap,
  useNivoTheme,
  unwrapChartData,
  useReducedMotion,
} from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

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
  const reducedMotion = useReducedMotion();
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const data = unwrapChartData(props.data);
  const colors = useColorMap(props.keys, props.color_map);

  if (data.length === 0) {
    return <ChartEmptyState height={chart.height} />;
  }

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
      <div
        className={isExpanded ? "flex-1" : ""}
        style={{ height: isExpanded ? undefined : chart.height }}
      >
        <ResponsiveRadar
          animate={!reducedMotion}
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
