import { generateText } from "ai";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { WarehouseType, WarehouseTableSchema } from "@/lib/types";

/**
 * Build a description of all warehouse tables for the SQL generation prompt.
 */
function formatTableSchemas(tables: WarehouseTableSchema[], warehouseType: WarehouseType): string {
  return tables
    .map((t) => {
      const cols = t.columns
        .map((c) => {
          const baseLine = `  ${c.name} ${c.type}${c.nullable ? " NULL" : " NOT NULL"}`;
          // Append column description as inline SQL comment when dbt-enriched
          if (c.description) {
            const oneLineDesc = c.description.replace(/\s+/g, " ").trim().slice(0, 200);
            return `${baseLine}  -- ${oneLineDesc}`;
          }
          return baseLine;
        })
        .join("\n");

      const pk = t.primary_key?.length ? `  PRIMARY KEY (${t.primary_key.join(", ")})` : "";

      // For FK references, use fully qualified table names for BigQuery
      const fks = t.foreign_keys?.length
        ? t.foreign_keys
            .map((fk) => {
              const refTable =
                warehouseType === "bigquery"
                  ? `\`${t.schema}.${fk.references_table}\``
                  : fk.references_table;
              return `  FOREIGN KEY (${fk.column}) REFERENCES ${refTable}(${fk.references_column})`;
            })
            .join("\n")
        : "";

      const constraints = [pk, fks].filter(Boolean).join("\n");
      const rowNote =
        t.row_count_estimate > 0 ? ` -- ~${t.row_count_estimate.toLocaleString()} rows` : "";

      // Use fully qualified names with proper quoting per dialect
      let tableName: string;
      if (warehouseType === "bigquery") {
        tableName = `\`${t.schema}.${t.name}\``;
      } else if (warehouseType === "trino") {
        // Trino uses "catalog"."schema"."table" — schema field contains "catalog.schema"
        tableName = `"${t.schema}"."${t.name}"`;
      } else if (warehouseType === "hive" || warehouseType === "databricks") {
        // Databricks uses three-part names; schema field is "catalog.schema"
        tableName = `\`${t.schema}\`.\`${t.name}\``;
      } else if (warehouseType === "snowflake") {
        // Snowflake identifiers are case-sensitive when quoted; we render unquoted
        // (uppercase) so the LLM produces SQL that matches whatever the model server returns.
        tableName = `${t.schema}.${t.name}`;
      } else {
        tableName = `${t.schema}.${t.name}`;
      }

      // Render table-level dbt description as a SQL comment block above the CREATE
      const tableComment = t.description
        ? `-- ${t.description.replace(/\s+/g, " ").trim().slice(0, 400)}\n`
        : "";

      return `${tableComment}${tableName}${rowNote}\n(\n${cols}${constraints ? "\n" + constraints : ""}\n)`;
    })
    .join("\n\n");
}

const DIALECT_NOTES: Record<WarehouseType, string> = {
  postgresql: `Use PostgreSQL syntax. Use double quotes for identifiers if needed. Use :: for type casts. Use LIMIT for row limits.`,
  bigquery: `Use Google BigQuery Standard SQL. Use backtick-quoted identifiers (\`project.dataset.table\`). Use LIMIT for row limits. Use APPROX_COUNT_DISTINCT for approximate counts. Date functions: DATE(), TIMESTAMP(), EXTRACT(). IMPORTANT: BigQuery does NOT support backslash escape sequences in strings or LIKE patterns. Do NOT use \\_  to escape underscores in LIKE — underscores are literal wildcard characters in LIKE. To match a literal underscore, use the LIKE ... ESCAPE clause (e.g., LIKE '%x_vendor' ESCAPE 'x') or use REGEXP_CONTAINS instead.`,
  clickhouse: `Use ClickHouse SQL syntax. Use backtick-quoted identifiers. Use LIMIT for row limits. Aggregation functions: countDistinct(), avg(), quantile(). Date functions: toDate(), toDateTime(), toYear(). IMPORTANT: When doing arithmetic (division, multiplication, percentage) on Decimal columns, ALWAYS cast operands to Float64 first using toFloat64() to avoid Decimal overflow errors. Example: toFloat64(price - open) / toFloat64(open) instead of (price - open) / open.`,
  trino: `Use Trino (Presto) SQL syntax. Use double quotes for identifiers. Use catalog.schema.table fully qualified names. Use LIMIT for row limits. Use APPROX_DISTINCT for approximate counts. Cast with CAST(x AS type). Date functions: date(), current_date, date_trunc(). String: concat(), substr(). Arrays: ARRAY[], UNNEST().`,
  hive: `Use HiveQL syntax. Use backtick-quoted identifiers. Use LIMIT for row limits. String concat: concat(). Date functions: to_date(), date_format(), datediff(). No INTERSECT or EXCEPT. For exploding arrays use LATERAL VIEW EXPLODE. Use CAST to avoid integer division. Subqueries in WHERE are supported but correlated subqueries are limited.`,
  snowflake: `Use Snowflake SQL. Identifiers default to UPPERCASE unless double-quoted. Use LIMIT for row limits. Use QUALIFY for window-function filtering. Use IFF(a, b, c) instead of IF. Date functions: TO_DATE(), DATEADD(unit, n, date), DATE_TRUNC(part, expr). String: ||, CONCAT(), SUBSTR(). Use APPROX_COUNT_DISTINCT for approximate counts. Variant/object functions: GET_PATH(), FLATTEN(). For percentile: PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY col).`,
  databricks: `Use Databricks SQL (Spark SQL flavor with Unity Catalog). Use three-part names \`catalog\`.\`schema\`.\`table\` for cross-schema queries. Identifiers in backticks. Use LIMIT for row limits. Date functions: date_trunc('unit', col), date_format(col, 'pattern'), date_add(col, n). Array functions: explode(), array_contains(). Use APPROX_COUNT_DISTINCT for approximate counts. PERCENTILE/PERCENTILE_APPROX for percentiles. No QUALIFY — use a subquery with ROW_NUMBER instead. String concat: concat() or ||.`,
};

