"use client";

import { ResponsiveSunburst } from "@nivo/sunburst";
import { useNivoTheme, useChartColors, resolveColors } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface SunburstChartProps {
  title: string | null;
  data: Record<string, unknown>;
  colors: string[] | null;
  corner_radius: number | null;
  border_width: number | null;
  child_color: "inherit" | "noinherit" | null;
}

export function SunburstChartComponent({ props }: { props: SunburstChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const themeColors = useChartColors();
  const colors = props.colors ? resolveColors(props.colors) : themeColors;

  if (!props.data) {
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
        <ResponsiveSunburst
          data={props.data as { name: string; children?: unknown[] }}
          id="name"
          value="value"
          theme={theme}
          colors={colors}
          cornerRadius={props.corner_radius ?? 2}
          borderWidth={props.border_width ?? 1}
          borderColor={{ theme: "background" }}
          childColor={
            props.child_color === "noinherit"
              ? { from: "color" }
              : { from: "color", modifiers: [["brighter", 0.1]] }
          }
          enableArcLabels
          arcLabelsSkipAngle={10}
          arcLabelsTextColor={{ from: "color", modifiers: [["darker", 2]] }}
          margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
        />
      </div>
    </div>
  );
}
