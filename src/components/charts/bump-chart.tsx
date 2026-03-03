"use client";

import { ResponsiveBump } from "@nivo/bump";
import { useColorMap, useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface BumpChartProps {
  title: string | null;
  data: { id: string; data: { x: string | number; y: number }[] }[];
  color_map: Record<string, string> | null;
  line_width: number | null;
  point_size: number | null;
}

export function BumpChartComponent({ props }: { props: BumpChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];
  const ids = data.map((d) => d.id);
  const colors = useColorMap(ids, props.color_map);

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
        <ResponsiveBump
          data={data}
          theme={theme}
          colors={colors}
          lineWidth={props.line_width ?? 3}
          activeLineWidth={6}
          inactiveLineWidth={3}
          inactiveOpacity={0.15}
          pointSize={props.point_size ?? 10}
          activePointSize={16}
          inactivePointSize={0}
          pointBorderWidth={3}
          pointBorderColor={{ from: "serie.color" }}
          margin={{ top: 40, right: 100, bottom: 40, left: 60 }}
          axisTop={{
            tickSize: 5,
            tickPadding: 5,
            tickRotation: 0,
          }}
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
        />
      </div>
    </div>
  );
}
