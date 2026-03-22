import { streamText } from "ai";
import { getModel } from "@/lib/llm/client";
import { catalog } from "@/lib/catalog";
import {
  getStoredCSV,
  getCSVContent,
  getGeoJSONContent,
  getWorkbookManifest,
  storeCSV,
} from "@/lib/csv/storage";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { buildWorkbookContext, sanitizeSheetName } from "@/lib/llm/prompts";
import type { AdditionalFile } from "@/lib/sandbox";
import { cacheGeneratedCode } from "@/lib/pipeline/code-cache";
import { cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import {
  UI_COMPOSE_MODEL,
  CODE_GEN_MODEL,
  LLM_MAX_OUTPUT_TOKENS,
  isValidModelId,
  isValidRuntimeId,
} from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { ConversationEntry, SchemaMode } from "@/lib/types";
import { logger } from "@/lib/logger";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { getActiveProvider } from "@/lib/llm/client";
import { getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";
import { generateSQL } from "@/lib/warehouse/sql-generation";
import { randomUUID } from "crypto";
import { extractSchema } from "@/lib/csv/schema";
import { parseCSV } from "@/lib/csv/parser";

export const maxDuration = 60;

interface DrillDownContext {
  parent_question: string;
  filter_column: string;
  filter_value: string | number;
  segment_label: string;
  chart_title: string | null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { prompt, context } = body;

    let csvId: string | undefined = context?.csv_id;
    const warehouseId: string | undefined = context?.warehouse_id;
    const question: string = context?.question ?? prompt ?? "";
    const drillDownContext: DrillDownContext | undefined = context?.drill_down_context;
    const conversationHistory: ConversationEntry[] | undefined = context?.conversation_history;
    const schemaMode: SchemaMode = context?.schema_mode === "sample" ? "sample" : "metadata";

    // When Ollama or openai-compatible is active, skip Claude model ID validation
    // since getModel() will use the Ollama/custom model directly
    let skipModelValidation = false;
    try {
      const provider = getActiveProvider();
      skipModelValidation = provider === "ollama" || provider === "openai-compatible";
    } catch {
      // No provider configured — will fail later in getModel()
    }

    const codeGenModel: string =
      !skipModelValidation && context?.code_gen_model && isValidModelId(context.code_gen_model)
        ? context.code_gen_model
        : CODE_GEN_MODEL;
    const uiComposeModel: string =
      !skipModelValidation && context?.ui_compose_model && isValidModelId(context.ui_compose_model)
        ? context.ui_compose_model
        : UI_COMPOSE_MODEL;
    const sandboxRuntime: SandboxRuntimeId =
      context?.sandbox_runtime && isValidRuntimeId(context.sandbox_runtime)
        ? context.sandbox_runtime
        : getActiveSandboxRuntime();

    if (!csvId && !warehouseId) {
      return new Response(
        JSON.stringify({ error: "csv_id or warehouse_id is required in context" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (!question) {
      return new Response(JSON.stringify({ error: "question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Warehouse: validate early (before streaming) ──────
    let warehouseState: {
      warehouse: NonNullable<ReturnType<typeof getStoredWarehouse>>;
      connector: NonNullable<ReturnType<typeof getWarehouseConnector>>;
    } | null = null;

    if (warehouseId) {
      const warehouse = getStoredWarehouse(warehouseId);
      if (!warehouse) {
        return new Response(
          JSON.stringify({ error: "Warehouse not found or expired. Please reconnect." }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      const connector = getWarehouseConnector(warehouseId);
      if (!connector) {
        return new Response(JSON.stringify({ error: "Warehouse connector not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      warehouseState = { warehouse, connector };
    }

    // Stream immediately — emit progress patches as the pipeline runs, then stream LLM output
    const encoder = new TextEncoder();
    const isWarehouse = !!warehouseState;
    const totalSteps = isWarehouse ? 5 : 3;

    const readable = new ReadableStream({
      async start(controller) {
        let closed = false;

        const emit = (data: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            closed = true;
          }
        };

        const emitProgress = (stage: string, step: number) => {
          const patch =
            step === 1
              ? {
                  op: "add",
                  path: "/state",
                  value: { __progress: { stage, step, total: totalSteps } },
                }
              : {
                  op: "replace",
                  path: "/state/__progress",
                  value: { stage, step, total: totalSteps },
                };
          emit(JSON.stringify(patch) + "\n");
        };

        let warehouseSQL: string | undefined;

        try {
          // ── Warehouse path: generate SQL → execute → store as CSV ──
          if (warehouseState) {
            const { warehouse, connector } = warehouseState;

            // Step 1/5: Generate SQL
            emitProgress("generating_sql", 1);
            logger.info("Warehouse query: generating SQL", {
              warehouseType: warehouse.config.type,
              tableCount: warehouse.tableSchemas.length,
              question,
            });
            try {
              warehouseSQL = await generateSQL(
                warehouse.tableSchemas,
                question,
                warehouse.config.type,
                codeGenModel
              );
              logger.info("Warehouse query: SQL generated", { sql: warehouseSQL });
            } catch (err) {
              const msg = err instanceof Error ? err.message : "SQL generation failed";
              logger.error("Warehouse query: SQL generation failed", { error: msg });
              throw new Error(`SQL generation failed: ${msg}`);
            }

            if (closed) return;

            // Step 2/5: Execute SQL
            emitProgress("querying_warehouse", 2);
            logger.info("Warehouse query: executing SQL");

            let warehouseCsvContent: string;
            try {
              warehouseCsvContent = await connector.executeSQL(warehouseSQL);
              if (!warehouseCsvContent || warehouseCsvContent.trim() === "") {
                throw new Error("SQL query returned no results");
              }
              const rowCount = warehouseCsvContent.split("\n").length - 2; // minus header and trailing newline
              logger.info("Warehouse query: SQL executed", { rows: rowCount });
            } catch (err) {
              const msg = err instanceof Error ? err.message : "SQL execution failed";
              logger.error("Warehouse query: SQL execution failed", {
                error: msg,
                sql: warehouseSQL,
              });
              throw new Error(`SQL execution failed: ${msg}\n\nGenerated SQL:\n${warehouseSQL}`);
            }

            // Parse CSV → extract schema → store as regular CSV
            const parsed = parseCSV(warehouseCsvContent);
            const newCsvId = randomUUID();
            const schema = extractSchema(parsed, newCsvId, `warehouse_query_result`);
            schema.source_type = "warehouse";
            schema.warehouse_type = warehouse.config.type;
            await storeCSV(newCsvId, warehouseCsvContent, schema);
            csvId = newCsvId;

            logger.info("Warehouse query: data stored as CSV", {
              csvId: newCsvId,
              columns: schema.columns.length,
            });

            // Emit the generated csvId so the client can use it for artifacts
            emit(
              JSON.stringify({
                op: "add",
                path: "/state/__warehouse_csv_id",
                value: newCsvId,
              }) + "\n"
            );
          }

          // ── Load CSV (file upload or warehouse result) ──────────
          const stored = getStoredCSV(csvId!);
          if (!stored) {
            throw new Error("CSV not found or expired. Please re-upload.");
          }

          const csvContent = await getCSVContent(csvId!);
          if (!csvContent) {
            throw new Error("CSV content not found");
          }

          // Fetch GeoJSON sidecar if the upload was GeoJSON
          const geojsonContent = stored.schema.has_geojson ? await getGeoJSONContent(csvId!) : null;

          // Check for workbook manifest (multi-sheet analysis)
          const manifest = getWorkbookManifest(csvId!);
          let additionalFiles: AdditionalFile[] | undefined;
          let workbookContext: string | undefined;

          if (manifest) {
            additionalFiles = [];
            const sheetPaths = new Map<string, string>();
            for (const sheet of manifest.sheets) {
              if (sheet.csvId === csvId) {
                sheetPaths.set(sheet.name, "/data/input.csv");
                continue;
              }
              const content = await getCSVContent(sheet.csvId);
              if (content) {
                const safeName = sanitizeSheetName(sheet.name);
                const filePath = `/data/sheets/${safeName}.csv`;
                additionalFiles.push({ path: filePath, content });
                sheetPaths.set(sheet.name, filePath);
              }
            }
            workbookContext = buildWorkbookContext(manifest, schemaMode, sheetPaths);
          }

          // Map orchestrator stages to progress updates
          const stepOffset = isWarehouse ? 2 : 0;
          const onStage = (stage: string) => {
            if (stage === "generating_code") emitProgress("analyzing", stepOffset + 1);
            else if (stage === "executing") emitProgress("computing", stepOffset + 2);
            else if (stage === "retrying") emitProgress("retrying", stepOffset + 2);
          };

          // Run the code-gen + sandbox pipeline
          const pipelineResult = await runPipeline(
            stored.schema,
            csvContent,
            question,
            onStage,
            schemaMode,
            codeGenModel,
            sandboxRuntime,
            geojsonContent,
            additionalFiles,
            workbookContext
          );

          if (closed) return;

          // Cache the generated code for save functionality
          cacheGeneratedCode(csvId!, pipelineResult.generatedCode, question);

          // Cache artifacts for the artifacts viewer
          const { executionResult } = pipelineResult;
          cacheArtifacts(csvId!, {
            code: pipelineResult.generatedCode,
            question,
            results: executionResult.results as Record<string, unknown>,
            chart_data: executionResult.chart_data as Record<string, unknown>,
            datasets: (executionResult.datasets ?? {}) as Record<string, Record<string, unknown>[]>,
            execution_ms: executionResult.execution_ms ?? 0,
            sql: warehouseSQL,
          });
          const imageKeys = Object.keys(executionResult.images);
          const datasets = executionResult.datasets;
          const mainDataset = datasets?.main;
          const hasDataset = mainDataset && mainDataset.length > 0 && mainDataset.length <= 5000;

          // Detect filterable columns (categorical with <15 distinct values)
          let datasetColumns: { name: string; distinct: number; sample: string[] }[] = [];
          if (hasDataset) {
            const allKeys = Object.keys(mainDataset[0] ?? {});
            datasetColumns = allKeys.map((col) => {
              const values = [...new Set(mainDataset.map((r) => String(r[col] ?? "")))].filter(
                Boolean
              );
              return { name: col, distinct: values.length, sample: values.slice(0, 8) };
            });
          }
          const filterableColumns = datasetColumns.filter(
            (c) => c.distinct >= 2 && c.distinct <= 15
          );
          const useDataController = hasDataset && filterableColumns.length > 0;

          // Build image placeholder map: LLM uses placeholder keys, we replace with real base64
          const imagePlaceholders: Record<string, string> = {};
          for (const key of imageKeys) {
            imagePlaceholders[key] = `data:image/png;base64,${executionResult.images[key]}`;
          }

          // Describe chart_data shape (key names, column types, row counts, sample rows)
          // so the LLM can choose the right component without receiving full data arrays.
          function describeShape(val: unknown, includeSamples: boolean): unknown {
            if (Array.isArray(val)) {
              if (val.length === 0) return { _type: "array", rows: 0 };
              const sample = includeSamples ? val.slice(0, 2) : undefined;
              const first = val[0];
              if (typeof first === "object" && first !== null) {
                const cols: Record<string, string> = {};
                for (const [k, v] of Object.entries(first)) {
                  cols[k] =
                    typeof v === "number"
                      ? "number"
                      : typeof v === "boolean"
                        ? "boolean"
                        : "string";
                }
                return sample
                  ? { _type: "array", rows: val.length, columns: cols, sample }
                  : { _type: "array", rows: val.length, columns: cols };
              }
              return sample
                ? { _type: "array", rows: val.length, valueType: typeof first, sample }
                : { _type: "array", rows: val.length, valueType: typeof first };
            }
            if (typeof val === "object" && val !== null) {
              const described: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(val)) {
                described[k] = describeShape(v, includeSamples);
              }
              return described;
            }
            return val; // scalars pass through
          }

          function describeResultsSchema(obj: Record<string, unknown>): Record<string, unknown> {
            const schema: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(obj)) {
              if (val === null || val === undefined) {
                schema[key] = { type: "null" };
              } else if (typeof val === "number") {
                schema[key] = { type: "number", is_integer: Number.isInteger(val) };
              } else if (typeof val === "boolean") {
                schema[key] = { type: "boolean" };
              } else if (typeof val === "string") {
                schema[key] = { type: "string" };
              } else if (Array.isArray(val)) {
                schema[key] = {
                  type: "array",
                  length: val.length,
                  element_type: val.length > 0 ? typeof val[0] : "unknown",
                };
              } else if (typeof val === "object") {
                schema[key] = {
                  type: "object",
                  keys: describeResultsSchema(val as Record<string, unknown>),
                };
              }
            }
            return schema;
          }

          const chartDataShape = Object.fromEntries(
            Object.entries(executionResult.chart_data).map(([k, v]) => [
              k,
              describeShape(v, schemaMode === "sample"),
            ])
          );

          // Cap results at 30K chars — these are small scalar aggregations the LLM
          // needs verbatim for StatCard values and TextBlock content.
          function truncateValue(val: unknown, maxChars: number): unknown {
            if (Array.isArray(val)) {
              for (
                let limit = Math.min(val.length, 50);
                limit >= 5;
                limit = Math.floor(limit / 2)
              ) {
                const sliced = val.slice(0, limit);
                const json = JSON.stringify(sliced);
                if (json.length <= maxChars) {
                  if (limit < val.length) {
                    return { _truncated: true, _total: val.length, _sample: sliced };
                  }
                  return sliced;
                }
              }
              return { _truncated: true, _total: val.length, _sample: val.slice(0, 3) };
            }
            const json = JSON.stringify(val);
            if (json.length <= maxChars) return val;
            if (typeof val === "object" && val !== null) {
              const entries = Object.entries(val as Record<string, unknown>);
              const trimmed: Record<string, unknown> = {};
              let remaining = maxChars - 50;
              for (const [k, v] of entries) {
                const s = JSON.stringify(v);
                if (s.length <= remaining) {
                  trimmed[k] = v;
                  remaining -= s.length;
                } else {
                  trimmed[k] = truncateValue(v, Math.max(remaining, 200));
                  break;
                }
              }
              return trimmed;
            }
            return String(val).slice(0, maxChars);
          }

          const resultsJson = JSON.stringify(executionResult.results);
          const compactResults =
            resultsJson.length > 30_000
              ? truncateValue(executionResult.results, 30_000)
              : executionResult.results;

          const resultsSection =
            schemaMode === "metadata"
              ? `## Analysis Results Schema
${JSON.stringify(describeResultsSchema(compactResults as Record<string, unknown>))}

Use "$result:<key>" placeholders for all scalar values in StatCard, TrendIndicator, and similar components. Example: {"value": "$result:total_sales"}. Supports dot-notation for nested keys: "$result:summary.avg_price".`
              : `## Analysis Results
${JSON.stringify(compactResults)}`;

          let userPrompt = `## Original Question
${question}

${resultsSection}

## Chart Data Shapes
Available keys and their shapes:
${JSON.stringify(chartDataShape, null, 2)}
${
  useDataController
    ? `
Use "$chartData:<key>" placeholders ONLY when pre-populating initial /computed/* state values so charts have data on first render. Charts themselves MUST use {"$state": "/computed/<name>"} for their data prop — never "$chartData:" in component props directly.`
    : `
When referencing chart data in component props, use the string "$chartData:<key>" as the data value. It will be replaced with the actual array at render time. For example: "data": "$chartData:bar_data"
For HeatMap z/x_labels/y_labels, use "$chartData:heatmap.z", "$chartData:heatmap.x_labels", etc.
For Globe3D: use "$chartData:<key>.points" for the points prop and "$chartData:<key>.arcs" for the arcs prop. Example: "points": "$chartData:globe.points", "arcs": "$chartData:globe.arcs".
For Surface3D: use "$chartData:<key>.z", "$chartData:<key>.x_labels", "$chartData:<key>.y_labels".`
}

${imageKeys.length > 0 ? `## Available Images\nThe following image keys are available for ChartImage components. Use the EXACT placeholder string as the src value:\n${imageKeys.map((k) => `- Use src: "IMAGE_PLACEHOLDER_${k}" for ${k}`).join("\n")}` : ""}`;

          // Add dataset metadata for DataController awareness
          if (useDataController) {
            userPrompt += `

## Dataset Available for Client-Side Filtering
A dataset with ${mainDataset.length} rows is available at state path /datasets/main.
Columns: ${datasetColumns.map((c) => `${c.name} (${c.distinct} distinct)`).join(", ")}
Filterable columns (categorical, <15 values): ${schemaMode === "metadata" ? filterableColumns.map((c) => `${c.name} (${c.distinct} distinct)`).join(", ") : filterableColumns.map((c) => `${c.name} [${c.sample.join(", ")}]`).join("; ")}

Use a DataController component to enable instant client-side filtering. The full dataset is stored at /datasets/main in spec.state. Structured chart_data (geojson, globe, sankey, etc.) is also auto-injected at /datasets/<key>. Charts MUST read from /computed/* state paths using {"$state": "/computed/<name>"} for their data prop — NOT "$chartData:" placeholders.`;
          }

          // Append drill-down context if present
          if (drillDownContext) {
            userPrompt += `

## Drill-Down Context
This is a drill-down analysis. The user clicked on a chart segment to explore deeper.
- Parent question: ${drillDownContext.parent_question}
- Segment clicked: "${drillDownContext.segment_label}"
- Filter: ${drillDownContext.filter_column} = ${drillDownContext.filter_value}
${drillDownContext.chart_title ? `- Source chart: ${drillDownContext.chart_title}` : ""}

Focus the analysis specifically on data where ${drillDownContext.filter_column} = "${drillDownContext.filter_value}". Provide detailed breakdown and insights for this specific segment.`;
          }

          // Append conversation history for follow-ups
          if (conversationHistory && conversationHistory.length > 0) {
            userPrompt += `

## Conversation History
The user is asking a follow-up question. Previous turns in this conversation:
${conversationHistory.map((entry, i) => `### Turn ${i + 1}: "${entry.question}"\nDashboard showed:\n${entry.specSummary}`).join("\n\n")}

Build on the prior analysis. Evolve the dashboard to address the new question while maintaining continuity with previous insights where relevant.`;
          }

          if (workbookContext) {
            userPrompt += `

## Workbook Context
This analysis was performed across multiple sheets in an Excel workbook. The code joined/merged data from different sheets.
${workbookContext}`;
          }

          userPrompt += `

Compose a dashboard that answers the user's question. Choose the layout that best tells the data story — lead with the most impactful component. Interleave brief insights between visualizations for a narrative flow.`;

          // Domain-aware UI rules
          const domainUiRules: string[] = [];
          const detectedDomain = stored.schema.detected_domain;
          if (detectedDomain === "financial") {
            domainUiRules.push(
              'For financial metrics, use StatCard with format="currency" and precision=2. For percentage changes, use format="percent".',
              "Use CandlestickChart for OHLC price data — prefer it over LineChart when open/high/low/close are available.",
              "Use WaterfallChart for P&L bridges, revenue walks, or cumulative change breakdowns.",
              "For period-over-period comparisons, use TrendIndicator with format and precision props.",
              "Negative financial values (losses, declines) should display naturally — do not hide the sign."
            );
          } else if (detectedDomain === "statistical") {
            domainUiRules.push(
              "For statistical test results, use Annotation (severity: info) to display test names, p-values, and effect sizes clearly.",
              "Use BoxPlot or ViolinChart for distribution comparisons — prefer these over bar charts for numeric distributions.",
              "Use HeatMap with show_values: true for correlation matrices.",
              "When showing regression results, use ScatterChart with show_regression: true."
            );
          } else if (detectedDomain === "time_series") {
            domainUiRules.push(
              "Use LineChart for time-series trends. Use show_dots: false for dense daily data, show_dots: true for sparse monthly/quarterly data.",
              "For period comparisons (YoY, MoM), use TrendIndicator or DumbbellChart.",
              "Use CalendarChart for daily metrics that benefit from a calendar view."
            );
          }

          const customRules = [
            ...domainUiRules,
            ...(schemaMode === "metadata"
              ? [
                  'Use "$result:<key>" placeholders for ALL scalar values in StatCard value, TrendIndicator value/previous, and any other numeric display props. Never fabricate or guess specific numbers.',
                  "TextBlock content must be qualitative and descriptive — do NOT include specific numeric values. Describe trends, patterns, and relationships without citing exact figures.",
                  "Never hallucinate specific numeric values. If you need a number displayed, it MUST come from a $result:<key> placeholder.",
                ]
              : []),
            "Do NOT fabricate large data arrays (e.g. GeoJSON boundaries, coordinate tables) that are not in the chart_data or results. Small scalar values from results (for StatCard, TextBlock, etc.) are fine to inline.",
            "Design the layout like a data infographic that flows top-to-bottom as a narrative. Lead with whatever is most impactful for the question — a chart, stat cards, or a key insight. TextBlock headings are optional, not required. Vary the opening by question type: comparisons can lead with a chart, trend questions with a line chart, summaries with stat cards. Interleave TextBlock (variant: insight) annotations between visualizations to narrate the story, rather than clustering all text at the end.",
            "Use StatCard for key metrics. Group them in a LayoutGrid (columns: 2-4).",
            "Use the appropriate chart type for the data shape.",
            "Add Annotation components for outliers, notable patterns, or caveats.",
            "Use TrendIndicator when comparing two time periods.",
            "Use ChartImage ONLY when images were generated in the sandbox (truly custom matplotlib visualizations).",
            "For distribution analysis, use Histogram (pass raw data rows + value_key, optional group_key for overlaid groups).",
            "For comparing distributions across groups, use BoxPlot (raw data rows + value_key + group_key) or ViolinChart (same props, shows density shape).",
            useDataController
              ? 'For correlation matrices or 2D numeric grids, use HeatMap (z, x_labels, y_labels, show_values: true). If the heatmap is a crosstab/pivot of the main dataset, use a DataController output with pipeline: [{op: "pivot", rowKey, columnKey, valueKey, aggFn}] and format: "matrix". HeatMap reads z: {"$state": "/computed/heatmap/z"}, x_labels: {"$state": "/computed/heatmap/x_labels"}, y_labels: {"$state": "/computed/heatmap/y_labels"}. For custom-computed matrices (e.g. correlation), use "$chartData:" directly. Do NOT use ChartImage for correlation matrices.'
              : "For correlation matrices or 2D numeric grids, use HeatMap (z: number[][], x_labels, y_labels, show_values: true). Do NOT use ChartImage for correlation matrices.",
            "For ML confusion matrices, use ConfusionMatrix (matrix: number[][], labels: string[]). Set normalize: true for percentages. Do NOT use HeatMap or ChartImage for confusion matrices.",
            "For ROC or Precision-Recall curves, use RocCurve (curves: [{label, fpr, tpr, auc?}], curve_type: 'roc'|'pr'). Supports multiple curves for model comparison. Do NOT use matplotlib/ChartImage.",
            "For SHAP feature importance, use ShapBeeswarm (data: [{feature, shap_value, feature_value}]). x = SHAP value, y = feature, color = feature value. Do NOT use ChartImage.",
            useDataController
              ? 'For flow/transfer/journey visualizations, use SankeyChart (nodes: [{id}], links: [{source, target, value}]). Include filter columns as extra properties on node objects. Add a DataController output: {statePath: "/computed/sankey", format: "sankeyData", sourceStatePath: "/datasets/sankey"}. SankeyChart reads nodes: {"$state": "/computed/sankey/nodes"}, links: {"$state": "/computed/sankey/links"}. Pre-populate /computed/sankey in initial state with "$chartData:sankey".'
              : "For flow/transfer/journey visualizations, use SankeyChart (nodes: [{id}], links: [{source, target, value}]). Use for budget flows, user journeys, energy transfers, funnel analysis.",
            "For hierarchical part-to-whole data, use TreemapChart (recursive tree: {name, value?, children?}). For radial hierarchy, use SunburstChart (same data shape). Do NOT use ChartImage.",
            "For radar/spider multi-metric comparison, use RadarChart (data rows, index_key for axes, keys for series). Use for scorecards, profile comparison.",
            "For ranking changes over time, use BumpChart (data: [{id, data: [{x, y}]}] where y = rank).",
            useDataController
              ? 'For inter-group relationships/flows, use ChordChart (matrix, keys). If the chord matrix is a crosstab/pivot of the main dataset, use a DataController output with pipeline: [{op: "pivot", rowKey, columnKey, valueKey, aggFn}] and format: "chordMatrix". ChordChart reads matrix: {"$state": "/computed/chord/matrix"}, keys: {"$state": "/computed/chord/keys"}. For custom-computed matrices, use "$chartData:" directly.'
              : "For inter-group relationships/flows, use ChordChart (matrix: number[][], keys: string[]). matrix[i][j] = flow from i to j.",
            "For GitHub-style calendar heatmaps of daily values, use CalendarChart (data: [{day, value}], from, to).",
            "For stacked stream/ThemeRiver time series, use StreamChart (data rows, keys for categories).",
            "For cumulative positive/negative effects (P&L, bridge charts), use WaterfallChart (data: [{label, value, type}]). type: 'absolute' for start, 'relative' for change, 'total' for subtotal.",
            "For comparing distributions across groups as overlapping density curves, use RidgelineChart (data rows, value_key, group_key).",
            "For before/after or paired comparisons, use DumbbellChart (data: [{label, start, end}]). For two-period ranking shifts, use SlopeChart (same data shape).",
            "For showing individual data points with jitter, use BeeswarmChart (data rows, value_key, group_key).",
            "For variable-width stacked bars (two-dimensional composition), use MarimekkoChart (data rows, id_key, value_key, dimensions).",
            "For multivariate exploration across many dimensions, use ParallelCoordinates (data rows, dimensions: string[], group_key for coloring).",
            "For progress against targets with qualitative ranges, use BulletChart (data: [{label, value, target?, ranges}]). Use for KPI dashboards.",
            "For ML decision trees or decision flowcharts, use DecisionTree (recursive tree: {label, value?, condition?, children?}). Do NOT use ChartImage.",
            "Keep total component count under 20.",
            "Wrap everything in a LayoutColumn as the root element.",
            "Output ONLY raw JSONL lines. Do NOT wrap in markdown code fences.",
            ...(useDataController
              ? [
                  // DataController architecture: ONE wrapper for the whole dashboard
                  "CRITICAL: Use exactly ONE DataController as a top-level wrapper around ALL dashboard content (StatCards, charts, tables, annotations). Do NOT create multiple DataControllers — one per chart or per section. A single DataController renders one set of filter dropdowns that control the entire dashboard.",
                  "The ONE DataController must define ALL filters, ALL pipeline steps, and ALL outputs needed by every chart and stat card in the dashboard. Each chart gets its own output path (e.g. /computed/bar_data, /computed/line_data, /computed/stats) but they all come from the same DataController pipeline.",
                  "Exception: If a filter semantically applies to only ONE specific chart or section and not the rest of the dashboard, you may use a nested DataController for just that section. This is rare — most filters apply dashboard-wide.",
                  'Charts inside the DataController MUST use {"$state": "/computed/<name>"} for their data prop. Do NOT use "$chartData:" placeholders in chart component data props — only in initial /computed/* state values.',
                  'DataController props: source: {statePath: "/datasets/main"}, filters: [{key, column, bindTo: "/filters/<col>", label, allowAll: true, dependsOn: null}], pipeline: [{op: "filter"}, ...shared steps...], outputs: [{statePath: "/computed/<name>", format: null, pipeline: [...per-output steps...]}].',
                  'The top-level "pipeline" runs shared steps (typically just [{op: "filter"}]). Each output can define its OWN "pipeline" array inside the output object — these steps run on the filtered data independently. This lets one DataController produce different aggregations for different charts. Example: outputs: [{statePath: "/computed/by_region", pipeline: [{op: "groupBy", columns: ["region"], aggregations: [{column: "sales", fn: "sum", as: "total"}]}], format: null}, {statePath: "/computed/by_category", pipeline: [{op: "groupBy", columns: ["category"], aggregations: [{column: "sales", fn: "sum", as: "total"}]}], format: null}]. Outputs WITHOUT a pipeline field use the shared pipeline result.',
                  'Pipeline ops: "filter" (reads active filter state), "groupBy" (columns + aggregations with fn: sum/avg/min/max/count/countDistinct/median), "sort" (column + direction), "limit" (count), "topN" (column + n + direction), "pivot" (rowKey + columnKey + valueKey + aggFn), "compute" (column + expression like "percent(a,b)").',
                  'Set initial state: datasets.main is injected automatically. Set /filters/<col> initial values (e.g. "All"). Pre-populate /computed/* paths using "$chartData:<key>" placeholders (e.g. "$chartData:bar_data") so charts render before any filter interaction — these placeholders are replaced with real data at stream time.',
                  'StatCards MUST also update when filters change. Add a pipeline output with format: "stats" that uses groupBy with empty columns [] and aggregations (sum, count, avg, etc.) to compute summary values, and outputs to a stats path (e.g. "/computed/stats"). The "stats" format extracts the first row as a flat {key: value} object. Then set each StatCard value to {"$state": "/computed/stats/<field_name>"}. Numbers are auto-formatted (e.g. 1234567 → "1.2M"). Pre-populate /computed/stats in initial state with "$chartData:<stats_key>" so StatCards render before filter interaction.',
                  'Additional output formats for structured charts — Pattern A (filter structured data in state): format "geojson" with sourceStatePath filters GeoJSON FeatureCollection features by properties. format "globeData" with sourceStatePath filters points[] by properties, keeps arcs[] only where both endpoints survive. format "sankeyData" with sourceStatePath filters nodes[] by properties, keeps links[] only where both source and target survive. All three require sourceStatePath pointing to the unfiltered data in /datasets/<key>.',
                  'Additional output formats — Pattern B (derive from pivoted rows): format "matrix" converts pivot output rows to {z: number[][], x_labels: string[], y_labels: string[]} for HeatMap/Surface3D. format "chordMatrix" converts pivot output rows to {matrix: number[][], keys: string[]} for ChordChart. Both require a pivot step in the output pipeline.',
                  "Do NOT use SelectControl/NumberInput/ToggleSwitch for filtering when DataController is present — the DataController renders its own filter dropdowns.",
                  'Charts can enable click-to-filter cross-filtering via the "selects" prop. Set selects: {column: "<column>", bindTo: "/filters/<column>"} where bindTo matches a DataController filter. Clicking a bar or pie slice filters the dashboard; clicking again deselects.',
                  "Use selects on BarChart and PieChart when the axis or slice represents a filterable category. Do NOT use selects AND on.click drillDown on the same chart.",
                  "Cross-filtering is best with 2-3 charts selecting into different filter dimensions.",
                ]
              : [
                  'Reference chart data using "$chartData:<key>" placeholders in data props. Do NOT inline data arrays. Example: "data": "$chartData:bar_data". For nested fields like heatmap data, use "$chartData:heatmap.z", "$chartData:heatmap.x_labels", "$chartData:heatmap.y_labels".',
                ]),
            'For DataTable columns, use plain strings like ["Name", "Age"], NOT objects.',
            'For DataTable rows, use arrays of strings like [["Alice", "30"]], NOT objects.',
            "When data supports further segmentation or breakdown, add on.click bindings with the drillDown action on chart components. Set appropriate params: segment_label (human-readable label for the segment), segment_value (the data value), chart_title (title of the chart), x_key/y_key (the data keys), filter_column (column to filter on), filter_value (value to filter by). Only add drill-down when further breakdown makes sense.",
            "Prefer named colors (indigo, emerald, amber, rose, violet, cyan, orange, pink) in color_map and colors props for consistent theming.",
            stored.schema.has_geojson &&
            (stored.schema.geojson_geometry_type === "Polygon" ||
              stored.schema.geojson_geometry_type === "MultiPolygon")
              ? useDataController
                ? 'This data has Polygon/MultiPolygon GeoJSON geometry. GeoJSON is auto-injected at /datasets/geojson. Add a DataController output: {statePath: "/computed/geojson", format: "geojson", sourceStatePath: "/datasets/geojson"}. MapView uses geojson: {"$state": "/computed/geojson"}. Pre-populate /computed/geojson in initial state with "$chartData:geojson". Use color_key for choropleth coloring, with color_scale: [low_color, high_color]. Do NOT pass markers when geojson polygons are available.'
                : 'This data has Polygon/MultiPolygon GeoJSON geometry. Use MapView with the geojson prop to render polygon boundaries — do NOT use markers for polygon data. Set geojson: "$chartData:geojson" and use color_key for choropleth coloring by a numeric property, with color_scale: [low_color, high_color]. Example: {"geojson": "$chartData:geojson", "color_key": "population_density", "color_scale": ["#f7fbff", "#08306b"]}. Do NOT pass markers when geojson polygons are available.'
              : 'Use MapView when data contains geographic coordinates (lat/lng). Pass markers as [{lat, lng, label, color}]. Only pass geojson if GeoJSON geometry is present in the chart_data — do NOT fabricate or inline GeoJSON. For choropleth maps (polygons colored by a numeric property), set color_key to the property name and optionally color_scale to [low_color, high_color]. Example: {"geojson": "$chartData:geojson", "color_key": "population", "color_scale": ["#f7fbff", "#08306b"]}.',
            useDataController
              ? 'Use Globe3D when data spans multiple countries or continents — flight routes, trade flows, global metrics. Include filter columns as extra properties on each point object (e.g. {lat, lng, label, region: row["region"]}). Add a DataController output: {statePath: "/computed/globe", format: "globeData", sourceStatePath: "/datasets/globe"}. Globe3D reads points: {"$state": "/computed/globe/points"}, arcs: {"$state": "/computed/globe/arcs"}. Pre-populate /computed/globe in initial state with "$chartData:globe". globe_style: "default" (blue marble), "night" (dark), "minimal" (topology).'
              : 'Use Globe3D when data spans multiple countries or continents — flight routes, trade flows, global metrics. Wire props using $chartData placeholders: "points": "$chartData:<key>.points", "arcs": "$chartData:<key>.arcs". Do NOT pass polygons unless the user explicitly asks for country boundary overlays — points and arcs are sufficient for most use cases. globe_style: "default" (blue marble), "night" (dark), "minimal" (topology).',
            "Use Map3D for dense geospatial data needing 3D aggregation. layer_type: 'hexagon' for hexagonal density, 'column' for extruded bars at locations, 'arc' for origin-destination flows, 'scatterplot' for points on map, 'heatmap' for density. Use instead of MapView when data has hundreds+ of points or needs aggregation.",
            "Use Scatter3D when there are three numeric variables to explore in 3D. Supports group_key for coloring by category and size_key for a 4th dimension.",
            useDataController
              ? 'Use Surface3D for gridded 2D data that benefits from a 3D surface view (response surfaces, interpolated terrain). If the surface is a crosstab/pivot of the main dataset, use a DataController output with pipeline: [{op: "pivot", rowKey, columnKey, valueKey, aggFn}] and format: "matrix". Surface3D reads z: {"$state": "/computed/surface/z"}, x_labels: {"$state": "/computed/surface/x_labels"}, y_labels: {"$state": "/computed/surface/y_labels"}. For custom-computed surfaces (e.g. correlation), use "$chartData:" directly.'
              : "Use Surface3D for gridded 2D data that benefits from a 3D surface view (response surfaces, interpolated terrain). Similar to HeatMap but rendered as rotatable 3D surface.",
            "Prefer 2D charts (BarChart, LineChart, ScatterChart, etc.) when they communicate the data effectively. Only use 3D components when the third dimension adds real analytical value.",
            'For interactive scenario planners, what-if tools, or calculators where NumberInput changes should reactively update StatCard values, use DataController with source.fromState. This builds a reactive single-row dataset from scalar state paths. Example: {"type":"DataController","props":{"source":{"fromState":{"units":"/inputs/units","price":"/inputs/price","margin":"/inputs/margin"}},"filters":[],"pipeline":[{"op":"compute","column":"revenue","expression":"multiply(units, price)"},{"op":"compute","column":"profit","expression":"percentOf(revenue, margin)"}],"outputs":[{"statePath":"/computed/stats","format":"stats"}]}}. NumberInputs bind via $bindState to /inputs/* paths, StatCards read via {"$state":"/computed/stats/revenue"}. Set initial /inputs/* values in spec.state. Compute ops: multiply(a,b), add(a,b), subtract(a,b), percentOf(a,b)=a*b/100, percent(a,b)=a/b*100, ratio(a,b)=a/b, diff(a,b)=a-b.',
          ];

          // Emit "composing" progress before LLM streaming begins
          emitProgress("composing", stepOffset + 3);

          const llmResult = streamText({
            model: getModel(uiComposeModel),
            system: catalog.prompt({ customRules }),
            prompt: userPrompt,
            temperature: 0,
            maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
          });

          // Transform stream: strip markdown fences + replace image placeholders + inject datasets
          const textStream = llmResult.textStream;

          let buffer = "";
          let stateInjected = false;
          let lineCount = 0;

          const processLine = (trimmed: string): string | null => {
            if (trimmed === "" || trimmed.startsWith("```")) return null;
            // Replace image placeholders with actual base64 data URIs
            let processed = trimmed;
            for (const [key, dataUri] of Object.entries(imagePlaceholders)) {
              processed = processed.replaceAll(`IMAGE_PLACEHOLDER_${key}`, dataUri);
            }

            // Replace $chartData:<key> placeholders with actual data
            for (const [key, value] of Object.entries(executionResult.chart_data)) {
              // Handle top-level keys: "$chartData:scatter"
              const placeholder = `"$chartData:${key}"`;
              if (processed.includes(placeholder)) {
                processed = processed.replaceAll(placeholder, JSON.stringify(value));
              }
              // Handle nested keys: "$chartData:heatmap.z"
              if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
                  const subPlaceholder = `"$chartData:${key}.${subKey}"`;
                  if (processed.includes(subPlaceholder)) {
                    processed = processed.replaceAll(subPlaceholder, JSON.stringify(subVal));
                  }
                }
              }
            }

            // Replace $result:<key> placeholders with actual values from execution results.
            // Resolve dot-notation paths greedily to handle keys containing literal dots
            // (e.g. "significant_at_0.05" is a single key, not nested).
            const resolveResultKey = (keyPath: string): unknown => {
              const resolve = (obj: unknown, path: string): unknown => {
                if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
                const rec = obj as Record<string, unknown>;
                if (path in rec) return rec[path];
                const dot = path.indexOf(".");
                if (dot === -1) return undefined;
                const head = path.slice(0, dot);
                const tail = path.slice(dot + 1);
                if (head in rec) return resolve(rec[head], tail);
                return undefined;
              };
              return resolve(executionResult.results, keyPath);
            };

            // Pass 1: standalone JSON string values like "$result:total_sales" → raw JSON value
            // Uses [^"]+ to support keys with spaces (e.g. "$result:status.On Track")
            const resultRegex = /"\$result:([^"]+)"/g;
            processed = processed.replace(resultRegex, (_match, keyPath: string) => {
              const value = resolveResultKey(keyPath.trim());
              return value !== undefined ? JSON.stringify(value) : _match;
            });

            // Pass 2: inline placeholders within larger strings like "F-stat: $result:f_stat"
            // These survive Pass 1 because the quotes don't wrap just the placeholder.
            // Supports spaces in dot-separated key segments (e.g. "On Track").
            // Each segment must start with a word char; trailing punctuation is not captured.
            const inlineResultRegex =
              /\$result:([a-zA-Z0-9_]+(?:\.[\w][^\n",}]*?)*?)(?=[",}\s]|$)/g;
            processed = processed.replace(inlineResultRegex, (_match, keyPath: string) => {
              const value = resolveResultKey(keyPath.trim());
              if (value === undefined) return _match;
              if (typeof value === "number") {
                return Number.isInteger(value)
                  ? String(value)
                  : parseFloat(value.toFixed(4)).toString();
              }
              if (typeof value === "boolean") return value ? "Yes" : "No";
              return String(value);
            });

            // Inject datasets.main (+ structured chart_data) into a JSON-Patch that sets /state
            if (useDataController && !stateInjected && mainDataset) {
              try {
                const parsed = JSON.parse(processed);
                if (
                  parsed.op === "add" &&
                  parsed.path === "/state" &&
                  typeof parsed.value === "object" &&
                  parsed.value !== null
                ) {
                  if (!parsed.value.datasets) parsed.value.datasets = {};
                  parsed.value.datasets.main = mainDataset;
                  // Inject structured chart_data (geojson, globe, sankey, etc.) into datasets
                  for (const [key, value] of Object.entries(executionResult.chart_data)) {
                    if (typeof value === "object" && value !== null) {
                      parsed.value.datasets[key] = value;
                    }
                  }
                  processed = JSON.stringify(parsed);
                  stateInjected = true;
                }
              } catch {
                // Not valid JSON yet, pass through
              }
            }

            lineCount++;
            return processed;
          };

          try {
            for await (const chunk of textStream) {
              if (closed) break;
              buffer += chunk;
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                const result = processLine(line.trim());
                if (result !== null) {
                  emit(result + "\n");
                }
              }
            }
            if (!closed && buffer.trim()) {
              const result = processLine(buffer.trim());
              if (result !== null) {
                emit(result + "\n");
              }
            }
          } catch (streamErr) {
            if (!closed) {
              logger.error("Stream error", {
                error: streamErr instanceof Error ? streamErr.message : String(streamErr),
              });
              if (lineCount === 0) {
                const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
                emit(
                  JSON.stringify({
                    op: "add",
                    path: "/root",
                    value: "error",
                  }) + "\n"
                );
                emit(
                  JSON.stringify({
                    op: "add",
                    path: "/elements/error",
                    value: {
                      type: "Annotation",
                      props: {
                        icon: "alert",
                        title: "Analysis Error",
                        content: errMsg.includes("too long")
                          ? "The analysis data is too large for the AI to process. Try a more specific question."
                          : errMsg,
                        severity: "error",
                      },
                      children: [],
                    },
                  }) + "\n"
                );
              }
            }
          }

          // If the LLM streamed state as individual field patches (not a single
          // /state add), we still need to inject the dataset.
          if (!closed && useDataController && !stateInjected && mainDataset) {
            const datasetsPayload: Record<string, unknown> = { main: mainDataset };
            for (const [key, value] of Object.entries(executionResult.chart_data)) {
              if (typeof value === "object" && value !== null) {
                datasetsPayload[key] = value;
              }
            }
            emit(
              JSON.stringify({
                op: "add",
                path: "/state/datasets",
                value: datasetsPayload,
              }) + "\n"
            );
          }
        } catch (pipelineErr) {
          // Pipeline or LLM setup error — emit error annotation into the stream
          if (!closed) {
            const errMsg = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
            logger.error("Pipeline error", { error: errMsg });
            emit(
              JSON.stringify({
                op: "add",
                path: "/root",
                value: "error",
              }) + "\n"
            );
            emit(
              JSON.stringify({
                op: "add",
                path: "/elements/error",
                value: {
                  type: "Annotation",
                  props: {
                    icon: "alert",
                    title: "Analysis Error",
                    content: errMsg.includes("too long")
                      ? "The analysis data is too large for the AI to process. Try a more specific question."
                      : errMsg,
                    severity: "error",
                  },
                  children: [],
                },
              }) + "\n"
            );
          }
        }

        if (!closed) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err) {
    logger.error("Query error", { error: err instanceof Error ? err.message : String(err) });
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
