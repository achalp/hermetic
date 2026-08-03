"use client";

import dynamic from "next/dynamic";
import { defineRegistry, type Components } from "@json-render/react";
import { catalog } from "@/lib/catalog";
import type { DrillDownParams } from "@/lib/contracts/spec-types";
import {
  StatCardComponent,
  TextBlockComponent,
  SectionBreakComponent,
  AnnotationComponent,
  TrendIndicatorComponent,
  SelectControlComponent,
  NumberInputComponent,
  ToggleSwitchComponent,
} from "./registry-primitives";
import { ChartExpandWrapper } from "./charts/chart-expand-wrapper";
import { ChartSelectionBridge } from "./charts/chart-selection-bridge";
import { PivotSelectionBridge } from "./charts/pivot-selection-bridge";
import { ChartImageComponent } from "./charts/chart-image";
import { DataControllerComponent } from "./controllers/data-controller";
import { FormControllerComponent } from "./controllers/form-controller";
import { TextInputComponent } from "./inputs/text-input";
import { TextAreaComponent } from "./inputs/text-area";
import { DatePickerComponent } from "./inputs/date-picker";
import { SliderComponent } from "./inputs/slider";
import { ColorPickerComponent } from "./inputs/color-picker";
import { MultiSelectComponent } from "./inputs/multi-select";
import { RangeSliderComponent } from "./inputs/range-slider";
import { DataTableComponent } from "./data-table";
import { DefinitionListComponent } from "./definition-list";
import { PivotTableComponent } from "./pivot-table";
import { RendererErrorBoundary } from "./app/renderer-error-boundary";
import { memo } from "react";
import type { ReactNode, ComponentType } from "react";

/**
 * Compact inline fallback for a single failed component. The top-level
 * RendererErrorBoundary replaces the WHOLE dashboard on a crash; this keeps the
 * blast radius to the one widget that threw, and names its type so the culprit
 * is obvious instead of a white screen.
 */
function componentFallback(type: string): ReactNode {
  return (
    <div
      className="flex min-h-[80px] items-center justify-center border border-error-border bg-error-bg p-3 text-center text-xs text-error-text opacity-80"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      Couldn’t render this {type}.
    </div>
  );
}

/**
 * Wrap every registry component in its own error boundary so a crash in one
 * chart (a malformed prop, an unexpected data shape from the composer) degrades
 * to a placeholder tile instead of taking the entire dashboard down with it.
 */
function wrapAll(components: Components<typeof catalog>): Components<typeof catalog> {
  // Typed loosely inside (the per-key ComponentFn generics aren't worth
  // threading); the param/return type keeps the call-site literal correctly
  // typed by the catalog.
  const src = components as unknown as Record<string, (ctx: unknown) => ReactNode>;
  const wrapped: Record<string, (ctx: unknown) => ReactNode> = {};
  for (const key of Object.keys(src)) {
    const render = src[key];
    wrapped[key] = (ctx) => (
      <RendererErrorBoundary fallback={componentFallback(key)}>{render(ctx)}</RendererErrorBoundary>
    );
  }
  return wrapped as unknown as Components<typeof catalog>;
}

