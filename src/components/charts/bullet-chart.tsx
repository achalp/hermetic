"use client";

import { useNivoTheme, useChartColors, resolveColor } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface BulletChartProps {
  title: string | null;
  data: { label: string; value: number; target: number | null; ranges: number[] }[];
  orientation: "vertical" | "horizontal" | null;
  range_colors: string[] | null;
  value_color: string | null;
}

export function BulletChartComponent({ props }: { props: BulletChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const themeColors = useChartColors();
  const data = Array.isArray(props.data) ? props.data : [];

  if (data.length === 0) return <div style={{ height: chart.height }} />;

  const textFill = (theme.text?.fill as string) ?? "#374151";
  const valueColor = resolveColor(props.value_color ?? themeColors[0]);

  const defaultRangeColors = ["#e5e7eb", "#d1d5db", "#9ca3af"];
  const rangeColors = props.range_colors
    ? props.range_colors.map(resolveColor)
    : defaultRangeColors;

  const itemHeight = 50;
  const labelWidth = 100;
  const svgHeight = Math.max(chart.height, data.length * (itemHeight + 10) + 20);
  const svgWidth = 700;
  const barAreaWidth = svgWidth - labelWidth - 20;

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
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{ width: "100%", height: svgHeight }}
        preserveAspectRatio="xMidYMid meet"
      >
        {data.map((item, idx) => {
          const sortedRanges = [...item.ranges].sort((a, b) => a - b);
          const maxRange = sortedRanges[sortedRanges.length - 1] || 100;
          const scale = (v: number) => (v / maxRange) * barAreaWidth;
          const y = idx * (itemHeight + 10) + 10;

          return (
            <g key={idx}>
              {/* Label */}
              <text
                x={labelWidth - 10}
                y={y + itemHeight / 2}
                textAnchor="end"
                dominantBaseline="middle"
                fill={textFill}
                fontSize={12}
              >
                {item.label}
              </text>
              {/* Range bars (draw largest first) */}
              {[...sortedRanges].reverse().map((range, ri) => {
                const rangeH = itemHeight - ri * 8;
                const rangeY = y + (itemHeight - rangeH) / 2;
                return (
                  <rect
                    key={ri}
                    x={labelWidth}
                    y={rangeY}
                    width={scale(range)}
                    height={rangeH}
                    fill={
                      rangeColors[sortedRanges.length - 1 - ri] ??
                      rangeColors[rangeColors.length - 1]
                    }
                    rx={2}
                  />
                );
              })}
              {/* Value bar */}
              <rect
                x={labelWidth}
                y={y + itemHeight / 2 - 6}
                width={scale(item.value)}
                height={12}
                fill={valueColor}
                rx={2}
              />
              {/* Target marker */}
              {item.target != null && (
                <line
                  x1={labelWidth + scale(item.target)}
                  y1={y + 4}
                  x2={labelWidth + scale(item.target)}
                  y2={y + itemHeight - 4}
                  stroke={textFill}
                  strokeWidth={2.5}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
