"use client";

import { defineRegistry, useBoundProp } from "@json-render/react";
import { catalog } from "@/lib/catalog";
import type { DrillDownParams } from "@/lib/types";
import { drillDownCallbackRef } from "@/lib/drill-down-context";
import { useThemeConfig } from "@/lib/theme-config";
import { BarChartComponent } from "./charts/bar-chart";
import { LineChartComponent } from "./charts/line-chart";
import { AreaChartComponent } from "./charts/area-chart";
import { PieChartComponent } from "./charts/pie-chart";
import { ScatterChartComponent } from "./charts/scatter-chart";
import { MapViewComponent } from "./charts/map-view";
import { ChartImageComponent } from "./charts/chart-image";
import { HistogramChartComponent } from "./charts/histogram-chart";
import { BoxPlotChartComponent } from "./charts/box-plot-chart";
import { HeatMapChartComponent } from "./charts/heatmap-chart";
import { ViolinChartComponent } from "./charts/violin-chart";
import { Scatter3DChartComponent } from "./charts/scatter3d-chart";
import { Surface3DChartComponent } from "./charts/surface3d-chart";
import { Globe3DComponent } from "./charts/globe-view";
import { Map3DComponent } from "./charts/map3d-view";
import { CandlestickChartComponent } from "./charts/candlestick-chart";
import { SankeyChartComponent } from "./charts/sankey-chart";
import { TreemapChartComponent } from "./charts/treemap-chart";
import { RadarChartComponent } from "./charts/radar-chart";
import { BumpChartComponent } from "./charts/bump-chart";
import { ChordChartComponent } from "./charts/chord-chart";
import { SunburstChartComponent } from "./charts/sunburst-chart";
import { MarimekkoChartComponent } from "./charts/marimekko-chart";
import { CalendarChartComponent } from "./charts/calendar-chart";
import { StreamChartComponent } from "./charts/stream-chart";
import { WaterfallChartComponent } from "./charts/waterfall-chart";
import { RidgelineChartComponent } from "./charts/ridgeline-chart";
import { DumbbellChartComponent } from "./charts/dumbbell-chart";
import { SlopeChartComponent } from "./charts/slope-chart";
import { BeeswarmChartComponent } from "./charts/beeswarm-chart";
import { ShapBeeswarmComponent } from "./charts/shap-beeswarm-chart";
import { ConfusionMatrixComponent } from "./charts/confusion-matrix-chart";
import { RocCurveComponent } from "./charts/roc-curve-chart";
import { ParallelCoordinatesComponent } from "./charts/parallel-coordinates-chart";
import { BulletChartComponent } from "./charts/bullet-chart";
import { DecisionTreeComponent } from "./charts/decision-tree-chart";
import { ChartExpandWrapper } from "./charts/chart-expand-wrapper";
import { ChartSelectionBridge } from "./charts/chart-selection-bridge";
import { DataControllerComponent } from "./controllers/data-controller";
import { FormControllerComponent } from "./controllers/form-controller";
import { TextInputComponent } from "./inputs/text-input";
import { TextAreaComponent } from "./inputs/text-area";
import { DataTableComponent } from "./data-table";

const SEVERITY_STYLES = {
  info: "border-info-border bg-info-bg text-info-text",
  warning: "border-warning-border bg-warning-bg text-warning-text",
  success: "border-success-border bg-success-bg text-success-text",
  error: "border-error-border bg-error-bg text-error-text",
};

const ICON_MAP: Record<string, string> = {
  alert: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
  trend: "\uD83D\uDCC8",
  check: "\u2705",
  flag: "\uD83D\uDEA9",
};

const TREND_STYLES = {
  up: "text-trend-up",
  down: "text-trend-down",
  flat: "text-t-tertiary",
};

const TREND_ARROWS = { up: "\u2191", down: "\u2193", flat: "\u2192" };

function formatStatNumber(num: number, prefix = ""): string {
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return prefix + (num / 1_000_000_000).toFixed(1) + "B";
  if (abs >= 1_000_000) return prefix + (num / 1_000_000).toFixed(1) + "M";
  if (Number.isInteger(num)) return prefix + num.toLocaleString();
  return prefix + num.toFixed(2);
}

