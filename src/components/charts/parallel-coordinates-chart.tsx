"use client";

import { useMemo } from "react";
import { useColorMap, useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface ParallelCoordinatesChartProps {
  title: string | null;
  data: Record<string, unknown>[];
  dimensions: string[];
  group_key: string | null;
  color_map: Record<string, string> | null;
  line_opacity: number | null;
}

export function ParallelCoordinatesComponent({ props }: { props: ParallelCoordinatesChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const rows = useMemo(() => (Array.isArray(props.data) ? props.data : []), [props.data]);
  const dims = useMemo(() => props.dimensions ?? [], [props.dimensions]);

  const groupNames = useMemo(() => {
    if (!props.group_key) return ["all"];
    const s = new Set<string>();
    for (const row of rows) s.add(String(row[props.group_key] ?? "Other"));
    return [...s];
  }, [rows, props.group_key]);

  const colors = useColorMap(groupNames, props.color_map);
  const colorMap = useMemo(
    () => new Map(groupNames.map((g, i) => [g, colors[i]])),
    [groupNames, colors]
  );

  // Compute min/max per dimension
  const scales = useMemo(() => {
    return dims.map((dim) => {
      let min = Infinity;
      let max = -Infinity;
      for (const row of rows) {
        const v = Number(row[dim]);
        if (!isNaN(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (min === max) {
        min -= 1;
        max += 1;
      }
      return { dim, min, max };
    });
  }, [rows, dims]);

  if (rows.length === 0 || dims.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  const height = chart.height;
  const width = 800;
  const margin = { top: 30, right: 30, bottom: 20, left: 30 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const axisSpacing = innerW / Math.max(dims.length - 1, 1);

  const normalize = (val: number, scaleIdx: number) => {
    const { min, max } = scales[scaleIdx];
    return innerH - ((val - min) / (max - min)) * innerH;
  };

  const textFill = (theme.text?.fill as string) ?? "#374151";
  const lineOpacity = props.line_opacity ?? 0.4;

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
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: chart.height }}
        preserveAspectRatio="xMidYMid meet"
      >
        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Polylines for each row */}
          {rows.map((row, ri) => {
            const group = props.group_key ? String(row[props.group_key] ?? "Other") : "all";
            const color = colorMap.get(group) ?? "#6366f1";
            const points = dims
              .map((dim, di) => {
                const v = Number(row[dim]);
                if (isNaN(v)) return null;
                return `${di * axisSpacing},${normalize(v, di)}`;
              })
              .filter(Boolean)
              .join(" ");
            return (
              <polyline
                key={ri}
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                opacity={lineOpacity}
              />
            );
          })}
          {/* Axes */}
          {scales.map((s, di) => {
            const x = di * axisSpacing;
            return (
              <g key={di}>
                <line x1={x} y1={0} x2={x} y2={innerH} stroke={textFill} opacity={0.3} />
                <text x={x} y={-10} textAnchor="middle" fill={textFill} fontSize={11}>
                  {s.dim}
                </text>
                <text
                  x={x}
                  y={innerH + 14}
                  textAnchor="middle"
                  fill={textFill}
                  fontSize={9}
                  opacity={0.6}
                >
                  {s.min.toFixed(1)}
                </text>
                <text
                  x={x}
                  y={-2}
                  textAnchor="middle"
                  fill={textFill}
                  fontSize={9}
                  opacity={0.6}
                  dy="-4"
                >
                  {s.max.toFixed(1)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
