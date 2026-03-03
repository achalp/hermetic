"use client";

import { ResponsiveChord } from "@nivo/chord";
import { useNivoTheme, useChartColors, resolveColors } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface ChordChartProps {
  title: string | null;
  matrix: number[][];
  keys: string[];
  colors: string[] | null;
  pad_angle: number | null;
  inner_radius_ratio: number | null;
}

export function ChordChartComponent({ props }: { props: ChordChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const themeColors = useChartColors();
  const colors = props.colors ? resolveColors(props.colors) : themeColors;

  if (!props.matrix || props.matrix.length === 0 || !props.keys || props.keys.length === 0) {
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
        <ResponsiveChord
          data={props.matrix}
          keys={props.keys}
          theme={theme}
          colors={colors}
          margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
          padAngle={props.pad_angle ?? 0.02}
          innerRadiusRatio={props.inner_radius_ratio ?? 0.96}
          innerRadiusOffset={0.02}
          arcOpacity={1}
          arcBorderWidth={1}
          arcBorderColor={{ from: "color", modifiers: [["darker", 0.4]] }}
          ribbonOpacity={0.5}
          ribbonBorderWidth={1}
          ribbonBorderColor={{ from: "color", modifiers: [["darker", 0.4]] }}
          enableLabel
          labelOffset={12}
          labelRotation={-90}
          isInteractive
        />
      </div>
    </div>
  );
}