function buildSQLGenSystemPrompt(warehouseType: WarehouseType): string {
  return `You are a SQL expert. Given a natural language question and a database schema, generate a single SQL query that answers the question.

## Rules
- Output ONLY the SQL query. No explanation, no markdown fencing, no comments.
- ${DIALECT_NOTES[warehouseType]}
- The query MUST return a result set (SELECT statement). Never write DDL/DML.
- Include appropriate JOINs when the question requires data from multiple tables. Use the foreign key relationships provided.
- Use aggregations (GROUP BY, COUNT, SUM, AVG) when the question asks for summaries.
- WINDOW FUNCTIONS with GROUP BY: when you combine an aggregate query (GROUP BY) with a window function (LAG/LEAD/ROW_NUMBER/SUM() OVER ...), every column inside the window's PARTITION BY / ORDER BY must be a GROUP BY column, an aggregate, or a SELECT alias — NOT a raw column. Common failure: \`LAG(COUNT(*)) OVER (ORDER BY EXTRACT(YEAR FROM created_at))\` errors because \`created_at\` isn't grouped. Fix: GROUP BY the period expression and order the window by it, e.g. \`... GROUP BY EXTRACT(YEAR FROM created_at) AS yr ... LAG(COUNT(*)) OVER (ORDER BY yr)\` (repeat the expression if the dialect rejects the alias).
- COST/TIMEOUT (critical): the warehouse enforces a ~60s timeout AND a hard cap on rows scanned. The table sizes are shown next to each table as \`~N rows\` — TREAT THEM AS REAL. For any table with millions+ of rows you MUST narrow the scan, not just the output: add a SELECTIVE WHERE on a date/time column or the table's primary/ORDER BY key, aggregate (GROUP BY) instead of returning raw rows, and select only the columns you need. Do NOT scan a billion-row table unfiltered — it will hit "Timeout exceeded" or "rows or bytes to read exceeded" and fail. For exploratory aggregates over a very large ClickHouse table, prefer a tight time window or the \`SAMPLE\` clause.
- NEVER add a \`SETTINGS\` clause (ClickHouse) or \`SET\` statement to raise limits like max_rows_to_read / max_execution_time / max_bytes_to_read — the connection may be READ-ONLY and it errors ("Cannot modify ... in readonly mode"). The only way to fit under the limits is a cheaper query.
- Always LIMIT results to at most 50000 rows to prevent excessive data transfer.
- If the question is ambiguous about which columns to use, prefer columns that seem most relevant based on their names and types.
- Handle NULLs appropriately (COALESCE, IS NOT NULL filters where sensible).
- For time-based questions, order by the date/time column.
- Return all columns that would be useful for visualization (don't over-aggregate — the analysis layer will handle charting).`;
}

function buildSQLGenUserPrompt(
  tables: WarehouseTableSchema[],
  question: string,
  warehouseType: WarehouseType
): string {
  const schemaText = formatTableSchemas(tables, warehouseType);
  return `## Database Schema (${warehouseType})\n\n${schemaText}\n\n## Question\n${question}`;
}

/**
 * Generate a SQL query from a natural language question using the LLM.
 */
export async function generateSQL(
  tables: WarehouseTableSchema[],
  question: string,
  warehouseType: WarehouseType,
  model: string = CODE_GEN_MODEL
): Promise<string> {
  const result = await generateText({
    model: getModel(model),
    system: cachedSystem(buildSQLGenSystemPrompt(warehouseType)),
    prompt: buildSQLGenUserPrompt(tables, question, warehouseType),
    temperature: 0,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });

  return cleanSQL(result.text);
}

/**
 * Repair a SQL query that failed to execute by feeding the exact engine
 * error back to the LLM. Returns a corrected query (best-effort — the caller
 * decides whether to re-execute or give up).
 */
