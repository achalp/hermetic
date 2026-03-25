"use client";

import { useMemo } from "react";
import { ResponsivePie } from "@nivo/pie";
import { resolveColors, useChartColors, useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface PieChartProps {
  title?: string | null;
  data: { label: string; value: number }[];
  show_labels?: boolean | null;
  show_legend?: boolean | null;
  donut?: boolean | null;
  colors?: string[] | null;
  selects?: { column: string; bindTo: string } | null;
}

interface EventHandle {
  emit: () => void;
  bound: boolean;
  shouldPreventDefault: boolean;
}

export function PieChartComponent({
  props,
  emit,
  on,
  selectedValue,
  onSelect,
}: {
  props: PieChartProps;
  emit?: (event: string) => void;
  on?: (event: string) => EventHandle;
  selectedValue?: string | null;
  onSelect?: (value: string) => void;
}) {
  const isSelectable = !!onSelect;
  const clickHandle = on?.("click");
  const isDrillable = !isSelectable && (clickHandle?.bound ?? false);
  const baseTheme = useNivoTheme();
  const tc = useThemeConfig();
  const { chart } = tc;

  // Pie needs smaller label text than bar/line charts to avoid clipping
  const theme = useMemo(
    () => ({
      ...baseTheme,
      labels: { text: { fontSize: 10, fill: baseTheme.text?.fill as string } },
    }),
    [baseTheme]
  );

  const rawData = Array.isArray(props.data) ? props.data : [];

  // Normalize data: the LLM may use keys other than "label"/"value".
  // Try to infer the correct keys from the first row.
  const nivoData = rawData
    .map((d) => {
      if (d.label !== undefined && d.value !== undefined) {
        return { id: String(d.label), value: Math.round(Number(d.value) * 100) / 100 };
      }
      // Infer: first string-ish key → label, first number-ish key → value
      const entries = Object.entries(d as Record<string, unknown>);
      let label: string | undefined;
      let value: number | undefined;
      for (const [, v] of entries) {
        if (label === undefined && typeof v === "string") label = v;
        if (value === undefined && typeof v === "number") value = v;
      }
      if (label !== undefined && value !== undefined) {
        return { id: label, value: Math.round(value * 100) / 100 };
      }
      return null;
    })
    .filter((d): d is { id: string; value: number } => d !== null && !isNaN(d.value))
    // Deduplicate ids: append index suffix for duplicates to avoid React key warnings
    .map((d, i, arr) => {
      const dupesBefore = arr.slice(0, i).filter((x) => x.id === d.id).length;
      return dupesBefore > 0 ? { ...d, id: `${d.id} (${dupesBefore + 1})` } : d;
    });

  const themeColors = useChartColors();
  const baseColors = props.colors
    ? resolveColors(props.colors)
    : themeColors.slice(0, nivoData.length);

  // When a slice is selected, dim unselected slices via hex alpha suffix
  const colors =
    isSelectable && selectedValue
      ? (datum: { id: string | number }) => {
          const idx = nivoData.findIndex((d) => d.id === datum.id);
          const baseColor = baseColors[idx >= 0 ? idx : 0];
          return String(datum.id) === selectedValue ? baseColor : baseColor + "40"; // 25% opacity
        }
      : baseColors;

  if (nivoData.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  return (
    <div
      className={`w-full${isDrillable || isSelectable ? " cursor-pointer" : ""}`}
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
          {isSelectable && !selectedValue && (
            <span className="ml-2 text-xs font-normal text-t-tertiary">Click to filter</span>
          )}
        </h3>
      )}
      <div style={{ height: chart.height }}>
        <ResponsivePie
          data={nivoData}
          colors={colors}
          innerRadius={props.donut ? 0.5 : 0}
          padAngle={chart.piePadAngle}
          cornerRadius={chart.pieCornerRadius}
          margin={{ top: 20, right: 80, bottom: props.show_legend ? 60 : 40, left: 80 }}
          theme={theme}
          activeId={isSelectable && selectedValue ? selectedValue : undefined}
          activeOuterRadiusOffset={isSelectable && selectedValue ? 8 : undefined}
          enableArcLabels={props.show_labels ?? false}
          enableArcLinkLabels={props.show_labels ?? true}
          arcLabelsSkipAngle={15}
          arcLabel={(d) => {
            const v = d.value;
            return Number.isInteger(v) ? String(v) : v.toFixed(1);
          }}
          arcLinkLabelsSkipAngle={12}
          arcLinkLabelsDiagonalLength={16}
          arcLinkLabelsStraightLength={16}
          arcLinkLabelsTextOffset={4}
          arcLinkLabelsThickness={1}
          arcLinkLabelsColor={{ from: "color" }}
          arcLinkLabelsTextColor={theme.text?.fill as string}
          legends={
            props.show_legend
              ? [
                  {
                    anchor: "bottom",
                    direction: "row",
                    translateY: 36,
                    itemWidth: 100,
                    itemHeight: 18,
                    symbolSize: chart.legendSymbolSize,
                    symbolShape: "circle",
                  },
                ]
              : []
          }
          onClick={
            isSelectable
              ? (datum) => onSelect(String(datum.id))
              : isDrillable
                ? () => emit?.("click")
                : undefined
          }
        />
      </div>
    </div>
  );
}
