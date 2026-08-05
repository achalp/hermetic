import { generateText } from "ai";
import { withPhase } from "@/lib/cost/accumulator";
import { getModel, cachedSystem, cachedText, getActiveProvider } from "@/lib/llm/client";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS, WAREHOUSE_LARGE_JOIN_ROWS } from "@/lib/constants";
import { checkAggregateInputLimit, checkUnboundedLargeJoin } from "@/lib/warehouse/sql-guard";
import { logger } from "@/lib/logger";
import type { ConversationTurn } from "@/lib/contracts/storage-types";
import type { WarehouseType } from "@/lib/contracts/connection-configs";
import type { WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";
import { ENGINES } from "@/lib/warehouse/engine-descriptor";

/**
 * Build a description of all warehouse tables for the SQL generation prompt.
 */
function formatTableSchemas(tables: WarehouseTableSchema[], warehouseType: WarehouseType): string {
  const engine = ENGINES[warehouseType];
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
              const refTable = engine.qualifyFkRefs
                ? engine.promptTableName(t.schema, fk.references_table)
                : fk.references_table;
              return `  FOREIGN KEY (${fk.column}) REFERENCES ${refTable}(${fk.references_column})`;
            })
            .join("\n")
        : "";

      const constraints = [pk, fks].filter(Boolean).join("\n");
      const rowNote =
        t.row_count_estimate > 0 ? ` -- ~${t.row_count_estimate.toLocaleString()} rows` : "";

      // Fully qualified name with the engine's quoting (see engine-descriptor)
      const tableName = engine.promptTableName(t.schema, t.name);

      // Render table-level dbt description as a SQL comment block above the CREATE
      const tableComment = t.description
        ? `-- ${t.description.replace(/\s+/g, " ").trim().slice(0, 400)}\n`
        : "";

      return `${tableComment}${tableName}${rowNote}\n(\n${cols}${constraints ? "\n" + constraints : ""}\n)`;
    })
    .join("\n\n");
}

