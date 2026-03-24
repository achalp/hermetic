import { generateText } from "ai";
import { getModel } from "@/lib/llm/client";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { WarehouseType, WarehouseTableSchema } from "@/lib/types";

/**
 * Build a description of all warehouse tables for the SQL generation prompt.
 */
function formatTableSchemas(tables: WarehouseTableSchema[], warehouseType: WarehouseType): string {
  return tables
    .map((t) => {
      const cols = t.columns
        .map((c) => `  ${c.name} ${c.type}${c.nullable ? " NULL" : " NOT NULL"}`)
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
      } else if (warehouseType === "hive") {
        tableName = `\`${t.schema}\`.\`${t.name}\``;
      } else {
        tableName = `${t.schema}.${t.name}`;
      }

      return `${tableName}${rowNote}\n(\n${cols}${constraints ? "\n" + constraints : ""}\n)`;
    })
    .join("\n\n");
}

const DIALECT_NOTES: Record<WarehouseType, string> = {
  postgresql: `Use PostgreSQL syntax. Use double quotes for identifiers if needed. Use :: for type casts. Use LIMIT for row limits.`,
  bigquery: `Use Google BigQuery Standard SQL. Use backtick-quoted identifiers (\`project.dataset.table\`). Use LIMIT for row limits. Use APPROX_COUNT_DISTINCT for approximate counts. Date functions: DATE(), TIMESTAMP(), EXTRACT().`,
  clickhouse: `Use ClickHouse SQL syntax. Use backtick-quoted identifiers. Use LIMIT for row limits. Aggregation functions: countDistinct(), avg(), quantile(). Date functions: toDate(), toDateTime(), toYear(). IMPORTANT: When doing arithmetic (division, multiplication, percentage) on Decimal columns, ALWAYS cast operands to Float64 first using toFloat64() to avoid Decimal overflow errors. Example: toFloat64(price - open) / toFloat64(open) instead of (price - open) / open.`,
  trino: `Use Trino (Presto) SQL syntax. Use double quotes for identifiers. Use catalog.schema.table fully qualified names. Use LIMIT for row limits. Use APPROX_DISTINCT for approximate counts. Cast with CAST(x AS type). Date functions: date(), current_date, date_trunc(). String: concat(), substr(). Arrays: ARRAY[], UNNEST().`,
  hive: `Use HiveQL syntax. Use backtick-quoted identifiers. Use LIMIT for row limits. String concat: concat(). Date functions: to_date(), date_format(), datediff(). No INTERSECT or EXCEPT. For exploding arrays use LATERAL VIEW EXPLODE. Use CAST to avoid integer division. Subqueries in WHERE are supported but correlated subqueries are limited.`,
};

function buildSQLGenSystemPrompt(warehouseType: WarehouseType): string {
  return `You are a SQL expert. Given a natural language question and a database schema, generate a single SQL query that answers the question.

## Rules
- Output ONLY the SQL query. No explanation, no markdown fencing, no comments.
- ${DIALECT_NOTES[warehouseType]}
- The query MUST return a result set (SELECT statement). Never write DDL/DML.
- Include appropriate JOINs when the question requires data from multiple tables. Use the foreign key relationships provided.
- Use aggregations (GROUP BY, COUNT, SUM, AVG) when the question asks for summaries.
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
    system: buildSQLGenSystemPrompt(warehouseType),
    prompt: buildSQLGenUserPrompt(tables, question, warehouseType),
    temperature: 0,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });

  return cleanSQL(result.text);
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

  return sql.trim();
}