// Lazy-load all chart components to avoid compiling heavy deps (nivo, plotly, deck.gl, three.js)
// on initial page load. Each chart is only compiled when first rendered.
//
// lazyChart = dynamic() + React.memo with a value comparator. During
// streaming, useUIStream replaces the spec on EVERY patch and the Renderer
// re-renders the whole tree — without memo, every mounted chart re-ran its
// O(rows) transforms and rebuilt its nivo/plotly tree per patch (the main
// client-side jank on multi-chart dashboards).
//
// Comparator rules:
// - `props` (plain spec JSON) compares by VALUE — the right skip condition.
// - Function props (the Renderer's emit/on handles, selection callbacks) are
//   recreated every render, so identity comparison would defeat the memo;
//   they compare by presence. Their behavior is keyed off data that IS
//   compared (e.g. selectedValues accompanies onSelect), so this is safe.
// - Everything else (selectedValues arrays etc.) compares by reference.
/* eslint-disable @typescript-eslint/no-explicit-any */
function lazyChart(loader: () => Promise<ComponentType<any>>): ComponentType<any> {
  const Dynamic = dynamic(loader, { ssr: false });
  return memo(Dynamic, (prev: any, next: any) => {
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      const a = prev[key];
      const b = next[key];
      if (key === "props") {
        if (JSON.stringify(a) !== JSON.stringify(b)) return false;
      } else if (typeof a === "function" && typeof b === "function") {
        continue;
      } else if (a !== b) {
        return false;
      }
    }
    return true;
  }) as unknown as ComponentType<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const BarChartComponent = lazyChart(() =>
  import("./charts/bar-chart").then((m) => m.BarChartComponent)
);
const LineChartComponent = lazyChart(() =>
  import("./charts/line-chart").then((m) => m.LineChartComponent)
);
const AreaChartComponent = lazyChart(() =>
  import("./charts/area-chart").then((m) => m.AreaChartComponent)
);
const PieChartComponent = lazyChart(() =>
  import("./charts/pie-chart").then((m) => m.PieChartComponent)
);
const ScatterChartComponent = lazyChart(() =>
  import("./charts/scatter-chart").then((m) => m.ScatterChartComponent)
);
const MapViewComponent = lazyChart(() =>
  import("./charts/map-view").then((m) => m.MapViewComponent)
);
const HistogramChartComponent = lazyChart(() =>
  import("./charts/histogram-chart").then((m) => m.HistogramChartComponent)
);
const BoxPlotChartComponent = lazyChart(() =>
  import("./charts/box-plot-chart").then((m) => m.BoxPlotChartComponent)
);
const HeatMapChartComponent = lazyChart(() =>
  import("./charts/heatmap-chart").then((m) => m.HeatMapChartComponent)
);
const ViolinChartComponent = lazyChart(() =>
  import("./charts/violin-chart").then((m) => m.ViolinChartComponent)
);
const Scatter3DChartComponent = lazyChart(() =>
  import("./charts/scatter3d-chart").then((m) => m.Scatter3DChartComponent)
);
const Surface3DChartComponent = lazyChart(() =>
  import("./charts/surface3d-chart").then((m) => m.Surface3DChartComponent)
);
const Globe3DComponent = lazyChart(() =>
  import("./charts/globe-view").then((m) => m.Globe3DComponent)
);
const Map3DComponent = dynamic(() => import("./charts/map3d-view").then((m) => m.Map3DComponent), {
  ssr: false,
});
const CandlestickChartComponent = lazyChart(() =>
  import("./charts/candlestick-chart").then((m) => m.CandlestickChartComponent)
);
const SankeyChartComponent = lazyChart(() =>
  import("./charts/sankey-chart").then((m) => m.SankeyChartComponent)
);
const TreemapChartComponent = lazyChart(() =>
  import("./charts/treemap-chart").then((m) => m.TreemapChartComponent)
);
const RadarChartComponent = lazyChart(() =>
  import("./charts/radar-chart").then((m) => m.RadarChartComponent)
);
const BumpChartComponent = lazyChart(() =>
  import("./charts/bump-chart").then((m) => m.BumpChartComponent)
);
const ChordChartComponent = lazyChart(() =>
  import("./charts/chord-chart").then((m) => m.ChordChartComponent)
);
const SunburstChartComponent = lazyChart(() =>
  import("./charts/sunburst-chart").then((m) => m.SunburstChartComponent)
);
const MarimekkoChartComponent = lazyChart(() =>
  import("./charts/marimekko-chart").then((m) => m.MarimekkoChartComponent)
);
const CalendarChartComponent = lazyChart(() =>
  import("./charts/calendar-chart").then((m) => m.CalendarChartComponent)
);
const StreamChartComponent = lazyChart(() =>
  import("./charts/stream-chart").then((m) => m.StreamChartComponent)
);
const WaterfallChartComponent = lazyChart(() =>
  import("./charts/waterfall-chart").then((m) => m.WaterfallChartComponent)
);
const RidgelineChartComponent = lazyChart(() =>
  import("./charts/ridgeline-chart").then((m) => m.RidgelineChartComponent)
);
const DumbbellChartComponent = lazyChart(() =>
  import("./charts/dumbbell-chart").then((m) => m.DumbbellChartComponent)
);
const SlopeChartComponent = lazyChart(() =>
  import("./charts/slope-chart").then((m) => m.SlopeChartComponent)
);
const BeeswarmChartComponent = lazyChart(() =>
  import("./charts/beeswarm-chart").then((m) => m.BeeswarmChartComponent)
);
const ShapBeeswarmComponent = lazyChart(() =>
  import("./charts/shap-beeswarm-chart").then((m) => m.ShapBeeswarmComponent)
);
const ConfusionMatrixComponent = lazyChart(() =>
  import("./charts/confusion-matrix-chart").then((m) => m.ConfusionMatrixComponent)
);
const RocCurveComponent = lazyChart(() =>
  import("./charts/roc-curve-chart").then((m) => m.RocCurveComponent)
);
const ParallelCoordinatesComponent = lazyChart(() =>
  import("./charts/parallel-coordinates-chart").then((m) => m.ParallelCoordinatesComponent)
);
const BulletChartComponent = lazyChart(() =>
  import("./charts/bullet-chart").then((m) => m.BulletChartComponent)
);
const DecisionTreeComponent = lazyChart(() =>
  import("./charts/decision-tree-chart").then((m) => m.DecisionTreeComponent)
);
const ErrorBarChartComponent = lazyChart(() =>
  import("./charts/error-bar-chart").then((m) => m.ErrorBarChartComponent)
);
const DualAxisChartComponent = lazyChart(() =>
  import("./charts/dual-axis-chart").then((m) => m.DualAxisChartComponent)
);
const FunnelChartComponent = lazyChart(() =>
  import("./charts/funnel-chart").then((m) => m.FunnelChartComponent)
);
const GaugeChartComponent = lazyChart(() =>
  import("./charts/gauge-chart").then((m) => m.GaugeChartComponent)
);
const SparklineComponent = lazyChart(() =>
  import("./charts/sparkline-chart").then((m) => m.SparklineComponent)
);
const ParetoChartComponent = lazyChart(() =>
  import("./charts/pareto-chart").then((m) => m.ParetoChartComponent)
);
const QQChartComponent = lazyChart(() =>
  import("./charts/qq-chart").then((m) => m.QQChartComponent)
);
const ECDFChartComponent = lazyChart(() =>
  import("./charts/ecdf-chart").then((m) => m.ECDFChartComponent)
);
const SurvivalChartComponent = lazyChart(() =>
  import("./charts/survival-chart").then((m) => m.SurvivalChartComponent)
);
const ForestPlotComponent = lazyChart(() =>
  import("./charts/forest-plot-chart").then((m) => m.ForestPlotComponent)
);
const ControlChartComponent = lazyChart(() =>
  import("./charts/control-chart").then((m) => m.ControlChartComponent)
);
const CorrelogramComponent = lazyChart(() =>
  import("./charts/correlogram-chart").then((m) => m.CorrelogramComponent)
);
const CalibrationCurveComponent = lazyChart(() =>
  import("./charts/calibration-curve-chart").then((m) => m.CalibrationCurveComponent)
);
const LiftChartComponent = lazyChart(() =>
  import("./charts/lift-chart").then((m) => m.LiftChartComponent)
);
const PartialDependenceComponent = lazyChart(() =>
  import("./charts/partial-dependence-chart").then((m) => m.PartialDependenceComponent)
);
const DendrogramComponent = lazyChart(() =>
  import("./charts/dendrogram-chart").then((m) => m.DendrogramComponent)
);
const SilhouetteComponent = lazyChart(() =>
  import("./charts/silhouette-chart").then((m) => m.SilhouetteComponent)
);
const NetworkGraphComponent = lazyChart(() =>
  import("./charts/network-graph-chart").then((m) => m.NetworkGraphComponent)
);
const ContourChartComponent = lazyChart(() =>
  import("./charts/contour-chart").then((m) => m.ContourChartComponent)
);
const TernaryChartComponent = lazyChart(() =>
  import("./charts/ternary-chart").then((m) => m.TernaryChartComponent)
);
const PopulationPyramidComponent = lazyChart(() =>
  import("./charts/population-pyramid-chart").then((m) => m.PopulationPyramidComponent)
);
const GanttChartComponent = lazyChart(() =>
  import("./charts/gantt-chart").then((m) => m.GanttChartComponent)
);
const CohortGridComponent = lazyChart(() =>
  import("./charts/cohort-grid-chart").then((m) => m.CohortGridComponent)
);
const QuiverChartComponent = lazyChart(() =>
  import("./charts/quiver-chart").then((m) => m.QuiverChartComponent)
);
const WindRoseComponent = lazyChart(() =>
  import("./charts/wind-rose-chart").then((m) => m.WindRoseComponent)
);

