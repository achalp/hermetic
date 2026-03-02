"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyFinanceChart } from "./plotly-finance-wrapper";
import { useTrendColors } from "@/lib/chart-theme";

interface CandlestickChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  date_key: string;
  open_key: string;
  high_key: string;
  low_key: string;
  close_key: string;
  volume_key?: string | null;
  show_volume?: boolean | null;
  height?: number | null;
}

interface OHLCDatum {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function parseDate(val: unknown): Date | null {
  if (val instanceof Date) return val;
  if (typeof val === "number") return new Date(val);
  if (typeof val === "string") {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function CandlestickChartComponent({ props }: { props: CandlestickChartProps }) {
  const trend = useTrendColors();
  const rows = Array.isArray(props.data) ? props.data : [];
  if (rows.length === 0) return <div style={{ height: 400 }} />;

  const ohlcData: OHLCDatum[] = [];
  for (const row of rows) {
    const date = parseDate(row[props.date_key]);
    const open = Number(row[props.open_key]);
    const high = Number(row[props.high_key]);
    const low = Number(row[props.low_key]);
    const close = Number(row[props.close_key]);
    const volume = props.volume_key ? Number(row[props.volume_key]) || 0 : 0;

    if (date && !isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close)) {
      ohlcData.push({ date: date.toISOString().split("T")[0], open, high, low, close, volume });
    }
  }

  if (ohlcData.length === 0) return <div style={{ height: 400 }} />;

  ohlcData.sort((a, b) => a.date.localeCompare(b.date));

  const dates = ohlcData.map((d) => d.date);
  const showVolume = (props.show_volume ?? true) && !!props.volume_key;
  const chartHeight = props.height ?? 400;

  const traces: Data[] = [
    {
      type: "candlestick" as const,
      x: dates,
      open: ohlcData.map((d) => d.open),
      high: ohlcData.map((d) => d.high),
      low: ohlcData.map((d) => d.low),
      close: ohlcData.map((d) => d.close),
      increasing: { line: { color: trend.up } },
      decreasing: { line: { color: trend.down } },
      name: "OHLC",
      yaxis: "y2",
    },
  ];

  if (showVolume) {
    const colors = ohlcData.map((d) => (d.close >= d.open ? trend.upAlpha : trend.downAlpha));
    traces.unshift({
      type: "bar" as const,
      x: dates,
      y: ohlcData.map((d) => d.volume),
      marker: { color: colors },
      name: "Volume",
      yaxis: "y",
    });
  }

  const layout: Partial<Layout> = {
    xaxis: {
      type: "category",
      rangeslider: { visible: false },
    },
    yaxis: showVolume
      ? { domain: [0, 0.2], showticklabels: false, showgrid: false }
      : { visible: false, domain: [0, 0] },
    yaxis2: {
      domain: showVolume ? [0.25, 1] : [0, 1],
    },
    showlegend: false,
    margin: { l: 50, r: 20, t: 10, b: 40 },
  };

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
      <PlotlyFinanceChart data={traces} layout={layout} height={chartHeight} />
    </div>
  );
}
