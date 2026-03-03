"use client";

import { ResponsiveCalendar } from "@nivo/calendar";
import { useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface CalendarChartProps {
  title: string | null;
  data: { day: string; value: number }[];
  from: string;
  to: string;
  color_scale: string[] | null;
  empty_color: string | null;
  direction: "horizontal" | "vertical" | null;
}

export function CalendarChartComponent({ props }: { props: CalendarChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];

  if (data.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  const colorScale = props.color_scale ?? ["#f0fdf4", "#86efac", "#22c55e", "#15803d", "#052e16"];

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
        <ResponsiveCalendar
          data={data}
          from={props.from}
          to={props.to}
          theme={theme}
          emptyColor={props.empty_color ?? "#eeeeee"}
          colors={colorScale}
          margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
          yearSpacing={40}
          monthBorderColor="#ffffff"
          dayBorderWidth={2}
          dayBorderColor="#ffffff"
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
