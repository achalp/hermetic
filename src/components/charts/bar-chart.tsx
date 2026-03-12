"use client";

import { ResponsiveBar } from "@nivo/bar";
import { useColorMap, useNivoTheme, formatAxisNumber } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface BarChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  x_key: string;
  y_keys: string[];
  orientation?: "vertical" | "horizontal" | null;
  stacked?: boolean | null;
  color_map?: Record<string, string> | null;
  selects?: { column: string; bindTo: string } | null;
}

interface EventHandle {
  emit: () => void;
  bound: boolean;
  shouldPreventDefault: boolean;
}

export function BarChartComponent({
  props,
  emit,
  on,
  selectedValue,
  onSelect,
}: {
  props: BarChartProps;
  emit?: (event: string) => void;
  on?: (event: string) => EventHandle;
  selectedValue?: string | null;
  onSelect?: (value: string) => void;
}) {
  const isSelectable = !!onSelect;
  const clickHandle = on?.("click");
  const isDrillable = !isSelectable && (clickHandle?.bound ?? false);
  const theme = useNivoTheme();
  const config = useThemeConfig();
  const { chart } = config;

  const raw = Array.isArray(props.data) ? props.data : [];
  // Deduplicate rows by indexBy key — Nivo uses it as React key so duplicates
  // cause "two children with the same key" errors.  Sum numeric y values.
  const data = (() => {
    const seen = new Map<string, Record<string, unknown>>();
    for (const row of raw) {
      const key = String(row[props.x_key] ?? "");
      const existing = seen.get(key);
      if (existing) {
        for (const yk of props.y_keys) {
          const prev = Number(existing[yk]) || 0;
          const curr = Number(row[yk]) || 0;
          existing[yk] = prev + curr;
        }
      } else {
        seen.set(key, { ...row });
      }
    }
    return Array.from(seen.values());
  })();
  const baseColors = useColorMap(props.y_keys, props.color_map);

  // When a bar is selected, dim unselected bars via hex alpha suffix
  const colors =
    isSelectable && selectedValue
      ? (bar: { indexValue: string | number; id: string | number }) => {
          const colorIdx = props.y_keys.indexOf(String(bar.id));
          const baseColor = baseColors[colorIdx >= 0 ? colorIdx : 0];
          return String(bar.indexValue) === selectedValue ? baseColor : baseColor + "40"; // 25% opacity
        }
      : baseColors;
  const layout = props.orientation === "horizontal" ? "horizontal" : "vertical";
  const isHorizontal = layout === "horizontal";

  // Compute left margin: for horizontal bars, measure the longest category label
  const leftMargin = isHorizontal
    ? Math.min(220, Math.max(90, ...data.map((d) => String(d[props.x_key] ?? "").length * 8 + 10)))
    : chart.margin.left;

  // For vertical bars with many categories, rotate labels
  const manyCategories = !isHorizontal && data.length > 8;

  // Ensure value scale always includes 0 so bars render correctly with all-negative or all-positive data
  const allValues = data.flatMap((d) => props.y_keys.map((k) => Number(d[k]) || 0));
  const dataMin = Math.min(0, ...allValues);
  const dataMax = Math.max(0, ...allValues);

  if (data.length === 0) {
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
        <ResponsiveBar
          data={data as Record<string, string | number>[]}
          keys={props.y_keys}
          indexBy={props.x_key}
          layout={layout}
          groupMode={props.stacked ? "stacked" : "grouped"}
          valueScale={{ type: "linear", min: dataMin, max: dataMax }}
          colors={colors}
          margin={{
            top: chart.margin.top,
            right: chart.margin.right,
            bottom: manyCategories ? chart.margin.bottom + 50 : chart.margin.bottom,
            left: leftMargin,
          }}
          padding={chart.barPadding}
          borderRadius={chart.barRadius}
          theme={theme}
          enableGridX={chart.enableGridX}
          enableGridY={chart.enableGridY}
          axisBottom={{
            tickSize: chart.axisTickSize,
            tickPadding: 5,
            tickRotation: manyCategories ? -45 : 0,
            ...(isHorizontal ? { format: formatAxisNumber, tickValues: 5 } : {}),
          }}
          axisLeft={{
            tickSize: chart.axisTickSize,
            tickPadding: 5,
            tickRotation: 0,
            ...(!isHorizontal ? { format: formatAxisNumber, tickValues: 5 } : {}),
          }}
          enableLabel={false}
          legends={
            props.y_keys.length > 1
              ? [
                  {
                    dataFrom: "keys",
                    anchor: "bottom",
                    direction: "row",
                    translateY: 46,
                    itemWidth: 100,
                    itemHeight: 20,
                    symbolSize: chart.legendSymbolSize,
                  },
                ]
              : []
          }
          onClick={
            isSelectable
              ? (datum) => onSelect(String(datum.indexValue))
              : isDrillable
                ? () => emit?.("click")
                : undefined
          }
        />
      </div>
    </div>
  );
}
