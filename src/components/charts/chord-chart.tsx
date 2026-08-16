"use client";

import { ResponsiveChord } from "@nivo/chord";
import {
  useNivoTheme,
  useChartColors,
  resolveColors,
  useReducedMotion,
} from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

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
  const reducedMotion = useReducedMotion();
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const themeColors = useChartColors();
  const colors = props.colors ? resolveColors(props.colors) : themeColors;

  if (
    !Array.isArray(props.matrix) ||
    props.matrix.length === 0 ||
    !Array.isArray(props.keys) ||
    props.keys.length === 0
  ) {
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
        <ResponsiveChord
          animate={!reducedMotion}
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
