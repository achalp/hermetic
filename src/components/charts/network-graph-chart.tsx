"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap, useChartColors } from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface NetworkNode {
  id: string;
  x?: number | null;
  y?: number | null;
  label?: string | null;
  size?: number | null;
  group?: string | null;
}

interface NetworkEdge {
  source: string;
  target: string;
  weight?: number | null;
}

interface NetworkGraphProps {
  title?: string | null;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  show_labels?: boolean | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

export function NetworkGraphComponent({ props }: { props: NetworkGraphProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const nodes = Array.isArray(props.nodes) ? props.nodes : [];
  const edges = Array.isArray(props.edges) ? props.edges : [];

  const groups = Array.from(new Set(nodes.map((n) => String(n.group ?? "—"))));
  const colors = useColorMap(groups, props.color_map);

  if (nodes.length === 0) return <ChartEmptyState height={chart.height} />;

  // Resolve positions: use provided x/y, else lay nodes out on a circle.
  const hasPos = nodes.every((n) => n.x != null && n.y != null);
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    if (hasPos) {
      pos.set(n.id, { x: Number(n.x), y: Number(n.y) });
    } else {
      const a = (2 * Math.PI * i) / nodes.length;
      pos.set(n.id, { x: Math.cos(a), y: Math.sin(a) });
    }
  });

  // Edge segments as a single line trace with null gaps.
  const ex: (number | null)[] = [];
  const ey: (number | null)[] = [];
  for (const e of edges) {
    const s = pos.get(e.source);
    const t = pos.get(e.target);
    if (!s || !t) continue;
    ex.push(s.x, t.x, null);
    ey.push(s.y, t.y, null);
  }

  const edgeTrace: Data = {
    type: "scatter" as const,
    mode: "lines" as const,
    x: ex,
    y: ey,
    line: { color: "rgba(120,130,145,0.35)", width: 1 },
    hoverinfo: "skip" as const,
    showlegend: false,
  };

  const showLabels = props.show_labels ?? nodes.length <= 30;
  const nodeTrace: Data = {
    type: "scatter" as const,
    mode: showLabels ? ("text+markers" as const) : ("markers" as const),
    x: nodes.map((n) => pos.get(n.id)!.x),
    y: nodes.map((n) => pos.get(n.id)!.y),
    text: nodes.map((n) => n.label ?? n.id),
    textposition: "top center" as const,
    textfont: { size: 10 },
    marker: {
      color: nodes.map((n) => colors[groups.indexOf(String(n.group ?? "—"))] ?? palette[0]),
      size: nodes.map((n) => Math.max(6, Number(n.size) || 10)),
      line: { color: "#ffffff", width: 1 },
    },
    hovertext: nodes.map((n) => n.label ?? n.id),
    hoverinfo: "text" as const,
    showlegend: false,
  };

  const hiddenAxis = { showgrid: false, zeroline: false, showticklabels: false } as const;
  const layout: Partial<Layout> = {
    xaxis: hiddenAxis,
    yaxis: hiddenAxis,
    showlegend: false,
    margin: { l: 10, r: 10, t: 10, b: 10 },
    hovermode: "closest",
  };

  const chartHeight = props.height ?? chart.height;

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
      <div className={isExpanded ? "flex-1" : ""}>
        <PlotlyChart
          data={[edgeTrace, nodeTrace]}
          layout={layout}
          height={isExpanded ? undefined : chartHeight}
        />
      </div>
    </div>
  );
}
