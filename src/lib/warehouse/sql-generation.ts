import { generateText } from "ai";
import { withPhase } from "@/lib/cost/accumulator";
import { getModel, cachedSystem, cachedText, getActiveProvider } from "@/lib/llm/client";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import { logger } from "@/lib/logger";
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
  bigquery: `Use Google BigQuery Standard SQL. Use backtick-quoted identifiers (\`project.dataset.table\`). Use LIMIT for row limits. Use APPROX_COUNT_DISTINCT for approximate counts. Date functions: DATE(), TIMESTAMP(), EXTRACT(). IMPORTANT: BigQuery does NOT support backslash escape sequences in strings or LIKE patterns. Do NOT use \\_  to escape underscores in LIKE — underscores are literal wildcard characters in LIKE. To match a literal underscore, use the LIKE ... ESCAPE clause (e.g., LIKE '%x_vendor' ESCAPE 'x') or use REGEXP_CONTAINS instead. To bound a scan, use a real DATE/TIMESTAMP column from the schema — do NOT filter on \`_PARTITIONTIME\`/\`_PARTITIONDATE\` unless the table is genuinely ingestion-time partitioned; on most tables those pseudo-columns are NULL for every row, so any comparison on them returns ZERO rows.`,
  clickhouse: `Use ClickHouse SQL syntax. Use backtick-quoted identifiers. Use LIMIT for row limits. Aggregation functions: countDistinct(), avg(), quantile(). Date functions: toDate(), toDateTime(), toYear(). IMPORTANT: When doing arithmetic (division, multiplication, percentage) on Decimal columns, ALWAYS cast operands to Float64 first using toFloat64() to avoid Decimal overflow errors. Example: toFloat64(price - open) / toFloat64(open) instead of (price - open) / open. ClickHouse does NOT support LATERAL joins or correlated subqueries in FROM/JOIN — a subquery in the FROM/JOIN list cannot reference columns from another table in the same query (errors "Lateral joins are not supported" / "Correlated column ... is found in the FROM clause"). To derive a value (e.g. a complexity bucket) from already-joined columns, compute it with multiIf()/CASE directly in the SELECT (or wrap the join in a subquery and compute it in the outer SELECT) — never via a CROSS JOIN to a subquery that references the other table's columns. Pre-aggregate each side in its OWN independent subquery, then JOIN them on key columns. Use HAVING (not a correlated subquery) to filter on aggregates. MEMORY (critical): a ClickHouse JOIN builds a hash table from the RIGHT table IN MEMORY, so joining two large row-level tables before aggregating hits "Query memory limit exceeded" (code 241). ALWAYS shrink each side in a subquery BEFORE the join: apply the WHERE filters AND aggregate to the join grain (e.g. collapse checks to one row per pull_request_number with anyIf/maxIf/countIf flags like "had a failed check") so you join compact per-key aggregates, not raw rows. Put the smaller / more-selectively-filtered table on the RIGHT of the JOIN. Never join raw fact tables and aggregate afterwards — aggregate first, then join. CO-OCCURRENCE / PAIRWISE ("which X occur together per group", "pairs that fail together"): do NOT self-join the fact table — that's a many-to-many explosion that times out. Instead collapse each group to a DISTINCT array first (\`SELECT group_key, groupUniqArray(item) AS items FROM ... GROUP BY group_key\`), then form pairs WITHIN each small array by ARRAY JOINing it twice with a \`<\` guard (\`... ARRAY JOIN items AS a ARRAY JOIN items AS b ... WHERE a < b GROUP BY a, b\`). This reads the table once and pairs only within each group, so it scales.`,
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
- AGGREGATES NEVER GO IN WHERE: WHERE filters raw rows BEFORE grouping, so an aggregate there is illegal (e.g. \`WHERE min(created_at) > ...\` or \`WHERE count(*) > 5\` errors with "Aggregate function ... found in WHERE" / illegal aggregation). To filter on an aggregate, use HAVING after GROUP BY (\`GROUP BY x HAVING count(*) > 5\`), or compute the aggregate in a subquery/CTE and filter it in an outer query. Use WHERE only for conditions on raw, non-aggregated columns.
- DON'T reference a SELECT alias in WHERE: a column you DEFINE in the SELECT list (e.g. \`dateDiff(...) AS resolution_seconds\`) cannot be used in that same query's WHERE, nor in an outer query whose subquery doesn't also SELECT it (errors with "Identifier ... cannot be resolved"). Either repeat the full expression in the WHERE, or expose the computed column from the subquery's SELECT and filter on it one level up.
- COST/TIMEOUT (critical): the warehouse enforces a ~60s timeout AND a hard cap on rows scanned. The table sizes are shown next to each table as \`~N rows\` — TREAT THEM AS REAL. For any table with millions+ of rows you MUST narrow the scan, not just the output: add a SELECTIVE WHERE on a date/time column or the table's primary/ORDER BY key, aggregate (GROUP BY) instead of returning raw rows, and select only the columns you need. Do NOT scan a billion-row table unfiltered — it will hit "Timeout exceeded" or "rows or bytes to read exceeded" and fail. The reliable way to bound the scan is a TIGHT bounded window on the partition/date key. Do NOT rely on \`SAMPLE\` (many tables reject it with "doesn't support sampling") or a \`cityHash64(...) % N\` filter (it still scans every row) — neither reduces the scan.
- NEVER add a \`SETTINGS\` clause (ClickHouse) or \`SET\` statement to raise limits like max_rows_to_read / max_execution_time / max_bytes_to_read — the connection may be READ-ONLY and it errors ("Cannot modify ... in readonly mode"). The only way to fit under the limits is a cheaper query.
- Always LIMIT results to at most 50000 rows to prevent excessive data transfer.
- If the question is ambiguous about which columns to use, prefer columns that seem most relevant based on their names and types.
- Handle NULLs appropriately (COALESCE, IS NOT NULL filters where sensible).
- For time-based questions, order by the date/time column.
- Return all columns that would be useful for visualization (don't over-aggregate — the analysis layer will handle charting).`;
}