const { registry, handlers: createRegistryHandlers } = defineRegistry(catalog, {
  components: wrapAll({
    LayoutRow: ({ props, children }) => (
      <div
        className="flex flex-wrap items-stretch [&>*]:flex-1 [&>*]:min-w-[320px]"
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
        className="grid [&>*]:min-w-0"
        style={{
          gridTemplateColumns: `repeat(${props.columns ?? 2}, minmax(0, 1fr))`,
          gap: props.gap ? `${props.gap}px` : "var(--gap-section)",
        }}
      >
        {children}
      </div>
    ),
    StatCard: ({ props }) => <StatCardComponent props={props} />,
    TextBlock: ({ props }) => <TextBlockComponent props={props} />,
    SectionBreak: ({ props }) => <SectionBreakComponent props={props} />,
    DataTable: ({ props }) => <DataTableComponent props={props} />,
    DefinitionList: ({ props }) => <DefinitionListComponent props={props} />,
    PivotTable: ({ props, emit, on }) => (
      <PivotSelectionBridge
        selectsRow={props.selectsRow ?? null}
        selectsCol={props.selectsCol ?? null}
      >
        {(ctx) => (
          <PivotTableComponent
            props={props}
            emit={emit}
            on={on}
            selectedRow={ctx.selectedRow}
            selectedCol={ctx.selectedCol}
            onSelectRow={ctx.onSelectRow}
            onSelectCol={ctx.onSelectCol}
          />
        )}
      </PivotSelectionBridge>
    ),
    BarChart: ({ props, emit, on }) => {
      const inner = (sel?: { selectedValues: string[]; onSelect: (v: string) => void }) => (
        <ChartExpandWrapper title={props.title}>
          <BarChartComponent
            props={props}
            emit={emit}
            on={on}
            selectedValues={sel?.selectedValues ?? []}
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
      const inner = (sel?: { selectedValues: string[]; onSelect: (v: string) => void }) => (
        <ChartExpandWrapper title={props.title}>
          <PieChartComponent
            props={props}
            emit={emit}
            on={on}
            selectedValues={sel?.selectedValues ?? []}
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
    ErrorBarChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ErrorBarChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    DualAxisChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <DualAxisChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    FunnelChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <FunnelChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    GaugeChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <GaugeChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    Sparkline: ({ props }) => <SparklineComponent props={props} />,
    ParetoChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ParetoChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    QQPlot: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <QQChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    ECDFChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ECDFChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    SurvivalChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <SurvivalChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    ForestPlot: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ForestPlotComponent props={props} />
      </ChartExpandWrapper>
    ),
    ControlChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ControlChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    Correlogram: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <CorrelogramComponent props={props} />
      </ChartExpandWrapper>
    ),
    CalibrationCurve: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <CalibrationCurveComponent props={props} />
      </ChartExpandWrapper>
    ),
    LiftChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <LiftChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    PartialDependence: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <PartialDependenceComponent props={props} />
      </ChartExpandWrapper>
    ),
    Dendrogram: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <DendrogramComponent props={props} />
      </ChartExpandWrapper>
    ),
    SilhouettePlot: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <SilhouetteComponent props={props} />
      </ChartExpandWrapper>
    ),
    NetworkGraph: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <NetworkGraphComponent props={props} />
      </ChartExpandWrapper>
    ),
    ContourChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <ContourChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    TernaryChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <TernaryChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    PopulationPyramid: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <PopulationPyramidComponent props={props} />
      </ChartExpandWrapper>
    ),
    GanttChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <GanttChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    CohortGrid: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <CohortGridComponent props={props} />
      </ChartExpandWrapper>
    ),
    QuiverChart: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <QuiverChartComponent props={props} />
      </ChartExpandWrapper>
    ),
    WindRose: ({ props }) => (
      <ChartExpandWrapper title={props.title}>
        <WindRoseComponent props={props} />
      </ChartExpandWrapper>
    ),
    Annotation: ({ props }) => <AnnotationComponent props={props} />,
    TrendIndicator: ({ props }) => <TrendIndicatorComponent props={props} />,
    ChartImage: ({ props }) => <ChartImageComponent props={props} />,
    SelectControl: ({ props, bindings }) => (
      <SelectControlComponent props={props} bindings={bindings} />
    ),
    NumberInput: ({ props, bindings }) => (
      <NumberInputComponent props={props} bindings={bindings} />
    ),
    ToggleSwitch: ({ props, bindings }) => (
      <ToggleSwitchComponent props={props} bindings={bindings} />
    ),
    DataController: ({ props, children }) => (
      <DataControllerComponent props={props}>{children}</DataControllerComponent>
    ),
    FormController: ({ props, children }) => (
      <FormControllerComponent props={props}>{children}</FormControllerComponent>
    ),
    TextInput: ({ props, bindings }) => <TextInputComponent props={props} bindings={bindings} />,
    TextArea: ({ props, bindings }) => <TextAreaComponent props={props} bindings={bindings} />,
    DatePicker: ({ props, bindings }) => <DatePickerComponent props={props} bindings={bindings} />,
    Slider: ({ props, bindings }) => <SliderComponent props={props} bindings={bindings} />,
    ColorPicker: ({ props, bindings }) => (
      <ColorPickerComponent props={props} bindings={bindings} />
    ),
    MultiSelect: ({ props, bindings }) => (
      <MultiSelectComponent props={props} bindings={bindings} />
    ),
    RangeSlider: ({ props, bindings }) => (
      <RangeSliderComponent props={props} bindings={bindings} />
    ),
  }),
  actions: {
    drillDown: async (params) => {
      if (params && activeDrillDispatch.current) {
        activeDrillDispatch.current(params as DrillDownParams);
      }
    },
  },
});

