# Component catalog

Every component a dashboard spec can use. The renderer lives in `src/components/` (see [Architecture](../README.md#architecture)).

## Charts

| Component           | Purpose                                | Library    |
| ------------------- | -------------------------------------- | ---------- |
| BarChart            | Categorical comparisons                | Nivo       |
| LineChart           | Trends over time                       | Nivo       |
| AreaChart           | Trends with volume                     | Nivo       |
| PieChart            | Part-of-whole composition              | Nivo       |
| ScatterChart        | Correlation between variables          | Nivo       |
| RadarChart          | Multivariate comparison                | Nivo       |
| BumpChart           | Ranking changes over time              | Nivo       |
| ChordChart          | Flow between categories                | Nivo       |
| SunburstChart       | Hierarchical composition               | Nivo       |
| TreemapChart        | Hierarchical proportions               | Nivo       |
| SankeyChart         | Flow quantities between nodes          | Nivo       |
| MarimekkoChart      | Two-dimensional composition            | Nivo       |
| CalendarChart       | Values over calendar days              | Nivo       |
| StreamChart         | Stacked trends over time               | Nivo       |
| Histogram           | Value distribution                     | Plotly     |
| BoxPlot             | Statistical distribution               | Plotly     |
| HeatMap             | Matrix of values by color              | Plotly     |
| ViolinChart         | Distribution shape comparison          | Plotly     |
| CandlestickChart    | OHLC financial data                    | Plotly     |
| WaterfallChart      | Cumulative value changes               | Plotly     |
| RidgelineChart      | Overlapping distributions              | Plotly     |
| DumbbellChart       | Range between two values               | Plotly     |
| SlopeChart          | Change between two points              | Plotly     |
| BeeswarmChart       | Distribution with individual points    | Plotly     |
| ShapBeeswarm        | SHAP feature importance                | Plotly     |
| ConfusionMatrix     | Classification performance             | Plotly     |
| RocCurve            | Binary classifier performance          | Plotly     |
| ParallelCoordinates | Multivariate patterns                  | Custom SVG |
| BulletChart         | Progress toward a target               | Custom SVG |
| DecisionTree        | Tree model visualization               | Custom SVG |
| ErrorBarChart       | Points/bars with confidence intervals  | Plotly     |
| DualAxisChart       | Two measures on independent y-axes     | Plotly     |
| FunnelChart         | Sequential conversion / drop-off       | Plotly     |
| GaugeChart          | Single KPI against a scale             | Plotly     |
| Sparkline           | Compact inline trend                   | Custom SVG |
| ParetoChart         | 80/20 — sorted bars + cumulative %     | Plotly     |
| QQPlot              | Normality check vs. quantiles          | Plotly     |
| ECDFChart           | Empirical cumulative distribution      | Plotly     |
| SurvivalChart       | Kaplan–Meier survival curves           | Plotly     |
| ForestPlot          | Effect sizes with confidence intervals | Plotly     |
| ControlChart        | SPC chart with control limits          | Plotly     |
| Correlogram         | ACF / PACF autocorrelation             | Plotly     |
| CalibrationCurve    | Classifier reliability diagram         | Plotly     |
| LiftChart           | Lift / cumulative gain                 | Plotly     |
| PartialDependence   | Model PDP / ICE curves                 | Plotly     |
| Dendrogram          | Hierarchical clustering tree           | Plotly     |
| SilhouettePlot      | Clustering quality by cluster          | Plotly     |
| NetworkGraph        | Node-link relationships                | Plotly     |
| ContourChart        | 2D density / scalar field              | Plotly     |
| TernaryChart        | Three-part compositional data          | Plotly     |
| PopulationPyramid   | Back-to-back category comparison       | Plotly     |
| GanttChart          | Task timelines on a date axis          | Plotly     |
| CohortGrid          | Retention matrix by cohort × period    | Plotly     |
| QuiverChart         | Vector / flow field                    | Plotly     |
| WindRose            | Polar histogram by direction           | Plotly     |

## 3D and Geospatial

| Component | Purpose                                       | Library        |
| --------- | --------------------------------------------- | -------------- |
| Scatter3D | 3D point clouds                               | Plotly         |
| Surface3D | 3D surface plots                              | Plotly         |
| Globe3D   | Points and arcs on a 3D globe                 | react-globe.gl |
| Map3D     | Hexagon, column, arc, scatter, heatmap layers | deck.gl        |
| MapView   | Markers and GeoJSON polygons on a 2D map      | MapLibre GL    |

## Display

| Component      | Purpose                               | Library        |
| -------------- | ------------------------------------- | -------------- |
| StatCard       | Single KPI with trend                 | Custom         |
| TextBlock      | Markdown or plain text                | Custom         |
| SectionBreak   | Visual section divider                | Custom         |
| Annotation     | Contextual notes                      | Custom         |
| TrendIndicator | Directional change indicator          | Custom         |
| DataTable      | Sortable, filterable, paginated table | TanStack Table |
| PivotTable     | Sort, drill, cross-filter, heatmap    | Custom         |
| ChartImage     | Rendered image from sandbox           | Custom         |
| DataController | Client-side cross-filtering           | Custom         |

## Inputs

| Component     | Purpose                        | Library |
| ------------- | ------------------------------ | ------- |
| SelectControl | Dropdown select                | Custom  |
| NumberInput   | Numeric input with constraints | Custom  |
| ToggleSwitch  | Boolean toggle                 | Custom  |
| TextInput     | Single-line text input         | Custom  |
| TextArea      | Multi-line text input          | Custom  |