/**
 * The schema half of the SQL-gen user prompt — identical across every
 * sub-question's SQL generation in an Investigate run, so it is sent as its own
 * cache breakpoint (the question is the variable tail). See prewarmSQLGenCache.
 */
function buildSQLGenSchemaBlock(
  tables: WarehouseTableSchema[],
  warehouseType: WarehouseType
): string {
  return `## Database Schema (${warehouseType})\n\n${formatTableSchemas(tables, warehouseType)}`;
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
  const result = await withPhase("sql_gen", () =>
    generateText({
      model: getModel(model),
      system: cachedSystem(buildSQLGenSystemPrompt(warehouseType)),
      messages: [
        {
          role: "user",
          content: [
            cachedText(buildSQLGenSchemaBlock(tables, warehouseType)),
            { type: "text", text: `\n\n## Question\n${question}` },
          ],
        },
      ],
      temperature: 0,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    })
  );

  return cleanSQL(result.text);
}

/**
 * Warm the SQL-gen prompt cache (system + the shared table-schema block) once
 * before an Investigate fans its sub-questions out in parallel. Without it,
 * each wave-0 sub-question's SQL generation cold-writes the table schema (none
 * can read another's in-flight write) and re-pays full input for it. After this,
 * the wave reads the warm cache. Anthropic-only and strictly best-effort — a
 * failed warm-up must never break the run. Mirrors prewarmCodeGenCache.
 */
export async function prewarmSQLGenCache(
  tables: WarehouseTableSchema[],
  warehouseType: WarehouseType,
  model: string = CODE_GEN_MODEL
): Promise<void> {
  if (getActiveProvider() !== "anthropic") return;
  try {
    await withPhase("prewarm", () =>
      generateText({
        model: getModel(model),
        system: cachedSystem(buildSQLGenSystemPrompt(warehouseType)),
        messages: [
          {
            role: "user",
            content: [
              cachedText(buildSQLGenSchemaBlock(tables, warehouseType)),
              { type: "text", text: "\n\n## Question\nwarmup" },
            ],
          },
        ],
        temperature: 0,
        maxOutputTokens: 1,
      })
    );
  } catch {
    // Best-effort: a failed warm-up must never break the run.
  }
}