/**
 * The drill dispatch the generated drillDown action forwards to. The registry
 * table is a module-level singleton (defineRegistry runs once), so the action
 * closure can't be per-SpecView — instead SpecView points this slot at ITS
 * dispatch while rendering its subtree via makeRegistryActionHandlers. The
 * slot is written by the ActionProvider handler wrapper at dispatch time (the
 * wrapper knows which SpecView's handler ran), so concurrent panels stay
 * correctly routed.
 */
const activeDrillDispatch: { current: ((p: DrillDownParams) => void) | null } = {
  current: null,
};

/**
 * Build ActionProvider handlers wired to a specific SpecView's dispatch
 * (modularization M5-5b — replaces the module-level drillDownCallbackRef).
 * json-render's generated handlers take no extra context, so each handler is
 * wrapped to point the module slot at THIS SpecView's dispatch for exactly
 * the (synchronous) dispatch window — concurrent panels stay correctly
 * routed because the action body reads the slot at entry.
 */
export function makeRegistryActionHandlers(
  dispatch: ((params: DrillDownParams) => void) | null
): typeof registryActionHandlers {
  const base = createRegistryHandlers(
    () => () => {},
    () => ({})
  );
  const wrapped = {} as typeof registryActionHandlers;
  for (const [name, fn] of Object.entries(base) as [string, (...a: unknown[]) => unknown][]) {
    (wrapped as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      activeDrillDispatch.current = dispatch;
      try {
        return await fn(...args);
      } finally {
        activeDrillDispatch.current = null;
      }
    };
  }
  return wrapped;
}

/**
 * ActionProvider-compatible handlers for the registry's custom actions
 * (currently `drillDown`). MUST be passed to `<ActionProvider handlers={...}>`
 * or custom actions emitted by charts (e.g. drillDown) won't be registered and
 * clicking a drillable chart silently no-ops.
 *
 * IMPORTANT: json-render's generated handler wraps each action as
 *   async (params) => { const setState = getSetState(); if (setState) await action(params, setState, state); }
 * so `getSetState` MUST return a truthy function or the action is silently
 * skipped (guard fails). drillDown never touches state, so a no-op setState
 * satisfies the guard. This bare export has NO drill dispatch — use
 * makeRegistryActionHandlers (via <SpecView onDrillDown>) to wire drilling.
 */
export const registryActionHandlers = createRegistryHandlers(
  () => () => {},
  () => ({})
);

export { registry };
