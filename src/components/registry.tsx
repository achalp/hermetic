"use client";

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
        className="grid [&>*]:min-w-0 [&>*]:overflow-hidden"
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