/**
 * The repair-specific instructions + failed SQL + engine error. Sent as the
 * uncached tail AFTER the shared cached schema block, so it never disturbs the
 * cache prefix. Dialect notes are omitted here because the shared system prompt
 * (buildSQLGenSystemPrompt) already carries them.
 */
function buildSQLRepairInstructions(args: {
  question: string;
  failedSQL: string;
  error: string;
}): string {
  return `## Fix the failed query
The SQL below was generated against the schema above but FAILED to execute. Return a corrected query that runs and still answers the question.
- Output ONLY the corrected SQL query. No explanation, no markdown fencing, no comments.
- Address the SPECIFIC error reported. Common fixes: reference SELECT aliases (or repeat the full expression) in GROUP BY / window ORDER BY rather than raw columns that aren't grouped; quote/qualify identifiers correctly for the dialect; cast mismatched types; remove DDL/DML.
- "Aggregate function ... is found in WHERE" / ILLEGAL_AGGREGATION: an aggregate (min/max/count/sum/avg/quantile/...) is in a WHERE clause, which is illegal — WHERE runs before grouping. Move that condition to HAVING (after GROUP BY), or compute the aggregate in a subquery/CTE and filter it in an outer query. Keep WHERE for raw-column conditions only.
- "Lateral joins are not supported" / "Correlated column ... is found in the FROM clause" / NOT_IMPLEMENTED (ClickHouse): a subquery in FROM/JOIN references another table's columns. Remove the correlation: compute any derived value (e.g. a bucket) with multiIf()/CASE over the joined columns in the SELECT (or in an outer SELECT wrapping the join), and pre-aggregate each side in its own independent subquery joined on keys — never CROSS JOIN a subquery that reads the other table's columns.
- "Identifier ... cannot be resolved" / UNKNOWN_IDENTIFIER on a computed column: a SELECT alias is referenced in WHERE (same level) or in an outer query whose subquery doesn't SELECT it. Repeat the full expression in the filter, or add the computed column to the subquery's SELECT and filter one level up.
- "Timeout exceeded" / "Limit for rows or bytes to read exceeded" / "TOO_MANY_ROWS": the query scans too much data. The reliable fix is a TIGHTER bounded WHERE on the partition/date key — SHORTEN the time window (e.g. to a few recent months) and select fewer columns. Do NOT use \`SAMPLE\` (many tables reject it: "doesn't support sampling") and do NOT use a hash/modulo filter (\`cityHash64(...) % N\` still scans EVERY row — it does not reduce the scan). If this is a broad row pull, just narrow the date window (do NOT switch to a GROUP BY); if it's an aggregation, pre-filter to a tight window before grouping. Do NOT try to raise the limit.
- "Query memory limit exceeded" / MEMORY_LIMIT_EXCEEDED (code 241) or "Timeout": the query holds too much in memory / runs too long — almost always a JOIN of large row-level tables, or a high-cardinality GROUP BY. Restructure so you aggregate BEFORE joining: in each side's subquery, apply the WHERE filters and GROUP BY to the join grain (e.g. collapse the checks fact table to one row per pull_request_number with countIf/maxIf flags), then JOIN the compact per-key aggregates on keys. Put the smaller/more-filtered table on the RIGHT. For CO-OCCURRENCE / PAIRWISE counts ("pairs that fail together per commit/PR"), do NOT self-join the fact table — collapse each group to a DISTINCT array (\`groupUniqArray\`) then pair WITHIN each array via two ARRAY JOINs with a \`<\` guard. Tighten time/key filters and reduce GROUP BY cardinality. Do NOT raise the limit.
- "Cannot modify '<setting>' setting in readonly mode" / READONLY: REMOVE the \`SETTINGS\` clause / \`SET\` statement entirely. The connection is read-only — you cannot raise max_rows_to_read / max_execution_time. Instead make the query inherently cheaper (see above).
- "Unknown expression or function identifier": a column referenced in an outer query (e.g. inside an aggregate or window) isn't exposed by the subquery's SELECT, or isn't grouped. Add it to the inner SELECT / GROUP BY, or qualify it.
- "SQL query returned no results" / ZERO rows: the query executed FINE — your WHERE filter excluded ALL data. Do NOT just shift the time window by another increment; that almost always returns empty the same way. RECONSIDER THE FILTER itself: (a) is the date/partition column you filtered actually POPULATED in that range? Pick a different real date column from the schema, or widen the window a lot. (b) BigQuery: \`_PARTITIONTIME\` (and \`_PARTITIONDATE\`) are NULL on tables that are NOT ingestion-time partitioned, so ANY comparison on them returns zero rows — switch to a real date/timestamp column from the schema, or drop that partition filter entirely. (c) If you can't tell which window has data, REMOVE the speculative date filter and rely on LIMIT to bound the rows (the query already executed, so the scan size is fine).
- Keep it a single SELECT that returns a result set, LIMIT at most 50000 rows.

## Question
${args.question}

## Failed SQL
${args.failedSQL}

## Engine Error
${args.error}

Return the corrected SQL only.`;
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
  // Reuse the EXACT [system][schema] prefix that generateSQL / prewarmSQLGenCache
  // already cached — same cachedSystem(buildSQLGenSystemPrompt) and
  // cachedText(buildSQLGenSchemaBlock) — so a repair READS the warm schema cache
  // instead of re-sending the full table DDL uncached. (Dialect guidance lives in
  // that shared system prompt.) The repair-specific instructions, failed SQL, and
  // engine error are the uncached tail; they vary per repair.
  const result = await withPhase("sql_repair", () =>
    generateText({
      model: getModel(args.model ?? CODE_GEN_MODEL),
      system: cachedSystem(buildSQLGenSystemPrompt(args.warehouseType)),
      messages: [
        {
          role: "user",
          content: [
            cachedText(buildSQLGenSchemaBlock(args.tables, args.warehouseType)),
            { type: "text", text: `\n\n${buildSQLRepairInstructions(args)}` },
          ],
        },
      ],
      temperature: 0,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    })
  );
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
/**
 * Engine errors signalling the query is simply too expensive — a timeout, a
 * read-row cap, or a memory cap. These reflect the query's SHAPE/scale, not a
 * fixable mistake, so re-prompting just repeats them. Callers that already have
 * a fallback (per-step escalation) can bail on these instead of burning the
 * repair budget on more multi-minute timeouts.
 */
export function isResourceLimitError(message: string): boolean {
  return /timeout|rows or bytes to read exceeded|too_many_rows|memory limit exceeded|memory_limit_exceeded/i.test(
    message
  );
}

export async function generateSQLWithRepair<T>(args: {
  tables: WarehouseTableSchema[];
  question: string;
  warehouseType: WarehouseType;
  execute: (sql: string) => Promise<T>;
  model?: string;
  maxRepairs?: number;
  /**
   * Stop immediately (don't repair) on a resource-limit error — timeout / rows /
   * memory. Use when the caller has a fallback and repairs can't help (e.g. the
   * window is already bounded, so the cost is the query shape). Logic errors
   * still repair as normal.
   */
  bailOnResourceError?: boolean;
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
      const message = err instanceof Error ? err.message : String(err);
      // Surface the exact SQL that failed — otherwise we can only infer query
      // shape (self-join? dropped filter?) from the engine error and row counts.
      logger.warn("Warehouse SQL attempt failed", {
        attempt,
        question: args.question.slice(0, 120),
        error: message.slice(0, 200),
        sql,
      });
      if (args.bailOnResourceError && isResourceLimitError(message)) {
        logger.warn("Warehouse SQL hit a resource limit; not repairing (query too expensive)", {
          question: args.question.slice(0, 120),
          error: message.slice(0, 120),
        });
        break;
      }
      if (attempt === maxRepairs) break;
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
