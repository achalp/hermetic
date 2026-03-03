"use client";

import { ResponsiveMarimekko } from "@nivo/marimekko";
import { useColorMap, useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface MarimekkoChartProps {
  title: string | null;
  data: Record<string, unknown>[];
  id_key: string;
  value_key: string;
  dimensions: { id: string; value: string }[];
  color_map: Record<string, string> | null;
}

export function MarimekkoChartComponent({ props }: { props: MarimekkoChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];
  const dimIds = (props.dimensions ?? []).map((d) => d.id);
  const colors = useColorMap(dimIds, props.color_map);

  if (data.length === 0 || !props.dimensions || props.dimensions.length === 0) {
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
        <ResponsiveMarimekko
          data={data as Record<string, string | number>[]}
          id={props.id_key}
          value={props.value_key}
          dimensions={props.dimensions}
          theme={theme}
          colors={colors}
          innerPadding={9}
          axisTop={null}
          axisRight={null}
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
          margin={{ top: 20, right: 80, bottom: 40, left: 80 }}
          legends={[
            {
              anchor: "bottom-right",
              direction: "column",
              translateX: 80,
              itemWidth: 70,
              itemHeight: 20,
              symbolSize: chart.legendSymbolSize,
            },
          ]}
        />
      </div>
    </div>
  );
}
