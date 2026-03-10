"use client";

import { useMemo } from "react";
import { ResponsiveCalendar } from "@nivo/calendar";
import { useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface CalendarChartProps {
  title: string | null;
  data: { day: string; value: number }[];
  from: string | null;
  to: string | null;
  color_scale: string[] | null;
  empty_color: string | null;
  direction: "horizontal" | "vertical" | null;
}

export function CalendarChartComponent({ props }: { props: CalendarChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];

  // Derive from/to from data when not provided
  const { from, to } = useMemo(() => {
    if (props.from && props.to) return { from: props.from, to: props.to };
    const days = data
      .map((d) => d.day)
      .filter(Boolean)
      .sort();
    return {
      from: props.from ?? days[0] ?? "",
      to: props.to ?? days[days.length - 1] ?? "",
    };
  }, [props.from, props.to, data]);

  if (data.length === 0 || !from || !to) {
    return <div style={{ height: chart.height }} />;
  }

  // Compute height based on year span — each year row needs ~160px
  const yearSpan = Math.max(1, new Date(to).getFullYear() - new Date(from).getFullYear() + 1);
  const calendarHeight = Math.max(chart.height, yearSpan * 180 + 60);

  const colorScale = props.color_scale ?? ["#f0fdf4", "#86efac", "#22c55e", "#15803d", "#052e16"];

  // Use theme-aware border/empty colors
  const isDark =
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const emptyColor = props.empty_color ?? (isDark ? "#1f2937" : "#eeeeee");
  const borderColor = isDark ? "#374151" : "#ffffff";

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
      <div style={{ height: calendarHeight }}>
        <ResponsiveCalendar
          data={data}
          from={from}
          to={to}
          theme={theme}
          emptyColor={emptyColor}
          colors={colorScale}
          margin={{ top: 20, right: 20, bottom: 40, left: 20 }}
          yearSpacing={40}
          monthBorderColor={borderColor}
          dayBorderWidth={2}
          dayBorderColor={borderColor}
          direction={props.direction ?? "horizontal"}
          legends={[
            {
              anchor: "bottom-right",
              direction: "row",
              translateY: 36,
              itemCount: 4,
              itemWidth: 42,
              itemHeight: 36,
              itemDirection: "right-to-left",
            },
          ]}
        />
      </div>
    </div>
  );
}