export async function repairSQL(args: {
  tables: WarehouseTableSchema[];
  question: string;
  warehouseType: WarehouseType;
  failedSQL: string;
  error: string;
  model?: string;
}): Promise<string> {
  const schemaText = formatTableSchemas(args.tables, args.warehouseType);
  const result = await generateText({
    model: getModel(args.model ?? CODE_GEN_MODEL),
    system:
      cachedSystem(`You are a SQL expert. A query you generated failed to execute. Fix it so it runs and still answers the question.

## Rules
- Output ONLY the corrected SQL query. No explanation, no markdown fencing, no comments.
- ${DIALECT_NOTES[args.warehouseType]}
- Address the SPECIFIC error reported. Common fixes: reference SELECT aliases (or repeat the full expression) in GROUP BY / window ORDER BY rather than raw columns that aren't grouped; quote/qualify identifiers correctly for the dialect; cast mismatched types; remove DDL/DML.
- "Timeout exceeded" / "Limit for rows or bytes to read exceeded" / "TOO_MANY_ROWS": the query scans too much data. Make it CHEAPER — add or tighten a WHERE filter on a date/time column or the primary/ORDER BY key, shorten the time window, aggregate (GROUP BY) instead of returning raw rows, select fewer columns, or (ClickHouse) add a \`SAMPLE\` clause. Do NOT try to raise the limit.
- "Cannot modify '<setting>' setting in readonly mode" / READONLY: REMOVE the \`SETTINGS\` clause / \`SET\` statement entirely. The connection is read-only — you cannot raise max_rows_to_read / max_execution_time. Instead make the query inherently cheaper (see above).
- "Unknown expression or function identifier": a column referenced in an outer query (e.g. inside an aggregate or window) isn't exposed by the subquery's SELECT, or isn't grouped. Add it to the inner SELECT / GROUP BY, or qualify it.
- Keep it a single SELECT that returns a result set, LIMIT at most 50000 rows.`),
    prompt: `## Database Schema (${args.warehouseType})\n\n${schemaText}\n\n## Question\n${args.question}\n\n## Failed SQL\n${args.failedSQL}\n\n## Engine Error\n${args.error}\n\nReturn the corrected SQL only.`,
    temperature: 0,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });
  return cleanSQL(result.text);
}

/**
 * Generate SQL and execute it, repairing on failure. `execute` runs the query
 * against the warehouse and resolves with the result (e.g. CSV content) or
 * rejects with the engine error. On rejection we feed the error back to the
 * LLM (`repairSQL`) and retry, up to `maxRepairs` times. Returns the SQL that
 * finally worked alongside its result; throws the last error if all attempts
 * fail.
 */
export async function generateSQLWithRepair<T>(args: {
  tables: WarehouseTableSchema[];
  question: string;
  warehouseType: WarehouseType;
  execute: (sql: string) => Promise<T>;
  model?: string;
  maxRepairs?: number;
  onAttempt?: (attempt: number, phase: "generating" | "executing" | "repairing") => void;
}): Promise<{ sql: string; result: T }> {
  const maxRepairs = args.maxRepairs ?? 2;
  args.onAttempt?.(0, "generating");
  let sql = await generateSQL(args.tables, args.question, args.warehouseType, args.model);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    try {
      args.onAttempt?.(attempt, "executing");
      const result = await args.execute(sql);
      return { sql, result };
    } catch (err) {
      lastError = err;
      if (attempt === maxRepairs) break;
      const message = err instanceof Error ? err.message : String(err);
      args.onAttempt?.(attempt + 1, "repairing");
      sql = await repairSQL({
        tables: args.tables,
        question: args.question,
        warehouseType: args.warehouseType,
        failedSQL: sql,
        error: message,
        model: args.model,
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Strip markdown fencing and whitespace from LLM output */
function cleanSQL(raw: string): string {
  let sql = raw.trim();

  // Extract from markdown code block if present
  const fenceMatch = sql.match(/```(?:sql)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    sql = fenceMatch[1];
  } else {
    if (sql.startsWith("```sql")) sql = sql.slice("```sql".length);
    else if (sql.startsWith("```")) sql = sql.slice("```".length);
    if (sql.endsWith("```")) sql = sql.slice(0, -"```".length);
  }

  // Strip chat template tokens
  sql = sql.replace(/<\|im_end\|>/g, "");
  sql = sql.replace(/<\|im_start\|>[^\n]*/g, "");
  sql = sql.replace(/<\|end\|>/g, "");

  // ClickHouse: the LLM sometimes appends `SETTINGS max_rows_to_read=...` to dodge
  // the read limits. On a read-only connection (e.g. the public playground) that
  // errors with "Cannot modify '<setting>' setting in readonly mode". Drop a
  // trailing SETTINGS clause that touches the read-limit knobs — the right fix is
  // a cheaper query, not a raised ceiling.
  sql = sql.replace(
    /\s+SETTINGS\s+[^;]*\b(?:max_rows_to_read|max_bytes_to_read|max_execution_time|max_result_rows|max_result_bytes|readonly)\b[^;]*$/i,
    ""
  );

  return sql.trim();
}
