"use client";

import { useMemo } from "react";
import { useNivoTheme, useChartColors, resolveColor } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface TreeNode {
  label: string;
  value?: string | number;
  condition?: string;
  children?: TreeNode[];
  color?: string;
}

interface DecisionTreeChartProps {
  title: string | null;
  tree: Record<string, unknown>;
  orientation: "vertical" | "horizontal" | null;
  node_width: number | null;
  node_height: number | null;
}

interface LayoutNode {
  node: TreeNode;
  x: number;
  y: number;
  width: number;
  height: number;
  children: LayoutNode[];
}

function layoutTree(
  node: TreeNode,
  nodeW: number,
  nodeH: number,
  hGap: number,
  vGap: number,
  depth: number
): LayoutNode {
  const children = (node.children ?? []).map((child) =>
    layoutTree(child, nodeW, nodeH, hGap, vGap, depth + 1)
  );

  if (children.length === 0) {
    return { node, x: 0, y: depth * (nodeH + vGap), width: nodeW, height: nodeH, children };
  }

  // Position children side by side
  let offset = 0;
  for (const child of children) {
    child.x += offset;
    shiftTree(child, offset);
    offset += child.width + hGap;
  }

  const totalWidth = offset - hGap;
  const x =
    children[0].x + (children[children.length - 1].x + nodeW - children[0].x) / 2 - nodeW / 2;

  return {
    node,
    x,
    y: depth * (nodeH + vGap),
    width: Math.max(totalWidth, nodeW),
    height: nodeH,
    children,
  };
}

function shiftTree(layoutNode: LayoutNode, dx: number) {
  for (const child of layoutNode.children) {
    child.x += dx;
    shiftTree(child, dx);
  }
}

function getTreeBounds(ln: LayoutNode): { minX: number; maxX: number; maxY: number } {
  let minX = ln.x;
  let maxX = ln.x + ln.width;
  let maxY = ln.y + ln.height;
  for (const child of ln.children) {
    const cb = getTreeBounds(child);
    if (cb.minX < minX) minX = cb.minX;
    if (cb.maxX > maxX) maxX = cb.maxX;
    if (cb.maxY > maxY) maxY = cb.maxY;
  }
  return { minX, maxX, maxY };
}

export function DecisionTreeComponent({ props }: { props: DecisionTreeChartProps }) {
  const theme = useNivoTheme();
  const { chart } = useThemeConfig();
  const themeColors = useChartColors();

  const nodeW = props.node_width ?? 140;
  const nodeH = props.node_height ?? 50;
  const hGap = 20;
  const vGap = 40;

  const textFill = (theme.text?.fill as string) ?? "#374151";

  const root = useMemo(
    () =>
      props.tree
        ? layoutTree(props.tree as unknown as TreeNode, nodeW, nodeH, hGap, vGap, 0)
        : null,
    [props.tree, nodeW, nodeH]
  );

  if (!root) return <div style={{ height: chart.height }} />;

  const bounds = getTreeBounds(root);
  const padding = 20;
  const svgW = bounds.maxX - bounds.minX + padding * 2;
  const svgH = bounds.maxY + padding * 2;
  const offsetX = -bounds.minX + padding;
  const offsetY = padding;

  function renderNode(ln: LayoutNode, colorIdx: number): React.ReactNode {
    const fillColor = ln.node.color
      ? resolveColor(ln.node.color)
      : themeColors[colorIdx % themeColors.length] + "30";
    const strokeColor = ln.node.color
      ? resolveColor(ln.node.color)
      : themeColors[colorIdx % themeColors.length];

    return (
      <g key={`${ln.x}-${ln.y}-${ln.node.label}`}>
        {/* Edges to children */}
        {ln.children.map((child, ci) => (
          <path
            key={ci}
            d={`M${ln.x + nodeW / 2},${ln.y + nodeH} L${child.x + nodeW / 2},${child.y}`}
            stroke={textFill}
            strokeWidth={1.5}
            fill="none"
            opacity={0.4}
          />
        ))}
        {/* Node rect */}
        <rect
          x={ln.x}
          y={ln.y}
          width={nodeW}
          height={nodeH}
          rx={8}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={1.5}
        />
        {/* Label */}
        <text
          x={ln.x + nodeW / 2}
          y={ln.y + (ln.node.condition ? nodeH / 3 : nodeH / 2)}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={textFill}
          fontSize={11}
          fontWeight={600}
        >
          {ln.node.label.length > 18 ? ln.node.label.slice(0, 16) + "..." : ln.node.label}
        </text>
        {/* Condition or value */}
        {ln.node.condition && (
          <text
            x={ln.x + nodeW / 2}
            y={ln.y + (nodeH * 2) / 3}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={textFill}
            fontSize={9}
            opacity={0.7}
          >
            {ln.node.condition}
          </text>
        )}
        {ln.node.value != null && !ln.node.condition && (
          <text
            x={ln.x + nodeW / 2}
            y={ln.y + (nodeH * 2) / 3}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={textFill}
            fontSize={10}
            opacity={0.8}
          >
            {String(ln.node.value)}
          </text>
        )}
        {/* Recurse children */}
        {ln.children.map((child, ci) => renderNode(child, colorIdx + ci + 1))}
      </g>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
        </h3>
      )}
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ width: "100%", height: Math.max(chart.height, svgH), minWidth: svgW }}
        preserveAspectRatio="xMidYMin meet"
      >
        <g transform={`translate(${offsetX},${offsetY})`}>{renderNode(root, 0)}</g>
      </svg>
    </div>
  );
}