function buildSQLGenSystemPrompt(warehouseType: WarehouseType): string {
  return `You are a SQL expert. Given a natural language question and a database schema, generate a single SQL query that answers the question.

## Rules
- Output ONLY the SQL query. No explanation, no markdown fencing, no comments.
- ${ENGINES[warehouseType].dialectNotes}
- The query MUST return a result set (SELECT statement). Never write DDL/DML.
- Include appropriate JOINs when the question requires data from multiple tables. Use the foreign key relationships provided.
- Use aggregations (GROUP BY, COUNT, SUM, AVG) when the question asks for summaries.
- WINDOW FUNCTIONS with GROUP BY: when you combine an aggregate query (GROUP BY) with a window function (LAG/LEAD/ROW_NUMBER/SUM() OVER ...), every column inside the window's PARTITION BY / ORDER BY must be a GROUP BY column, an aggregate, or a SELECT alias — NOT a raw column. Common failure: \`LAG(COUNT(*)) OVER (ORDER BY EXTRACT(YEAR FROM created_at))\` errors because \`created_at\` isn't grouped. Fix: GROUP BY the period expression and order the window by it, e.g. \`... GROUP BY EXTRACT(YEAR FROM created_at) AS yr ... LAG(COUNT(*)) OVER (ORDER BY yr)\` (repeat the expression if the dialect rejects the alias).
- AGGREGATES NEVER GO IN WHERE: WHERE filters raw rows BEFORE grouping, so an aggregate there is illegal (e.g. \`WHERE min(created_at) > ...\` or \`WHERE count(*) > 5\` errors with "Aggregate function ... found in WHERE" / illegal aggregation). To filter on an aggregate, use HAVING after GROUP BY (\`GROUP BY x HAVING count(*) > 5\`), or compute the aggregate in a subquery/CTE and filter it in an outer query. Use WHERE only for conditions on raw, non-aggregated columns.
- DON'T reference a SELECT alias in WHERE: a column you DEFINE in the SELECT list (e.g. \`dateDiff(...) AS resolution_seconds\`) cannot be used in that same query's WHERE, nor in an outer query whose subquery doesn't also SELECT it (errors with "Identifier ... cannot be resolved"). Either repeat the full expression in the WHERE, or expose the computed column from the subquery's SELECT and filter on it one level up.
- COST/TIMEOUT (critical): the warehouse enforces a ~60s timeout AND a hard cap on rows scanned. The table sizes are shown next to each table as \`~N rows\` — TREAT THEM AS REAL. For any table with millions+ of rows you MUST narrow the scan, not just the output: add a SELECTIVE WHERE on a date/time column or the table's primary/ORDER BY key, aggregate (GROUP BY) instead of returning raw rows, and select only the columns you need. Do NOT scan a billion-row table unfiltered — it will hit "Timeout exceeded" or "rows or bytes to read exceeded" and fail. The reliable way to bound the scan is a TIGHT bounded window on the partition/date key. Do NOT rely on \`SAMPLE\` (many tables reject it with "doesn't support sampling") or a \`cityHash64(...) % N\` filter (it still scans every row) — neither reduces the scan.
- SCALE THE ALGORITHM FIRST, SHRINK THE DATA LAST. When a query is too expensive, make it CHEAPER BY DESIGN before you narrow what it covers — narrowing the scope (a smaller region / shorter window / one category the user did NOT ask for) changes the ANSWER and is a last resort, not the first move. Concretely:
  • Never CROSS JOIN or self-join a large table for an all-pairs / nearest-neighbor / pairwise-distance / pairwise-similarity / co-occurrence / dedup computation — that is O(n²) and will never finish. BUCKET first, then join only WITHIN a bucket and its immediate neighbors: for GEO, group points into grid cells (round lat/lng to a cell size, or S2_CELLIDFROMPOINT) and compare a cell against itself + the 8 adjacent cells; for non-geo, bucket on the natural join/group key. This turns O(n²) into ~O(n·k). CRITICAL — a grid self-join is only O(n·k) if k (points per cell) is BOUNDED: a FIXED geographic cell size (e.g. 0.05°/~5km) is a trap because a within-cell self-join is still O(n²) INSIDE each cell, and a dense-urban cell (downtown LA/SF) holds hundreds of thousands of buildings → that one cell alone is hundreds of billions of ST_DISTANCE pairs and runs for HOURS (measured: a 0.05° grid over California buildings hit BigQuery's 6-hour job limit). Pick a cell size that keeps the DENSEST cell small, or cap per-cell work. And for a "most isolated / farthest / loneliest" question specifically: the answer is by definition in a SPARSE area, so an INNER self-join that only keeps buildings WITH a neighbor in range silently DROPS the exact candidates you want (the query's own analysis_scope admitting "buildings >5km away may not be resolved" is the tell it's answering the wrong question). Restrict the expensive pairwise work to buildings in LOW-COUNT cells (compute per-cell counts first, keep only sparse cells — dense-cell buildings cannot be the most isolated), then find each survivor's nearest neighbor with an EXPANDING search radius so a genuinely isolated building's true NN distance is measured, not dropped. (Honest note: whole-region nearest-neighbor is a poor fit for warehouse SQL — if this keeps timing out, say so in analysis_scope rather than returning a grid-truncated answer as if exact.)
  • Pre-AGGREGATE to the grain you need (GROUP BY) before any JOIN, so you join compact per-key summaries, not raw rows.
  • Use APPROXIMATE functions for large-cardinality work (APPROX_COUNT_DISTINCT, APPROX_QUANTILES / quantile estimators) instead of exact ones.
  • Push ALL filtering / grouping / windowing into the warehouse; return only the small result.
  Only after the algorithm is genuinely scalable — and it still exceeds the limits — may you bound the DATA scope, and if you do you MUST disclose it (see the scope-disclosure rule).
- NEVER add a \`SETTINGS\` clause (ClickHouse) or \`SET\` statement to raise limits like max_rows_to_read / max_execution_time / max_bytes_to_read — the connection may be READ-ONLY and it errors ("Cannot modify ... in readonly mode"). The only way to fit under the limits is a cheaper query.
- Always LIMIT results to at most 50000 rows to prevent excessive data transfer.
- LIMIT CAPS OUTPUT ONLY — NEVER SAMPLE THE INPUT OF A GLOBAL COMPUTATION. Putting a LIMIT on the rows that FEED an aggregate, a global max/min, a "farthest / nearest / most / least"-type extremum, a nearest-neighbor or pairwise distance, a ranking, a dedup, or a percentile CHANGES THE ANSWER — you compute the extremum over an arbitrary partial set, not the real one, and return a confidently WRONG result. A final \`LIMIT 1\`/\`LIMIT 100\` on the OUTPUT ranking is fine; a \`LIMIT\` inside the subquery/CTE that the computation reads is not. If such a query is too expensive to run over the full table, make the SCOPE cheaper with a WHERE the QUESTION implies (a named region, a recent time window) — do NOT invent an arbitrary bound the user never asked for (e.g. silently restricting a global "which building is farthest from its neighbor" to one city's bounding box). If you cannot answer the question correctly under the cost limits, return the honestly-scoped answer and make the scope explicit in a column/value rather than passing off a sample as the global answer.
- SCOPE / METHOD DISCLOSURE: if — after scaling the algorithm — you STILL bound the DATA to less than the question asks (a region / time window / subset the user did not specify, to fit cost limits), OR you compute the answer with a scalable METHOD that introduces a boundary or approximation (a bounded search radius, grid-resolution rounding, an approximate function), you MUST make it visible in the OUTPUT: add a constant column \`analysis_scope\` whose value is a short human-readable description of what you restricted / the method used and why (e.g. \`'Computed within lat 63–67, lng −25 to −13 (global scan exceeded the byte limit)'\` or \`'Nearest neighbor via 1km spatial grid; buildings whose nearest neighbor is >1km away are not resolved' AS analysis_scope\`). Add it ONLY when you actually narrowed scope or introduced an approximation — never for an exact answer at the scope the question specified. This lets the answer say what it actually covers instead of pretending to be exact/global.
- If the question is ambiguous about which columns to use, prefer columns that seem most relevant based on their names and types.
- Handle NULLs appropriately (COALESCE, IS NOT NULL filters where sensible).
- For time-based questions, order by the date/time column.
- Return all columns that would be useful for visualization (don't over-aggregate — the analysis layer will handle charting).
- Output EXACTLY ONE SQL query and NOTHING else — no prose, no explanation, no alternative/"smarter" second query, no "let me try instead". Decide on the single best query and emit only that. Extra prose or a second query corrupts execution.`;
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

/** Per-turn cap so one giant prior query can't crowd out the schema/question. */
const HISTORY_SQL_MAX_CHARS = 4000;

/**
 * Conversation history for follow-up SQL generation. The critical payload is
 * each prior turn's QUESTION (resolves "that"/"those" and carries implicit
 * constraints forward) and its SQL (the exact record of tables, joins,
 * filters, and scan window that produced what the user is referencing) — so a
 * follow-up becomes a minimal edit of a known-good query rather than a fresh
 * blind derivation over the wrong population. Rides the un-cached prompt tail
 * (next to the question), never the cached schema block.
 */
export function buildSQLHistorySection(turns: ConversationTurn[] | undefined): string {
  if (!turns || turns.length === 0) return "";
  const formatted = turns
    .map((turn, i) => {
      const lines = [`### Turn ${i + 1}: "${turn.question}"`];
      if (turn.sql) {
        const sql =
          turn.sql.length > HISTORY_SQL_MAX_CHARS
            ? `${turn.sql.slice(0, HISTORY_SQL_MAX_CHARS)}\n-- …truncated…`
            : turn.sql;
        lines.push("SQL that produced this turn's result:", "```sql", sql, "```");
      }
      return lines.join("\n");
    })
    .join("\n\n");
  return `## Prior Queries (same conversation)
The user is asking a follow-up question. Earlier turns against this warehouse:

${formatted}

Resolve references like "that" / "those" / "the same" against the turns above. Treat the MOST RECENT turn's SQL as the baseline population: PRESERVE its filters, joins, and time window unless the new question explicitly changes them, and prefer a minimal edit of that SQL (new grouping, measure, or cut) over a fresh derivation — silently dropping an inherited constraint answers a different question than the one asked.

`;
}

/**
 * Generate a SQL query from a natural language question using the LLM.
 * `priorTurns` (follow-ups) ride the variable tail with the question.
 */
export async function generateSQL(
  tables: WarehouseTableSchema[],
  question: string,
  warehouseType: WarehouseType,
  model: string = CODE_GEN_MODEL,
  priorTurns?: ConversationTurn[]
): Promise<string> {
  const historySection = buildSQLHistorySection(priorTurns);
  const result = await withPhase("sql_gen", () =>
    generateText({
      model: getModel(model),
      system: cachedSystem(buildSQLGenSystemPrompt(warehouseType)),
      messages: [
        {
          role: "user",
          content: [
            cachedText(buildSQLGenSchemaBlock(tables, warehouseType)),
            { type: "text", text: `\n\n${historySection}## Question\n${question}` },
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
async function repairSQL(args: {
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
function isResourceLimitError(message: string): boolean {
  return /timeout|rows or bytes to read exceeded|too_many_rows|memory limit exceeded|memory_limit_exceeded/i.test(
    message
  );
}

/**
 * Errors signalling the LOCAL machine lost its network connection to the
 * warehouse API — not a SQL mistake, so regenerating the query cannot help and
 * re-running just fails the same way. Matches the driver/SDK fetch-failure
 * shapes: gaxios "Cannot connect to API" / "Failed after N attempts", a bare
 * "request to <url> failed, reason:" (empty reason = socket died), and the
 * usual node network codes. The dominant cause is the laptop idle-sleeping
 * mid-query (the outbound poll's socket drops), which the sandbox wake lock
 * covers for Docker runs but not for warehouse queries — hence bailing with a
 * clear message beats burning the repair budget on a dead network.
 */
function isConnectivityError(message: string): boolean {
  return /Cannot connect to API|Failed after \d+ attempts|request to .+ failed, reason:|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network (?:error|is unreachable)/i.test(
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
  /** Follow-up context: prior questions + their SQL (see buildSQLHistorySection).
   *  Repairs don't need it re-sent — the generated SQL already encodes the intent. */
  priorTurns?: ConversationTurn[];
  onAttempt?: (attempt: number, phase: "generating" | "executing" | "repairing") => void;
}): Promise<{ sql: string; result: T }> {
  const maxRepairs = args.maxRepairs ?? 2;
  args.onAttempt?.(0, "generating");
  let sql = await generateSQL(
    args.tables,
    args.question,
    args.warehouseType,
    args.model,
    args.priorTurns
  );
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    try {
      // Pre-execution guards: reject a wrong-but-valid query the engine would run
      // happily, deterministically, so the repair loop fixes it BEFORE we spend a
      // warehouse query. (1) an aggregate over an unordered-LIMIT sample; (2) a
      // CROSS / non-equi / self join over a large base table (O(n²) — won't scale).
      const guardMsg =
        (!/\bselect\b/i.test(sql)
          ? "You returned an explanation / reasoning, not a SQL query. Respond with ONLY the SQL — no preamble, no commentary, no plan. Start at SELECT or WITH."
          : null) ??
        checkAggregateInputLimit(sql) ??
        checkUnboundedLargeJoin(sql, args.tables, WAREHOUSE_LARGE_JOIN_ROWS);
      if (guardMsg) throw new Error(guardMsg);

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
      // A lost network connection is never a SQL bug — repairing/re-running
      // just fails the same way (and the repair's own LLM call needs the same
      // dead network). Bail immediately with a message that names the real
      // cause instead of a cryptic driver string. Not gated on any flag:
      // regenerating SQL can NEVER fix connectivity.
      if (isConnectivityError(message)) {
        logger.warn("Warehouse query lost network connectivity; not repairing", {
          warehouseType: args.warehouseType,
          error: message.slice(0, 160),
        });
        throw new Error(
          `Lost the network connection to the ${args.warehouseType} API mid-query — the query was not completed. This usually means the machine slept or the network dropped. Reconnect and re-run. (${message.slice(0, 120)})`
        );
      }
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

  // Strip leading natural-language reasoning before the query. Models sometimes
  // prepend a paragraph ("I need to find ... I'll sample ...") ahead of the SQL;
  // unfenced, that whole thing becomes the query and fails with "Unexpected
  // identifier". If the text doesn't already begin with a SQL statement, slice
  // from the first line that starts one (WITH / SELECT). No-op when clean.
  // A real statement start: SELECT, or WITH followed by a CTE shape (`WITH name
  // AS (` / `WITH RECURSIVE`). The CTE shape matters — English prose like "With
  // 2.5 billion rows, ..." starts with "With" but is NOT a WITH clause, and
  // mis-slicing it made the whole paragraph run as SQL ("Unexpected ... '2.5'").
  const STMT_START = /(?:^|\n)[ \t]*(SELECT\b[\s\S]*|WITH\s+(?:RECURSIVE\s+)?[A-Za-z_"`][\s\S]*)$/i;
  const CTE_SHAPE = /^\s*WITH\s+(?:RECURSIVE\s+)?[A-Za-z_"`][\w"`.]*\s+AS\s*\(/i;
  if (!/^\s*SELECT\b/i.test(sql) && !CTE_SHAPE.test(sql)) {
    const m = sql.match(STMT_START);
    // Only accept a WITH-start if it's an actual CTE, not the word "With".
    if (m && (/^\s*SELECT\b/i.test(m[1]) || CTE_SHAPE.test(m[1]))) sql = m[1];
  }

  // Keep only the FIRST statement. Models sometimes emit a query, then reasoning,
  // then a second "smarter" query ("...LIMIT 1\n\nThis is still a cross-join. Let
  // me...\n\nSELECT ..."). Both queries + the prose become one string and fail
  // ("Expected end of input"). Split on blank lines and keep the leading blocks
  // that continue the SQL (a clause keyword, a closing paren/comma, or set-op);
  // stop at the first block that is prose or a NEW statement (bare SELECT/WITH).
  const blocks = sql.split(/\n[ \t]*\n/);
  if (blocks.length > 1) {
    const continues =
      /^\s*(?:FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AND|OR|UNION|EXCEPT|INTERSECT|QUALIFY|WINDOW|\)|,)\b/i;
    const kept = [blocks[0]];
    for (let k = 1; k < blocks.length; k++) {
      if (continues.test(blocks[k])) kept.push(blocks[k]);
      else break; // prose or a second statement — drop it and everything after
    }
    sql = kept.join("\n\n");
  }

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

/** Test seam. */
export const __testing = { cleanSQL };
