import { streamText } from "ai";
import { getModel } from "@/lib/llm/client";
import { catalog } from "@/lib/catalog";
import { getStoredCSV, getCSVContent } from "@/lib/csv/storage";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { cacheGeneratedCode } from "@/lib/pipeline/code-cache";
import { cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import {
  UI_COMPOSE_MODEL,
  CODE_GEN_MODEL,
  DEFAULT_SANDBOX_RUNTIME,
  isValidModelId,
  isValidRuntimeId,
} from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { ConversationEntry, SchemaMode } from "@/lib/types";
import { logger } from "@/lib/logger";

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

    const csvId: string | undefined = context?.csv_id;
    const question: string = context?.question ?? prompt ?? "";
    const drillDownContext: DrillDownContext | undefined = context?.drill_down_context;
    const conversationHistory: ConversationEntry[] | undefined = context?.conversation_history;
    const schemaMode: SchemaMode = context?.schema_mode === "sample" ? "sample" : "metadata";
    const codeGenModel: string =
      context?.code_gen_model && isValidModelId(context.code_gen_model)
        ? context.code_gen_model
        : CODE_GEN_MODEL;
    const uiComposeModel: string =
      context?.ui_compose_model && isValidModelId(context.ui_compose_model)
        ? context.ui_compose_model
        : UI_COMPOSE_MODEL;
    const sandboxRuntime: SandboxRuntimeId =
      context?.sandbox_runtime && isValidRuntimeId(context.sandbox_runtime)
        ? context.sandbox_runtime
        : DEFAULT_SANDBOX_RUNTIME;

    if (!csvId) {
      return new Response(JSON.stringify({ error: "csv_id is required in context" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!question) {
      return new Response(JSON.stringify({ error: "question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stored = getStoredCSV(csvId);
    if (!stored) {
      return new Response(
        JSON.stringify({ error: "CSV not found or expired. Please re-upload." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const csvContent = await getCSVContent(csvId);
    if (!csvContent) {
      return new Response(JSON.stringify({ error: "CSV content not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Run the code-gen + sandbox pipeline (non-streaming)
    const pipelineResult = await runPipeline(
      stored.schema,
      csvContent,
      question,
      undefined,
      schemaMode,
      codeGenModel,
      sandboxRuntime
    );

    // Cache the generated code for save functionality
    cacheGeneratedCode(csvId, pipelineResult.generatedCode, question);

    // Cache artifacts for the artifacts viewer
    const { executionResult } = pipelineResult;
    cacheArtifacts(csvId, {
      code: pipelineResult.generatedCode,
      question,
      results: executionResult.results as Record<string, unknown>,
      chart_data: executionResult.chart_data as Record<string, unknown>,
      datasets: (executionResult.datasets ?? {}) as Record<string, Record<string, unknown>[]>,
      execution_ms: executionResult.execution_ms ?? 0,
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
        const values = [...new Set(mainDataset.map((r) => String(r[col] ?? "")))].filter(Boolean);
        return { name: col, distinct: values.length, sample: values.slice(0, 8) };
      });
    }
    const filterableColumns = datasetColumns.filter((c) => c.distinct >= 2 && c.distinct <= 15);
    const useDataController = hasDataset && filterableColumns.length > 0;

    // Build image placeholder map: LLM uses placeholder keys, we replace with real base64
    const imagePlaceholders: Record<string, string> = {};
    for (const key of imageKeys) {
      imagePlaceholders[key] = `data:image/png;base64,${executionResult.images[key]}`;
    }

    // Describe chart_data shape (key names, column types, row counts, sample rows)
    // so the LLM can choose the right component without receiving full data arrays.
    function describeShape(val: unknown): unknown {
      if (Array.isArray(val)) {
        if (val.length === 0) return { _type: "array", rows: 0 };
        const sample = val.slice(0, 2);
        const first = val[0];
        if (typeof first === "object" && first !== null) {
          const cols: Record<string, string> = {};
          for (const [k, v] of Object.entries(first)) {
            cols[k] =
              typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
          }
          return { _type: "array", rows: val.length, columns: cols, sample };
        }
        return { _type: "array", rows: val.length, valueType: typeof first, sample };
      }
      if (typeof val === "object" && val !== null) {
        const described: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
          described[k] = describeShape(v);
        }
        return described;
      }
      return val; // scalars pass through
    }

    const chartDataShape = Object.fromEntries(
      Object.entries(executionResult.chart_data).map(([k, v]) => [k, describeShape(v)])
    );

    // Cap results at 30K chars — these are small scalar aggregations the LLM
    // needs verbatim for StatCard values and TextBlock content.
    function truncateValue(val: unknown, maxChars: number): unknown {
      if (Array.isArray(val)) {
        for (let limit = Math.min(val.length, 50); limit >= 5; limit = Math.floor(limit / 2)) {
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

    let userPrompt = `## Original Question
${question}

## Analysis Results
${JSON.stringify(compactResults)}

## Chart Data Shapes
Available keys and their shapes:
${JSON.stringify(chartDataShape, null, 2)}
${
  useDataController
    ? `
Use "$chartData:<key>" placeholders ONLY when pre-populating initial /computed/* state values so charts have data on first render. Charts themselves MUST use {"$state": "/computed/<name>"} for their data prop — never "$chartData:" in component props directly.
EXCEPTION: Globe3D and Surface3D do NOT support DataController. Use "$chartData:" placeholders directly in their props (points, arcs, z, x_labels, y_labels). Place Globe3D/Surface3D OUTSIDE any DataController wrapper.
For Globe3D: use "$chartData:<key>.points" for the points prop and "$chartData:<key>.arcs" for the arcs prop. Example: "points": "$chartData:globe.points", "arcs": "$chartData:globe.arcs".
For Surface3D: use "$chartData:<key>.z", "$chartData:<key>.x_labels", "$chartData:<key>.y_labels".`
    : `
When referencing chart data in component props, use the string "$chartData:<key>" as the data value. It will be replaced with the actual array at render time. For example: "data": "$chartData:scatter_data"
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
Filterable columns (categorical, <15 values): ${filterableColumns.map((c) => `${c.name} [${c.sample.join(", ")}]`).join("; ")}

Use a DataController component to enable instant client-side filtering. The full dataset is stored at /datasets/main in spec.state. Charts MUST read from /computed/* state paths using {"$state": "/computed/<name>"} for their data prop — NOT "$chartData:" placeholders.`;
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

    userPrompt += `

Compose a dashboard that answers the user's question. Choose the layout that best tells the data story — lead with the most impactful component. Interleave brief insights between visualizations for a narrative flow.`;

    const customRules = [
      "Do NOT fabricate large data arrays (e.g. GeoJSON boundaries, coordinate tables) that are not in the chart_data or results. Small scalar values from results (for StatCard, TextBlock, etc.) are fine to inline.",
      "Design the layout like a data infographic that flows top-to-bottom as a narrative. Lead with whatever is most impactful for the question — a chart, stat cards, or a key insight. TextBlock headings are optional, not required. Vary the opening by question type: comparisons can lead with a chart, trend questions with a line chart, summaries with stat cards. Interleave TextBlock (variant: insight) annotations between visualizations to narrate the story, rather than clustering all text at the end.",
      "Use StatCard for key metrics. Group them in a LayoutGrid (columns: 2-4).",
      "Use the appropriate chart type for the data shape.",
      "Add Annotation components for outliers, notable patterns, or caveats.",
      "Use TrendIndicator when comparing two time periods.",
      "Use ChartImage ONLY when images were generated in the sandbox (truly custom matplotlib visualizations).",
      "For distribution analysis, use Histogram (pass raw data rows + value_key, optional group_key for overlaid groups).",
      "For comparing distributions across groups, use BoxPlot (raw data rows + value_key + group_key) or ViolinChart (same props, shows density shape).",
      "For correlation matrices or 2D numeric grids, use HeatMap (z: number[][], x_labels, y_labels, show_values: true). Do NOT use ChartImage for correlation matrices.",
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
      "Use MapView when data contains geographic coordinates (lat/lng). Pass markers as [{lat, lng, label, color}]. Only pass geojson if GeoJSON geometry is present in the chart_data — do NOT fabricate or inline GeoJSON.",
      'Use Globe3D when data spans multiple countries or continents — flight routes, trade flows, global metrics. Wire props using $chartData placeholders: "points": "$chartData:<key>.points", "arcs": "$chartData:<key>.arcs". Do NOT wrap Globe3D in a DataController. Do NOT pass polygons unless the user explicitly asks for country boundary overlays — points and arcs are sufficient for most use cases. globe_style: "default" (blue marble), "night" (dark), "minimal" (topology).',
      "Use Map3D for dense geospatial data needing 3D aggregation. layer_type: 'hexagon' for hexagonal density, 'column' for extruded bars at locations, 'arc' for origin-destination flows, 'scatterplot' for points on map, 'heatmap' for density. Use instead of MapView when data has hundreds+ of points or needs aggregation.",
      "Use Scatter3D when there are three numeric variables to explore in 3D. Supports group_key for coloring by category and size_key for a 4th dimension.",
      "Use Surface3D for gridded 2D data that benefits from a 3D surface view (response surfaces, interpolated terrain). Similar to HeatMap but rendered as rotatable 3D surface.",
      "Prefer 2D charts (BarChart, LineChart, ScatterChart, etc.) when they communicate the data effectively. Only use 3D components when the third dimension adds real analytical value.",
      'For interactive scenario planners, what-if tools, or calculators where NumberInput changes should reactively update StatCard values, use DataController with source.fromState. This builds a reactive single-row dataset from scalar state paths. Example: {"type":"DataController","props":{"source":{"fromState":{"units":"/inputs/units","price":"/inputs/price","margin":"/inputs/margin"}},"filters":[],"pipeline":[{"op":"compute","column":"revenue","expression":"multiply(units, price)"},{"op":"compute","column":"profit","expression":"percentOf(revenue, margin)"}],"outputs":[{"statePath":"/computed/stats","format":"stats"}]}}. NumberInputs bind via $bindState to /inputs/* paths, StatCards read via {"$state":"/computed/stats/revenue"}. Set initial /inputs/* values in spec.state. Compute ops: multiply(a,b), add(a,b), subtract(a,b), percentOf(a,b)=a*b/100, percent(a,b)=a/b*100, ratio(a,b)=a/b, diff(a,b)=a-b.',
    ];

    const result = streamText({
      model: getModel(uiComposeModel),
      system: catalog.prompt({ customRules }),
      prompt: userPrompt,
      temperature: 0,
    });

    // Transform stream: strip markdown fences + replace image placeholders + inject datasets
    const textStream = result.textStream;
    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        let buffer = "";
        let stateInjected = false;
        let lineCount = 0;
        let closed = false;

        const emit = (data: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            closed = true;
          }
        };

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

          // Inject datasets.main into a JSON-Patch that sets /state
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
          emit(
            JSON.stringify({
              op: "add",
              path: "/state/datasets",
              value: { main: mainDataset },
            }) + "\n"
          );
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
