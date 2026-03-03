"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface RocCurveProps {
  title: string | null;
  curves: { label: string; fpr: number[]; tpr: number[]; auc: number | null }[];
  curve_type: "roc" | "pr" | null;
  color_map: Record<string, string> | null;
  show_diagonal: boolean | null;
}

export function RocCurveComponent({ props }: { props: RocCurveProps }) {
  const { chart } = useThemeConfig();
  const curves = Array.isArray(props.curves) ? props.curves : [];
  const labels = curves.map((c) => c.label);
  const colors = useColorMap(labels, props.color_map);

  if (curves.length === 0) return <div style={{ height: chart.height }} />;

  const isROC = (props.curve_type ?? "roc") === "roc";

  const traces: Data[] = curves.map((curve, i) => ({
    type: "scatter" as const,
    x: curve.fpr,
    y: curve.tpr,
    mode: "lines" as const,
    name: curve.auc != null ? `${curve.label} (AUC=${curve.auc.toFixed(3)})` : curve.label,
    line: { color: colors[i], width: 2 },
    fill: "tozeroy" as const,
    fillcolor: colors[i] + "20",
  }));

  // Diagonal reference line for ROC
  if (isROC && (props.show_diagonal ?? true)) {
    traces.push({
      type: "scatter" as const,
      x: [0, 1],
      y: [0, 1],
      mode: "lines" as const,
      name: "Random",
      line: { color: "#9ca3af", width: 1, dash: "dash" },
      showlegend: false,
    });
  }

  const layout: Partial<Layout> = {
    xaxis: {
      title: { text: isROC ? "False Positive Rate" : "Recall" },
      range: [0, 1],
    },
    yaxis: {
      title: { text: isROC ? "True Positive Rate" : "Precision" },
      range: [0, 1.05],
    },
    showlegend: true,
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
      <PlotlyChart data={traces} layout={layout} height={chart.height} />
    </div>
  );
}
