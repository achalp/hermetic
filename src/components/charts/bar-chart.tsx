"use client";

import { ResponsiveBar } from "@nivo/bar";
import {
  useColorMap,
  useNivoTheme,
  formatAxisNumber,
  pickTickValues,
  unwrapChartData,
} from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { drillClickValueRef } from "@/lib/drill-down-context";
import { CLICK_PRIMARY } from "@/lib/drill-resolve";

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
  const isExpanded = useChartExpanded();

  // Coerce array-typed props: a misbound placeholder can deliver a non-array,
  // which would crash on .map/.length/.indexOf downstream.
  const y_keys = Array.isArray(props.y_keys) ? props.y_keys : [];

  const raw = unwrapChartData(props.data);
  // Deduplicate rows by indexBy key — Nivo uses it as React key so duplicates
  // cause "two children with the same key" errors.  Sum numeric y values.
  const data = (() => {
    const seen = new Map<string, Record<string, unknown>>();
    for (const row of raw) {
      const key = String(row[props.x_key] ?? "");
      const existing = seen.get(key);
      if (existing) {
        for (const yk of y_keys) {
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
  const baseColors = useColorMap(y_keys, props.color_map);

  // When a bar is selected, dim unselected bars via hex alpha suffix
  const colors =
    isSelectable && selectedValue
      ? (bar: { indexValue: string | number; id: string | number }) => {
          const colorIdx = y_keys.indexOf(String(bar.id));
          const baseColor = baseColors[colorIdx >= 0 ? colorIdx : 0];
          return String(bar.indexValue) === selectedValue ? baseColor : baseColor + "40"; // 25% opacity
        }
      : baseColors;
  const layout = props.orientation === "horizontal" ? "horizontal" : "vertical";
  const isHorizontal = layout === "horizontal";

  // Compute left margin: for horizontal bars, measure the longest category label
  const maxLabelChars = isHorizontal
    ? Math.max(0, ...data.map((d) => String(d[props.x_key] ?? "").length))
    : 0;
  const hLabelLimit = isExpanded ? 60 : 40;
  const displayChars = Math.min(maxLabelChars, hLabelLimit);
  const leftMargin = isHorizontal
    ? Math.min(isExpanded ? 420 : 300, Math.max(90, displayChars * 7 + 16))
    : chart.margin.left;

  // For vertical bars with many categories, apply smart label handling
  const manyCategories = !isHorizontal && data.length > 8;
  const veryManyCategories = !isHorizontal && data.length > 25;

  // Sample tick values for bar charts with many categories (same as line/area)
  const tickValues = !isHorizontal
    ? pickTickValues(data, props.x_key, veryManyCategories ? 15 : 12)
    : undefined;

  // Truncate long labels to prevent overlap
  const truncateLabel = (v: string | number): string => {
    const s = String(v);
    if (!manyCategories) return s;
    const max = veryManyCategories ? 12 : 18;
    return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
  };

  // Ensure value scale always includes 0 so bars render correctly with all-negative or all-positive data
  const allValues = data.flatMap((d) => y_keys.map((k) => Number(d[k]) || 0));
  const dataMin = Math.min(0, ...allValues);
  const dataMax = Math.max(0, ...allValues);

  // Compute legend item width from longest key name
  const hasLegend = y_keys.length > 1;
  const maxKeyLen = hasLegend ? Math.max(...y_keys.map((k) => k.length)) : 0;
  const legendItemWidth = Math.max(100, Math.min(200, maxKeyLen * 8 + 24));

  if (data.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  return (
    <div
      className={`w-full${isDrillable || isSelectable ? " cursor-pointer" : ""}${isExpanded ? " h-full flex flex-col" : ""}`}
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
      <div
        className={isExpanded ? "flex-1" : ""}
        style={{ height: isExpanded ? undefined : chart.height }}
      >
        <ResponsiveBar
          data={data as Record<string, string | number>[]}
          keys={y_keys}
          indexBy={props.x_key}
          layout={layout}
          groupMode={props.stacked ? "stacked" : "grouped"}
          valueScale={{ type: "linear", min: dataMin, max: dataMax }}
          colors={colors}
          margin={{
            top: chart.margin.top,
            right: chart.margin.right,
            bottom:
              (veryManyCategories
                ? chart.margin.bottom + 80
                : manyCategories
                  ? chart.margin.bottom + 50
                  : chart.margin.bottom) + (hasLegend ? 30 : 0),
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
            tickRotation: veryManyCategories ? -90 : manyCategories ? -45 : 0,
            ...(isHorizontal
              ? { format: formatAxisNumber, tickValues: 5 }
              : {
                  format: truncateLabel,
                  ...(tickValues ? { tickValues } : {}),
                }),
          }}
          axisLeft={{
            tickSize: chart.axisTickSize,
            tickPadding: 5,
            tickRotation: 0,
            ...(!isHorizontal
              ? { format: formatAxisNumber, tickValues: 5 }
              : {
                  format: (v: string | number) => {
                    const s = String(v);
                    return s.length > hLabelLimit ? s.slice(0, hLabelLimit - 1) + "\u2026" : s;
                  },
                }),
          }}
          enableLabel={false}
          legends={
            hasLegend
              ? [
                  {
                    dataFrom: "keys",
                    anchor: "bottom",
                    direction: "row",
                    translateY: veryManyCategories ? 96 : manyCategories ? 66 : 46,
                    itemWidth: legendItemWidth,
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
                ? (datum) => {
                    // Capture the clicked category (keyed by its real column)
                    // so the drill callback can resolve the spec's {"$item": …}
                    // filter binding.
                    drillClickValueRef.current = {
                      [props.x_key]: datum.indexValue,
                      [CLICK_PRIMARY]: datum.indexValue,
                    };
                    emit?.("click");
                  }
                : undefined
          }
        />
      </div>
    </div>
  );
}
