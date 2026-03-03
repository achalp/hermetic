"use client";

import { ResponsiveTreeMap } from "@nivo/treemap";
import { useNivoTheme, useChartColors } from "@/lib/chart-theme";
import { resolveColors } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface TreemapChartProps {
  title: string | null;
  data: Record<string, unknown>;
  colors: string[] | null;
  tile_mode: "squarify" | "binary" | "slice" | "dice" | null;
  label_skip_size: number | null;
  border_width: number | null;
}

export function TreemapChartComponent({ props }: { props: TreemapChartProps }) {
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
        <ResponsiveTreeMap
          data={props.data as { name: string; children?: unknown[] }}
          identity="name"
          value="value"
          theme={theme}
          colors={colors}
          tile={props.tile_mode ?? "squarify"}
          leavesOnly
          innerPadding={3}
          outerPadding={3}
          borderWidth={props.border_width ?? 1}
          borderColor={{ from: "color", modifiers: [["darker", 0.3]] }}
          labelSkipSize={props.label_skip_size ?? 12}
          labelTextColor={{ from: "color", modifiers: [["darker", 2]] }}
          margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
        />
      </div>
    </div>
  );
}
