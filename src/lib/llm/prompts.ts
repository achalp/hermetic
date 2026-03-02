import type {
  CSVSchema,
  CSVColumn,
  SchemaMode,
  NumericMeta,
  DateMeta,
  CategoricalMeta,
  BooleanMeta,
} from "@/lib/types";
import { MAX_SAMPLE_ROWS } from "@/lib/constants";

// ── Column metadata formatter ─────────────────────────────────────

function formatColumnMeta(col: CSVColumn): string {
  const nullSuffix =
    col.null_count > 0 ? ` [${col.null_count} nulls]` : "";
  const m = col.meta;

  switch (m.kind) {
    case "number": {
      const tags: string[] = [];
      if (m.is_integer) tags.push("integer");
      else tags.push(`float(${m.decimal_precision}dp)`);
      if (m.is_currency) tags.push(`currency: ${m.currency_symbol ?? "?"}`);
      if (m.is_percentage) tags.push("percentage");
      tags.push(`range: [${m.min}, ${m.max}]`);
      tags.push(`mean: ${m.mean}`);
      tags.push(`median: ${m.median}`);
      tags.push(`std: ${m.std_dev}`);
      tags.push(`p25: ${m.p25}`);
      tags.push(`p75: ${m.p75}`);
      if (m.zero_count > 0) tags.push(`zeros: ${m.zero_count}`);
      if (m.negative_count > 0) tags.push(`negatives: ${m.negative_count}`);
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "date": {
      const tags: string[] = [];
      tags.push(`format: ${m.format}`);
      tags.push(`range: [${m.min_date}, ${m.max_date}]`);
      tags.push(`granularity: ${m.granularity}`);
      if (m.has_time) tags.push("has time");
      if (m.uses_month_names) tags.push("month names");
      if (m.uses_day_names) tags.push("day names");
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "categorical": {
      const tags: string[] = [];
      if (m.is_unique) {
        tags.push(
          `unique per row (${m.distinct_count} distinct)`
        );
      } else {
        tags.push(`${m.distinct_count} distinct`);
      }
      if (m.distinct_values) {
        tags.push(`[${m.distinct_values.join(", ")}]`);
      } else if (m.top_values) {
        const topStr = m.top_values
          .map((t) => `${t.value}(${t.count})`)
          .join(", ");
        tags.push(`top: ${topStr}`);
      }
      if (m.detected_pattern) tags.push(`pattern: ${m.detected_pattern}`);
      tags.push(
        `lengths: avg=${m.avg_length}, max=${m.max_length}`
      );
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "boolean": {
      return `- ${col.name} (${col.dtype}) — ${m.representation}: ${m.true_count} true, ${m.false_count} false${nullSuffix}`;
    }
  }
}

// ── Column sample formatter (legacy) ──────────────────────────────

function formatColumnSample(col: CSVColumn): string {
  const nullSuffix =
    col.null_count > 0 ? ` [${col.null_count} nulls]` : "";
  return `- ${col.name} (${col.dtype}) — sample: ${col.sample_values.join(", ")}${nullSuffix}`;
}

// ── Format columns based on mode ──────────────────────────────────

function formatColumns(schema: CSVSchema, mode: SchemaMode): string {
  if (mode === "sample") {
    return schema.columns.map((col) => formatColumnSample(col)).join("\n");
  }
  return schema.columns.map((col) => formatColumnMeta(col)).join("\n");
}

// ── System prompt ─────────────────────────────────────────────────

export function buildCodeGenSystemPrompt(mode: SchemaMode): string {
  const metadataNote =
    mode === "metadata"
      ? "\n- Column metadata (types, statistics, distributions, patterns) is provided instead of sample data. Use this metadata to understand value ranges, formats, and data characteristics."
      : "";

  return `You are a data analyst. You will be given a CSV schema and a user question.

Your job is to write a single Python script that:
1. Reads the CSV from "/data/input.csv"
2. Performs the necessary analysis using pandas, numpy, scipy
3. Writes a single JSON object to the file "/data/output.json" with this exact structure:
   {
     "results": { ... },       // computed values, aggregations, statistics
     "chart_data": { ... },    // objects with arrays formatted for chart components
     "images": { "key": "base64..." },  // any matplotlib/seaborn output (optional)
     "datasets": { "main": [ ... ] }    // the working dataset as row objects (up to 5000 rows)
   }

Rules:
- IMPORTANT: Only use data that exists in the CSV. Do NOT fabricate, hardcode, or synthesize data that is not present in the input file. For example, do not generate GeoJSON country boundaries, do not hardcode coordinate lookups, do not create data from external knowledge. Every value in chart_data must be derived from the CSV columns.${metadataNote}
- Use pandas for all data manipulation.
- For charts that the UI can handle natively (bar, line, area, pie, scatter, histogram, box plot, heatmap, violin), return the data as JSON under chart_data. Do NOT generate matplotlib for these.
- For histograms: return raw numeric data rows under chart_data so the client can bin them. Include the value column and any grouping column.
- For box plots: return raw data rows with the value column and grouping column under chart_data.
- For heatmaps/correlation matrices: return {z: number[][], x_labels: string[], y_labels: string[]} under chart_data.
- For violin plots: return raw data rows with the value column and grouping column under chart_data.
- For 3D scatter plots (Scatter3D): return rows with x, y, z numeric columns plus optional group and size columns under chart_data.
- For 3D surface plots (Surface3D): return {z: number[][], x_labels: [...], y_labels: [...]} under chart_data (same format as heatmap).
- For Globe3D: return {points: [{lat, lng, label, size}], arcs: [{start_lat, start_lng, end_lat, end_lng, label}]} under chart_data. Do NOT generate or fetch country boundary GeoJSON polygons — the globe already shows earth imagery.
- For Map3D: return rows with lat/lng columns plus value/category columns under chart_data.
- Use matplotlib/seaborn ONLY for truly custom visualizations that cannot be expressed with the above chart types. Save as base64 PNG.
- Always handle missing values gracefully.
- Do NOT use print() at all. Write the final JSON output to "/data/output.json" using: json.dump(output, open("/data/output.json", "w"), default=str, allow_nan=False). Replace NaN/None values in DataFrames before serialization: df = df.fillna("") or df = df.where(df.notna(), None).
- Do not install packages. Available: pandas, numpy, scipy, matplotlib, seaborn, scikit-learn.
- Always include datasets.main in the output: the working DataFrame converted to row-objects via df.head(5000).to_dict(orient="records"). This enables client-side interactive filtering. If you filter the data for the analysis, use the ORIGINAL unfiltered DataFrame for datasets.main.
- Output ONLY the Python code. No markdown fencing, no explanation.`;
}

// ── Synthetic sample row generation ───────────────────────────────

function generateSyntheticValues(col: CSVColumn, count: number): string[] {
  const m = col.meta;

  switch (m.kind) {
    case "number":
      return generateSyntheticNumeric(m, count);
    case "date":
      return generateSyntheticDate(m, count);
    case "categorical":
      return generateSyntheticCategorical(m, count);
    case "boolean":
      return generateSyntheticBoolean(m, count);
  }
}

function generateSyntheticNumeric(m: NumericMeta, count: number): string[] {
  // Use percentile spread: min, p25, median, p75, max
  const spread = [m.min, m.p25, m.median, m.p75, m.max];
  const values = spread.slice(0, count);
  // Pad if needed
  while (values.length < count) {
    values.push(m.mean);
  }

  return values.map((v) => {
    let s = m.is_integer ? String(Math.round(v)) : v.toFixed(m.decimal_precision);
    if (m.is_currency && m.currency_symbol) s = `${m.currency_symbol}${s}`;
    if (m.is_percentage) s = `${s}%`;
    return s;
  });
}

function generateSyntheticDate(m: DateMeta, count: number): string[] {
  const minTs = Date.parse(m.min_date);
  const maxTs = Date.parse(m.max_date);
  if (isNaN(minTs) || isNaN(maxTs)) {
    return Array(count).fill(m.min_date || "2024-01-01");
  }

  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? minTs : minTs + (maxTs - minTs) * (i / (count - 1));
    const d = new Date(t);
    // Format based on detected format
    if (m.format.includes("HH:mm:ss")) {
      values.push(d.toISOString().replace("T", " ").slice(0, 19));
    } else if (m.format.includes("HH:mm")) {
      values.push(d.toISOString().replace("T", " ").slice(0, 16));
    } else {
      values.push(d.toISOString().split("T")[0]);
    }
  }
  return values;
}

function generateSyntheticCategorical(m: CategoricalMeta, count: number): string[] {
  // Pick from known values
  let pool: string[] = [];
  if (m.distinct_values && m.distinct_values.length > 0) {
    pool = m.distinct_values;
  } else if (m.top_values && m.top_values.length > 0) {
    pool = m.top_values.map((t) => t.value);
  }

  if (pool.length === 0) {
    // Fallback based on pattern
    if (m.detected_pattern === "email") pool = ["user1@example.com", "user2@example.com", "user3@example.com"];
    else if (m.detected_pattern === "url") pool = ["https://example.com/a", "https://example.com/b"];
    else if (m.detected_pattern === "uuid") pool = ["550e8400-e29b-41d4-a716-446655440000"];
    else pool = ["value_1", "value_2", "value_3", "value_4", "value_5"];
  }

  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    values.push(pool[i % pool.length]);
  }
  return values;
}

function generateSyntheticBoolean(m: BooleanMeta, count: number): string[] {
  let trueVal: string;
  let falseVal: string;
  switch (m.representation) {
    case "0/1":
      trueVal = "1";
      falseVal = "0";
      break;
    case "yes/no":
      trueVal = "yes";
      falseVal = "no";
      break;
    default:
      trueVal = "true";
      falseVal = "false";
  }

  // Ratio-based distribution
  const total = m.true_count + m.false_count;
  const trueRatio = total > 0 ? m.true_count / total : 0.5;
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    values.push(i / count < trueRatio ? trueVal : falseVal);
  }
  return values;
}

