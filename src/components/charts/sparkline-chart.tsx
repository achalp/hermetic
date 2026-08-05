"use client";

import { useId } from "react";
import {
  useChartColors,
  unwrapChartData,
  formatAxisNumber,
  resolveColor,
} from "@/components/theme/chart-theme";

interface SparklineProps {
  title?: string | null;
  data: Record<string, unknown>[];
  value_key: string;
  /** Optional label shown to the left of the line. */
  label?: string | null;
  /** Show the latest value as a large number beside the line. */
  show_value?: boolean | null;
  /** Fill the area under the line. */
  area?: boolean | null;
  /** Mark the final point. */
  show_last_point?: boolean | null;
  color?: string | null;
  height?: number | null;
}

export function SparklineComponent({ props }: { props: SparklineProps }) {
  const palette = useChartColors();
  const gradId = useId().replace(/:/g, "");
  const rows = unwrapChartData(props.data);
  const values = rows
    .map((r) => Number(r[props.value_key]))
    .filter((v) => Number.isFinite(v)) as number[];

  const color = props.color ? resolveColor(props.color) : palette[0];
  const h = props.height ?? 40;
  const w = 160;
  const pad = 3;

  if (values.length < 2) {
    return <div style={{ height: h }} />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return [x, y] as const;
  });
  const linePath = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${h - pad} L${points[0][0].toFixed(1)},${h - pad} Z`;
  const last = points[points.length - 1];

  return (
    <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
      {props.label && (
        <span className="shrink-0 text-t-secondary" style={{ fontSize: 13 }}>
          {props.label}
        </span>
      )}
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ flex: "1 1 auto", minWidth: 0, overflow: "visible" }}
      >
        {props.area && (
          <>
            <defs>
              <linearGradient id={`spark-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={areaPath} fill={`url(#spark-${gradId})`} />
          </>
        )}
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        {(props.show_last_point ?? true) && (
          <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
        )}
      </svg>
      {props.show_value && (
        <span
          className="shrink-0 tabular-nums text-t-primary"
          style={{ fontSize: 18, fontWeight: 600 }}
        >
          {formatAxisNumber(values[values.length - 1])}
        </span>
      )}
    </div>
  );
}
