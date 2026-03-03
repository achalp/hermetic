"use client";

import { ResponsiveSankey } from "@nivo/sankey";
import { useColorMap, useNivoTheme } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface SankeyChartProps {
  title: string | null;
  nodes: { id: string; label: string | null }[];
  links: { source: string; target: string; value: number }[];
  color_map: Record<string, string> | null;
  label_position: "inside" | "outside" | null;
  align: "left" | "center" | "right" | "justify" | null;
}

export function SankeyChartComponent({ props }: { props: SankeyChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const nodes = (Array.isArray(props.nodes) ? props.nodes : []).map((n) => ({
    ...n,
    label: n.label ?? undefined,
  }));
  const links = Array.isArray(props.links) ? props.links : [];
  const nodeIds = nodes.map((n) => n.id);
  const colors = useColorMap(nodeIds, props.color_map);

  if (nodes.length === 0 || links.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

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
        <ResponsiveSankey
          data={{ nodes, links }}
          theme={theme}
          colors={colors}
          margin={{ top: 10, right: 160, bottom: 10, left: 10 }}
          align={(props.align ?? "justify") as "justify" | "center" | "start" | "end"}
          nodeOpacity={1}
          nodeThickness={18}
          nodeInnerPadding={3}
          nodeSpacing={24}
          nodeBorderWidth={0}
          linkOpacity={0.5}
          linkHoverOthersOpacity={0.1}
          linkContract={3}
          enableLinkGradient
          labelPosition={props.label_position ?? "outside"}
          labelOrientation="horizontal"
          labelPadding={16}
        />
      </div>
    </div>
  );
}