function generateSyntheticRows(schema: CSVSchema): Record<string, string>[] {
  const count = MAX_SAMPLE_ROWS;

  // Generate synthetic values per column
  const columnValues: Record<string, string[]> = {};
  for (const col of schema.columns) {
    columnValues[col.name] = generateSyntheticValues(col, count);
  }

  // Assemble into rows
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, string> = {};
    for (const col of schema.columns) {
      row[col.name] = columnValues[col.name][i];
    }
    rows.push(row);
  }
  return rows;
}

// ── Data section based on mode ────────────────────────────────────

function formatDataSection(schema: CSVSchema, mode: SchemaMode): string {
  if (mode === "sample") {
    const sampleRowsJson = JSON.stringify(schema.sample_rows.slice(0, MAX_SAMPLE_ROWS), null, 2);
    return `\n## Sample Rows\n${sampleRowsJson}`;
  }

  const syntheticRows = generateSyntheticRows(schema);
  const syntheticJson = JSON.stringify(syntheticRows, null, 2);
  return `\n## Sample Rows\n${syntheticJson}`;
}

// ── User prompt (initial query) ───────────────────────────────────

export function buildCodeGenUserPrompt(
  schema: CSVSchema,
  question: string,
  mode: SchemaMode = "metadata"
): string {
  const columnDescriptions = formatColumns(schema, mode);

  return `## CSV Schema
Filename: ${schema.filename}
Rows: ${schema.row_count}
Columns:
${columnDescriptions}
${formatDataSection(schema, mode)}

## Question
${question}`;
}

// ── User prompt (chat follow-up) ──────────────────────────────────

export function buildCodeGenChatPrompt(
  schema: CSVSchema,
  question: string,
  history: string[],
  mode: SchemaMode = "metadata"
): string {
  const columnDescriptions = formatColumns(schema, mode);

  const historySection =
    history.length > 0
      ? `## Conversation Context
The user has asked the following questions in this conversation (most recent last):
${history.map((q, i) => `${i + 1}. ${q}`).join("\n")}

The current question may be a follow-up. Consider previous questions for context (e.g. "change that to a bar chart" refers to the previous analysis, "also show trends" means add to what was discussed).

`
      : "";

  return `${historySection}## CSV Schema
Filename: ${schema.filename}
Rows: ${schema.row_count}
Columns:
${columnDescriptions}
${formatDataSection(schema, mode)}

## Question
${question}`;
}

// ── Retry prompt ──────────────────────────────────────────────────

export function buildRetryPrompt(originalCode: string, error: string): string {
  return `Your previous code failed with this error:

\`\`\`
${error}
\`\`\`

Here was your code:
\`\`\`python
${originalCode}
\`\`\`

Fix the code and return only the corrected Python script. No markdown fencing, no explanation.`;
}
