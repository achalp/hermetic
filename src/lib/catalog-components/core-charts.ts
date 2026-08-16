/**
 * Component catalog entries — one slice of the former catalog.ts god
 * module (L7). Merged by spread in ../catalog.ts; order is irrelevant.
 */
import { z } from "zod";

export const catalogCoreCharts = {
  BarChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      x_key: z.string(),
      y_keys: z.array(z.string()),
      orientation: z.enum(["vertical", "horizontal"]).nullable(),
      stacked: z.boolean().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
      label_map: z.record(z.string(), z.string()).nullable(),
      selects: z
        .object({
          column: z.string(),
          bindTo: z.string(),
        })
        .nullable(),
    }),
    description:
      "Bar chart for comparing categories. Supports grouped and stacked bars. color_map values can be named colors (indigo, emerald, amber, rose, violet, cyan, orange, pink) or hex codes.",
  },
  LineChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      x_key: z.string(),
      y_keys: z.array(z.string()),
      color_map: z.record(z.string(), z.string()).nullable(),
      label_map: z.record(z.string(), z.string()).nullable(),
      show_dots: z.boolean().nullable(),
      curve: z.enum(["linear", "monotone", "step"]).nullable(),
    }),
    description:
      'Line chart for trends over time. Use label_map to give y_keys human display names in the legend and tooltips (e.g. {"churn_rate_pct": "Churn rate"}) — the reader should never read a column identifier. Each y_key becomes a line. Data should be wide-format: each row has {x_key: value, y_key1: number, y_key2: number, ...}. Pivot long-format data before passing. color_map values can be named colors (indigo, emerald, amber, rose, violet, cyan, orange, pink) or hex codes.',
  },
  AreaChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      x_key: z.string(),
      y_keys: z.array(z.string()),
      color_map: z.record(z.string(), z.string()).nullable(),
      stacked: z.boolean().nullable(),
      opacity: z.number().nullable(),
    }),
    description:
      "Area chart, like line chart with filled regions below lines. Data should be wide-format: each row has {x_key: value, y_key1: number, y_key2: number, ...}. Pivot long-format data before passing. color_map values can be named colors (indigo, emerald, amber, rose, violet, cyan, orange, pink) or hex codes.",
  },
  PieChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.object({ label: z.string(), value: z.number() })),
      show_labels: z.boolean().nullable(),
      show_legend: z.boolean().nullable(),
      donut: z.boolean().nullable(),
      colors: z.array(z.string()).nullable(),
      selects: z
        .object({
          column: z.string(),
          bindTo: z.string(),
        })
        .nullable(),
    }),
    description:
      "Pie/donut chart for showing proportions of a whole. colors array can use named colors (indigo, emerald, amber, rose, violet, cyan, orange, pink) or hex codes.",
  },
  ScatterChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      x_key: z.string().nullable(),
      y_key: z.string().nullable(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      show_regression: z.boolean().nullable(),
      group_key: z.string().nullable(),
    }),
    description:
      'Scatter plot for correlations. Supports regression line overlay. Pass data as records with x_key and y_key to specify which columns map to x/y axes (defaults to "x"/"y"). Use group_key to color by a categorical column.',
  },
  Histogram: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string(),
      group_key: z.string().nullable(),
      nbins: z.number().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
      normalize: z.boolean().nullable(),
    }),
    description:
      "Interactive histogram for showing distributions. Client-side binning via Plotly. Pass raw numeric data rows and value_key. Optional group_key for overlaid grouped histograms.",
  },
  BoxPlot: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string(),
      group_key: z.string().nullable(),
      orientation: z.enum(["vertical", "horizontal"]).nullable(),
      show_points: z.boolean().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Interactive box plot for comparing distributions across groups. Pass raw data rows with value_key and optional group_key.",
  },
  HeatMap: {
    props: z.object({
      title: z.string().nullable(),
      z: z.array(z.array(z.number())),
      x_labels: z.array(z.string()),
      y_labels: z.array(z.string()),
      color_scale: z.string().nullable(),
      show_values: z.boolean().nullable(),
      z_min: z.number().nullable(),
      z_max: z.number().nullable(),
    }),
    description:
      "Interactive heatmap for correlation matrices and 2D data. Pass z as a 2D number array with x_labels and y_labels. Use show_values to annotate cells.",
  },
  ViolinChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string(),
      group_key: z.string().nullable(),
      show_box: z.boolean().nullable(),
      show_points: z.boolean().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Interactive violin plot for showing distribution shapes. Like box plot but shows probability density. Pass raw data rows with value_key and optional group_key.",
  },
  MapView: {
    props: z.object({
      title: z.string().nullable(),
      markers: z
        .array(
          z.object({
            lat: z.number(),
            lng: z.number(),
            label: z.string().nullable(),
            color: z.string().nullable(),
          })
        )
        .nullable(),
      geojson: z.record(z.string(), z.unknown()).nullable(),
      geojson_style: z
        .object({
          fill: z.string().nullable(),
          stroke: z.string().nullable(),
          strokeWidth: z.number().nullable(),
          fillOpacity: z.number().nullable(),
        })
        .nullable(),
      center: z.tuple([z.number(), z.number()]).nullable(),
      zoom: z.number().nullable(),
      height: z.number().nullable(),
    }),
    description:
      "Interactive map with OSM tiles. Display point markers from lat/lng data and/or GeoJSON polygon overlays. Auto-fits to data bounds when center/zoom not specified.",
  },
  Scatter3D: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      x_key: z.string(),
      y_key: z.string(),
      z_key: z.string(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      z_label: z.string().nullable(),
      group_key: z.string().nullable(),
      size_key: z.string().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
      mode: z.enum(["markers", "lines", "lines+markers"]).nullable(),
    }),
    description:
      "3D scatter plot for visualizing relationships between three numeric variables. Supports grouping by a categorical column via group_key. Use size_key to map a fourth numeric column to marker size. Requires x_key, y_key, and z_key.",
  },
  Surface3D: {
    props: z.object({
      title: z.string().nullable(),
      z: z.array(z.array(z.number())),
      x_labels: z.array(z.union([z.string(), z.number()])).nullable(),
      y_labels: z.array(z.union([z.string(), z.number()])).nullable(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      z_label: z.string().nullable(),
      color_scale: z.string().nullable(),
      show_wireframe: z.boolean().nullable(),
      opacity: z.number().nullable(),
    }),
    description:
      "3D surface plot for gridded data. Pass z as a 2D number array. Similar to HeatMap but rendered as an interactive 3D surface you can rotate. Use show_wireframe for wireframe overlay. color_scale can be Viridis, RdBu, YlGnBu, etc.",
  },
  Globe3D: {
    props: z.object({
      title: z.string().nullable(),
      points: z
        .array(
          z.object({
            lat: z.number(),
            lng: z.number(),
            label: z.string().nullable(),
            color: z.string().nullable(),
            size: z.number().nullable(),
          })
        )
        .nullable(),
      arcs: z
        .array(
          z.object({
            start_lat: z.number(),
            start_lng: z.number(),
            end_lat: z.number(),
            end_lng: z.number(),
            label: z.string().nullable(),
            color: z.string().nullable(),
          })
        )
        .nullable(),
      globe_style: z.enum(["default", "night", "minimal"]).nullable(),
      auto_rotate: z.boolean().nullable(),
      height: z.number().nullable(),
    }),
    description:
      "Interactive 3D globe with point markers and arcs between locations. Use for global/international geographic data. Points need lat/lng. Arcs connect two coordinates (flights, trade routes). globe_style: 'default' (blue marble), 'night' (dark earth), 'minimal' (topology).",
  },
  Map3D: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      lat_key: z.string(),
      lng_key: z.string(),
      layer_type: z.enum(["hexagon", "column", "arc", "scatterplot", "heatmap"]),
      value_key: z.string().nullable(),
      target_lat_key: z.string().nullable(),
      target_lng_key: z.string().nullable(),
      color_key: z.string().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
      elevation_scale: z.number().nullable(),
      radius: z.number().nullable(),
      opacity: z.number().nullable(),
      pitch: z.number().nullable(),
      bearing: z.number().nullable(),
      height: z.number().nullable(),
    }),
    description:
      "3D/2.5D map visualization with deck.gl. layer_type: 'hexagon' for hexagonal aggregation of dense points, 'column' for extruded bars at locations (value_key sets height), 'arc' for origin-destination flows (needs target_lat_key + target_lng_key), 'scatterplot' for 3D scatter on map, 'heatmap' for density. pitch controls camera tilt (default 45 for 2.5D effect).",
  },
  CandlestickChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      date_key: z.string(),
      open_key: z.string(),
      high_key: z.string(),
      low_key: z.string(),
      close_key: z.string(),
      volume_key: z.string().nullable(),
      show_volume: z.boolean().nullable(),
      height: z.number().nullable(),
    }),
    description:
      "Interactive candlestick (OHLC) chart for financial/stock data. Requires date, open, high, low, close columns. Optional volume overlay. Supports zoom, pan, crosshair, and OHLC tooltip. Use for stock prices, crypto, forex, or any time-series with OHLC structure.",
  },
  SankeyChart: {
    props: z.object({
      title: z.string().nullable(),
      nodes: z.array(z.object({ id: z.string(), label: z.string().nullable() })),
      links: z.array(z.object({ source: z.string(), target: z.string(), value: z.number() })),
      color_map: z.record(z.string(), z.string()).nullable(),
      label_position: z.enum(["inside", "outside"]).nullable(),
      align: z.enum(["left", "center", "right", "justify"]).nullable(),
    }),
    description:
      "Sankey diagram for flow/transfer visualization. Pass nodes [{id, label?}] and links [{source, target, value}]. Use for budget flows, user journeys, energy transfers.",
  },
  TreemapChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.record(z.string(), z.unknown()),
      colors: z.array(z.string()).nullable(),
      tile_mode: z.enum(["squarify", "binary", "slice", "dice"]).nullable(),
      label_skip_size: z.number().nullable(),
      border_width: z.number().nullable(),
    }),
    description:
      "Treemap for hierarchical part-to-whole data. Pass data as a tree: {name, value?, children?}. Leaf nodes must have value. Use for file sizes, budget breakdowns, market share.",
  },
  RadarChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      index_key: z.string(),
      keys: z.array(z.string()),
      color_map: z.record(z.string(), z.string()).nullable(),
      max_value: z.number().nullable(),
      fill_opacity: z.number().nullable(),
      dot_size: z.number().nullable(),
    }),
    description:
      "Radar/spider chart for comparing multiple metrics. Each row is an axis (index_key), each key is a series. Use for product scorecards, performance profiles.",
  },
  BumpChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(
        z.object({
          id: z.string(),
          data: z.array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() })),
        })
      ),
      color_map: z.record(z.string(), z.string()).nullable(),
      line_width: z.number().nullable(),
      point_size: z.number().nullable(),
    }),
    description:
      "Bump chart for ranking changes over time. y is rank at each x point. Use for leaderboard evolution, competitive positioning.",
  },
  ChordChart: {
    props: z.object({
      title: z.string().nullable(),
      matrix: z.array(z.array(z.number())),
      keys: z.array(z.string()),
      colors: z.array(z.string()).nullable(),
      pad_angle: z.number().nullable(),
      inner_radius_ratio: z.number().nullable(),
    }),
    description:
      "Chord diagram for inter-relationships between groups. matrix[i][j] is flow from keys[i] to keys[j]. Use for migration, trade, communication patterns.",
  },
  SunburstChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.record(z.string(), z.unknown()),
      colors: z.array(z.string()).nullable(),
      corner_radius: z.number().nullable(),
      border_width: z.number().nullable(),
      child_color: z.enum(["inherit", "noinherit"]).nullable(),
    }),
    description:
      "Sunburst for hierarchical drill-down. Like treemap but radial. Pass data as tree: {name, value?, children?}. Use for org hierarchies, category breakdowns.",
  },
  MarimekkoChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      id_key: z.string(),
      value_key: z.string(),
      dimensions: z.array(z.object({ id: z.string(), value: z.string() })),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Marimekko (variable-width bar) for two-dimensional composition. Bar width proportional to value_key. Dimensions define stacked segments. Use for market share by segment.",
  },
  CalendarChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.object({ day: z.string(), value: z.number() })),
      from: z.string(),
      to: z.string(),
      color_scale: z.array(z.string()).nullable(),
      empty_color: z.string().nullable(),
      direction: z.enum(["horizontal", "vertical"]).nullable(),
    }),
    description:
      "GitHub-style calendar heatmap for daily values. Each cell is a day colored by intensity. Use for commit activity, daily metrics.",
  },
  StreamChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      keys: z.array(z.string()),
      color_map: z.record(z.string(), z.string()).nullable(),
      offset: z.enum(["silhouette", "wiggle", "expand", "none"]).nullable(),
      curve: z.enum(["basis", "cardinal", "linear", "monotoneX"]).nullable(),
    }),
    description:
      "Stream graph (ThemeRiver) for evolution of categories over time. Centered stacked area. Use for genre popularity, topic trends.",
  },
  WaterfallChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(
        z.object({
          label: z.string(),
          value: z.number(),
          type: z.enum(["absolute", "relative", "total"]).nullable(),
        })
      ),
      orientation: z.enum(["vertical", "horizontal"]).nullable(),
      increasing_color: z.string().nullable(),
      decreasing_color: z.string().nullable(),
      total_color: z.string().nullable(),
    }),
    description:
      "Waterfall for cumulative positive/negative effects. type: 'absolute' for start, 'relative' for change, 'total' for subtotal. Use for P&L, bridge charts.",
  },
  RidgelineChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string(),
      group_key: z.string(),
      overlap: z.number().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Ridgeline (joy plot) for comparing distributions across groups. Overlapping density curves. Use for distribution changes over time.",
  },
  DumbbellChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.object({ label: z.string(), start: z.number(), end: z.number() })),
      start_label: z.string().nullable(),
      end_label: z.string().nullable(),
      start_color: z.string().nullable(),
      end_color: z.string().nullable(),
      orientation: z.enum(["vertical", "horizontal"]).nullable(),
    }),
    description:
      "Dumbbell for comparing two values per category (before/after, actual/target). Use for gap analysis, paired comparisons.",
  },
  SlopeChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.object({ label: z.string(), start: z.number(), end: z.number() })),
      start_label: z.string().nullable(),
      end_label: z.string().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Slope chart comparing values between two periods. Each line connects start to end value. Use for before/after, two-period ranking shifts.",
  },
};
