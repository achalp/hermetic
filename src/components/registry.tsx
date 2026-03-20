"use client";

import dynamic from "next/dynamic";
import { defineRegistry } from "@json-render/react";
import { catalog } from "@/lib/catalog";
import type { DrillDownParams } from "@/lib/types";
import { drillDownCallbackRef } from "@/lib/drill-down-context";
import {
  StatCardComponent,
  TextBlockComponent,
  AnnotationComponent,
  TrendIndicatorComponent,
  SelectControlComponent,
  NumberInputComponent,
  ToggleSwitchComponent,
} from "./registry-primitives";
import { ChartExpandWrapper } from "./charts/chart-expand-wrapper";
import { ChartSelectionBridge } from "./charts/chart-selection-bridge";
import { ChartImageComponent } from "./charts/chart-image";
import { DataControllerComponent } from "./controllers/data-controller";
import { FormControllerComponent } from "./controllers/form-controller";
import { TextInputComponent } from "./inputs/text-input";
import { TextAreaComponent } from "./inputs/text-area";
import { DataTableComponent } from "./data-table";

// Lazy-load all chart components to avoid compiling heavy deps (nivo, plotly, deck.gl, three.js)
// on initial page load. Each chart is only compiled when first rendered.
const BarChartComponent = dynamic(
  () => import("./charts/bar-chart").then((m) => m.BarChartComponent),
  { ssr: false }
);
const LineChartComponent = dynamic(
  () => import("./charts/line-chart").then((m) => m.LineChartComponent),
  { ssr: false }
);
const AreaChartComponent = dynamic(
  () => import("./charts/area-chart").then((m) => m.AreaChartComponent),
  { ssr: false }
);
const PieChartComponent = dynamic(
  () => import("./charts/pie-chart").then((m) => m.PieChartComponent),
  { ssr: false }
);
const ScatterChartComponent = dynamic(
  () => import("./charts/scatter-chart").then((m) => m.ScatterChartComponent),
  { ssr: false }
);
const MapViewComponent = dynamic(
  () => import("./charts/map-view").then((m) => m.MapViewComponent),
  { ssr: false }
);
const HistogramChartComponent = dynamic(
  () => import("./charts/histogram-chart").then((m) => m.HistogramChartComponent),
  { ssr: false }
);
const BoxPlotChartComponent = dynamic(
  () => import("./charts/box-plot-chart").then((m) => m.BoxPlotChartComponent),
  { ssr: false }
);
const HeatMapChartComponent = dynamic(
  () => import("./charts/heatmap-chart").then((m) => m.HeatMapChartComponent),
  { ssr: false }
);
const ViolinChartComponent = dynamic(
  () => import("./charts/violin-chart").then((m) => m.ViolinChartComponent),
  { ssr: false }
);
const Scatter3DChartComponent = dynamic(
  () => import("./charts/scatter3d-chart").then((m) => m.Scatter3DChartComponent),
  { ssr: false }
);
const Surface3DChartComponent = dynamic(
  () => import("./charts/surface3d-chart").then((m) => m.Surface3DChartComponent),
  { ssr: false }
);
const Globe3DComponent = dynamic(
  () => import("./charts/globe-view").then((m) => m.Globe3DComponent),
  { ssr: false }
);
const Map3DComponent = dynamic(() => import("./charts/map3d-view").then((m) => m.Map3DComponent), {
  ssr: false,
});
const CandlestickChartComponent = dynamic(
  () => import("./charts/candlestick-chart").then((m) => m.CandlestickChartComponent),
  { ssr: false }
);
const SankeyChartComponent = dynamic(
  () => import("./charts/sankey-chart").then((m) => m.SankeyChartComponent),
  { ssr: false }
);
const TreemapChartComponent = dynamic(
  () => import("./charts/treemap-chart").then((m) => m.TreemapChartComponent),
  { ssr: false }
);
const RadarChartComponent = dynamic(
  () => import("./charts/radar-chart").then((m) => m.RadarChartComponent),
  { ssr: false }
);
const BumpChartComponent = dynamic(
  () => import("./charts/bump-chart").then((m) => m.BumpChartComponent),
  { ssr: false }
);
const ChordChartComponent = dynamic(
  () => import("./charts/chord-chart").then((m) => m.ChordChartComponent),
  { ssr: false }
);
const SunburstChartComponent = dynamic(
  () => import("./charts/sunburst-chart").then((m) => m.SunburstChartComponent),
  { ssr: false }
);
const MarimekkoChartComponent = dynamic(
  () => import("./charts/marimekko-chart").then((m) => m.MarimekkoChartComponent),
  { ssr: false }
);
const CalendarChartComponent = dynamic(
  () => import("./charts/calendar-chart").then((m) => m.CalendarChartComponent),
  { ssr: false }
);
const StreamChartComponent = dynamic(
  () => import("./charts/stream-chart").then((m) => m.StreamChartComponent),
  { ssr: false }
);
const WaterfallChartComponent = dynamic(
  () => import("./charts/waterfall-chart").then((m) => m.WaterfallChartComponent),
  { ssr: false }
);
const RidgelineChartComponent = dynamic(
  () => import("./charts/ridgeline-chart").then((m) => m.RidgelineChartComponent),
  { ssr: false }
);
const DumbbellChartComponent = dynamic(
  () => import("./charts/dumbbell-chart").then((m) => m.DumbbellChartComponent),
  { ssr: false }
);
const SlopeChartComponent = dynamic(
  () => import("./charts/slope-chart").then((m) => m.SlopeChartComponent),
  { ssr: false }
);
const BeeswarmChartComponent = dynamic(
  () => import("./charts/beeswarm-chart").then((m) => m.BeeswarmChartComponent),
  { ssr: false }
);
const ShapBeeswarmComponent = dynamic(
  () => import("./charts/shap-beeswarm-chart").then((m) => m.ShapBeeswarmComponent),
  { ssr: false }
);
const ConfusionMatrixComponent = dynamic(
  () => import("./charts/confusion-matrix-chart").then((m) => m.ConfusionMatrixComponent),
  { ssr: false }
);
const RocCurveComponent = dynamic(
  () => import("./charts/roc-curve-chart").then((m) => m.RocCurveComponent),
  { ssr: false }
);
const ParallelCoordinatesComponent = dynamic(
  () => import("./charts/parallel-coordinates-chart").then((m) => m.ParallelCoordinatesComponent),
  { ssr: false }
);
const BulletChartComponent = dynamic(
  () => import("./charts/bullet-chart").then((m) => m.BulletChartComponent),
  { ssr: false }
);
const DecisionTreeComponent = dynamic(
  () => import("./charts/decision-tree-chart").then((m) => m.DecisionTreeComponent),
  { ssr: false }
);

const { registry } = defineRegistry(catalog, {
  components: {
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