function formatStatValue(v: unknown): string {
  if (typeof v === "number") return formatStatNumber(v);
  // Handle pre-formatted strings like "$362,034" or "362,034"
  if (typeof v === "string") {
    const prefix = v.match(/^[$€£¥]/)?.[0] ?? "";
    const stripped = v.replace(/[$€£¥,%\s]/g, "");
    const num = Number(stripped);
    if (!isNaN(num) && stripped.length > 0) {
      const suffix = v.endsWith("%") ? "%" : "";
      return formatStatNumber(num, prefix) + suffix;
    }
  }
  return String(v ?? "");
}

const { registry } = defineRegistry(catalog, {
  components: {
    LayoutRow: ({ props, children }) => (
      <div
        className="flex flex-wrap items-stretch"
        style={{
          gap: props.gap ? `${props.gap}px` : "var(--gap-section)",
          alignItems: props.align ?? "stretch",
        }}
      >
        {children}
      </div>
    ),
    LayoutColumn: ({ props, children }) => (
      <div
        className="flex flex-col"
        style={{ gap: props.gap ? `${props.gap}px` : "var(--gap-section)" }}
      >
        {children}
      </div>
    ),
    LayoutGrid: ({ props, children }) => (
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))`,
          gap: props.gap ? `${props.gap}px` : "var(--gap-section)",
        }}
      >
        {children}
      </div>
    ),
    StatCard: ({ props }) => {
      const config = useThemeConfig();
      const { statCard } = config;
      const displayValue = formatStatValue(props.value);
      const fontSize = statCard.valueClass;
      return (
        <div
          className={`stat-card theme-card min-w-0 overflow-hidden bg-surface-2 ${statCard.align === "left" ? "text-left" : "text-center"}`}
          style={{
            padding: "var(--padding-card)",
            borderRadius: "var(--radius-card)",
            border: "var(--surface-card-border)",
            boxShadow: "var(--shadow-card)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          <p
            className="truncate text-xs text-t-secondary"
            style={{
              fontWeight: statCard.labelWeight,
              textTransform: statCard.labelTransform,
              letterSpacing: statCard.labelTracking,
            }}
          >
            {props.label}
          </p>
          <p
            className={`mt-1 tabular-nums text-t-primary ${fontSize}`}
            style={{ fontWeight: "var(--stat-value-weight)" as unknown as number }}
            title={displayValue}
          >
            {displayValue}
          </p>
          {(props.change || props.trend) && (
            <p className={`mt-1 text-sm font-medium ${TREND_STYLES[props.trend ?? "flat"]}`}>
              {props.trend && TREND_ARROWS[props.trend]} {props.change}
            </p>
          )}
          {props.description && <p className="mt-1 text-xs text-t-tertiary">{props.description}</p>}
        </div>
      );
    },
    TextBlock: ({ props }) => {
      const config = useThemeConfig();
      const variant = props.variant ?? "body";
      const isInsight = variant === "insight";
      const insightBase = isInsight
        ? config.insight.borderSide === "left"
          ? "text-accent-text border-l-4 border-accent pl-4"
          : config.insight.borderSide === "top"
            ? "text-accent-text"
            : "text-accent-text"
        : "";
      const bgTint = isInsight && config.insight.bgTint ? " bg-accent-subtle" : "";
      const styles: Record<string, string> = {
        body: "text-t-secondary",
        insight: `insight-block ${insightBase}${bgTint}`,
        warning: "text-warning-text border-l-4 border-warning-border pl-4",
        heading: "text-xl text-t-primary",
      };
      return (
        <div
          className={styles[variant]}
          style={variant === "heading" ? { fontWeight: "var(--font-heading-weight)" } : undefined}
        >
          <p className="whitespace-pre-wrap">{props.content}</p>
        </div>
      );
    },
    DataTable: ({ props }) => <DataTableComponent props={props} />,
    BarChart: ({ props, emit, on }) => {
      const inner = (sel?: { selectedValue: string | null; onSelect: (v: string) => void }) => (
        <ChartExpandWrapper title={props.title}>
          <BarChartComponent
            props={props}
            emit={emit}
            on={on}
            selectedValue={sel?.selectedValue ?? null}
            onSelect={sel?.onSelect}
          />
        </ChartExpandWrapper>
      );
      return props.selects ? (
        <ChartSelectionBridge selects={props.selects}>{(ctx) => inner(ctx)}</ChartSelectionBridge>
      ) : (
        inner()
      );
    },
    LineChart: ({ props, emit, on }) => (
      <ChartExpandWrapper title={props.title}>
        <LineChartComponent props={props} emit={emit} on={on} />
      </ChartExpandWrapper>
    ),
    AreaChart: ({ props, emit, on }) => (
      <ChartExpandWrapper title={props.title}>
        <AreaChartComponent props={props} emit={emit} on={on} />
      </ChartExpandWrapper>
    ),
    PieChart: ({ props, emit, on }) => {
      const inner = (sel?: { selectedValue: string | null; onSelect: (v: string) => void }) => (
        <ChartExpandWrapper title={props.title}>
          <PieChartComponent
            props={props}
            emit={emit}
            on={on}
            selectedValue={sel?.selectedValue ?? null}
            onSelect={sel?.onSelect}
          />
        </ChartExpandWrapper>
      );
      return props.selects ? (
        <ChartSelectionBridge selects={props.selects}>{(ctx) => inner(ctx)}</ChartSelectionBridge>
      ) : (
        inner()
      );
    },
    ScatterChart: ({ props, emit, on }) => (
      <ChartExpandWrapper title={props.title}>
        <ScatterChartComponent props={props} emit={emit} on={on} />
      </ChartExpandWrapper>
    ),
    MapView: ({ props, emit, on }) => (
      <ChartExpandWrapper title={props.title}>
        <MapViewComponent props={props} emit={emit} on={on} />
      </ChartExpandWrapper>
    ),
    Histogram: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <HistogramChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    BoxPlot: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <BoxPlotChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    HeatMap: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <HeatMapChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    ViolinChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ViolinChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    Scatter3D: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <Scatter3DChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    Surface3D: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <Surface3DChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    Globe3D: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <Globe3DComponent props={props} />
      </ChartExpandWrapper>
    ),
    Map3D: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <Map3DComponent props={props} />
      </ChartExpandWrapper>
    ),
    CandlestickChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <CandlestickChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    SankeyChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <SankeyChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    TreemapChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <TreemapChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    RadarChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <RadarChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    BumpChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <BumpChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    ChordChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ChordChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    SunburstChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <SunburstChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    MarimekkoChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <MarimekkoChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    CalendarChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <CalendarChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    StreamChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <StreamChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    WaterfallChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <WaterfallChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    RidgelineChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <RidgelineChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    DumbbellChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <DumbbellChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    SlopeChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <SlopeChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    BeeswarmChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <BeeswarmChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    ShapBeeswarm: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ShapBeeswarmComponent props={props} />
      </ChartExpandWrapper>
    ),
    ConfusionMatrix: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ConfusionMatrixComponent props={props} />
      </ChartExpandWrapper>
    ),
    RocCurve: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <RocCurveComponent props={props} />
      </ChartExpandWrapper>
    ),
    ParallelCoordinates: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ParallelCoordinatesComponent props={props} />
      </ChartExpandWrapper>
    ),
    BulletChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <BulletChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    DecisionTree: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <DecisionTreeComponent props={props} />
      </ChartExpandWrapper>
    ),
    Annotation: ({ props }) => {
      const config = useThemeConfig();
      const severity = props.severity ?? "info";
      const baseStyles = SEVERITY_STYLES[severity];
      const bgClass = config.annotation.bgFill ? baseStyles : baseStyles.replace(/bg-\S+/g, "");
      return (
        <div
          className={`annotation-block border ${bgClass}`}
          style={{
            borderRadius: "var(--radius-card)",
            borderWidth: config.annotation.borderWidth,
            padding: "var(--padding-card)",
          }}
        >
          <div className="flex items-start gap-2">
            <span className="text-lg">{ICON_MAP[props.icon ?? "info"]}</span>
            <div>
              <p className="font-semibold">{props.title}</p>
              <p className="mt-1 text-sm opacity-90">{props.content}</p>
            </div>
          </div>
        </div>
      );
    },
    TrendIndicator: ({ props }) => {
      const current = props.current ?? 0;
      const previous = props.previous ?? 0;
      const change = current - previous;
      const pctChange = previous !== 0 ? (change / previous) * 100 : 0;
      const trend = change > 0 ? "up" : change < 0 ? "down" : "flat";
      const precision = props.precision ?? 1;

      const formatValue = (v: number) => {
        switch (props.format) {
          case "currency":
            return `$${v.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
          case "percent":
            return `${v.toFixed(precision)}%`;
          default:
            return v.toLocaleString(undefined, {
              minimumFractionDigits: precision,
              maximumFractionDigits: precision,
            });
        }
      };

      return (
        <div
          className="theme-card flex items-center gap-3 border border-border-default bg-surface-2"
          style={{
            padding: "var(--padding-card)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <div>
            <p className="text-sm text-t-secondary">{props.label}</p>
            <p className="text-lg font-bold text-t-primary">{formatValue(current)}</p>
          </div>
          <div className={`text-sm font-medium ${TREND_STYLES[trend]}`}>
            {TREND_ARROWS[trend]} {pctChange >= 0 ? "+" : ""}
            {pctChange.toFixed(1)}%
          </div>
        </div>
      );
    },
    ChartImage: ({ props }) => <ChartImageComponent props={props} />,
    SelectControl: ({ props, bindings }) => {
      const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
      return (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-t-secondary">{props.label}</label>
          <select
            value={value ?? ""}
            onChange={(e) => setValue(e.target.value)}
            className="theme-input border border-border-default bg-surface-input px-3 py-2 text-sm text-t-primary outline-none transition-colors focus:border-accent"
            style={{
              borderRadius: "var(--radius-input)",
              boxShadow: "var(--ring-focus)",
              transitionDuration: "var(--transition-speed)",
            }}
            onFocus={(e) => (e.currentTarget.style.boxShadow = "var(--ring-focus)")}
            onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
          >
            {props.placeholder && <option value="">{props.placeholder}</option>}
            {props.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );
    },
    NumberInput: ({ props, bindings }) => {
      const [value, setValue] = useBoundProp<number>(props.value, bindings?.value);
      return (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-t-secondary">{props.label}</label>
          <input
            type="number"
            value={value ?? 0}
            min={props.min ?? undefined}
            max={props.max ?? undefined}
            step={props.step ?? undefined}
            onChange={(e) => setValue(parseFloat(e.target.value))}
            className="theme-input border border-border-default bg-surface-input px-3 py-2 text-sm text-t-primary outline-none transition-colors focus:border-accent"
            style={{
              borderRadius: "var(--radius-input)",
              transitionDuration: "var(--transition-speed)",
            }}
            onFocus={(e) => (e.currentTarget.style.boxShadow = "var(--ring-focus)")}
            onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
          />
        </div>
      );
    },
    ToggleSwitch: ({ props, bindings }) => {
      const [checked, setChecked] = useBoundProp<boolean>(props.checked, bindings?.checked);
      const isChecked = checked ?? false;
      return (
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-t-secondary">{props.label}</label>
          <button
            type="button"
            role="switch"
            aria-checked={isChecked}
            onClick={() => setChecked(!isChecked)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              isChecked ? "bg-accent" : "bg-surface-2"
            }`}
            style={{ boxShadow: "var(--ring-focus)" }}
            onFocus={(e) => (e.currentTarget.style.boxShadow = "var(--ring-focus)")}
            onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                isChecked ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      );
    },
    DataController: ({ props, children }) => (
      <DataControllerComponent props={props}>{children}</DataControllerComponent>
    ),
    FormController: ({ props, children }) => (
      <FormControllerComponent props={props}>{children}</FormControllerComponent>
    ),
    TextInput: ({ props, bindings }) => <TextInputComponent props={props} bindings={bindings} />,
    TextArea: ({ props, bindings }) => <TextAreaComponent props={props} bindings={bindings} />,
  },
  actions: {
    drillDown: async (params) => {
      if (params && drillDownCallbackRef.current) {
        drillDownCallbackRef.current(params as DrillDownParams);
      }
    },
  },
});

export { registry };
