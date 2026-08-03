/**
 * Per-engine descriptor — the single registry of everything that varies by
 * warehouse engine EXCEPT the driver itself (ARCH-12).
 *
 * Adding an engine used to touch ~10 files, half of them easy to miss: the
 * SQL-gen dialect notes and prompt table-naming (sql-generation.ts), the
 * sample-query quoting (api/warehouse/sample), the saved-connection label
 * (persist-env.ts), and display names + brand colors duplicated across three
 * UI components. Each was its own switch/record with nothing enforcing that
 * a new WarehouseType covered them all.
 *
 * Now: `ENGINES` is an exhaustive Record<WarehouseType, EngineDescriptor> —
 * adding a member to the WarehouseType union without a descriptor entry is a
 * type error, and every consumer reads from here.
 *
 * New-engine checklist (the remaining touch points, in order):
 *   1. types.ts — add the config interface + WarehouseType union member
 *   2. api-schemas.ts — add the zod config schema to the discriminated union
 *   3. lib/warehouse/<engine>.ts — the connector (driver) module
 *   4. lib/warehouse/connector.ts — one case in the factory switch
 *      (kept separate from this file: the factory imports node-only drivers,
 *      this module stays client-safe for the UI components)
 *   5. THIS FILE — one ENGINES entry (dialect notes, naming, label, color)
 *   6. persist-env.ts loadLegacyFromEnv — only if env-var bootstrap is wanted
 *   7. The connection form UI (warehouse-connect-panel / inline-connection-
 *      form) — per-engine form fields remain hand-built, the one seam this
 *      registry does not cover
 *
 * This module is CLIENT-SAFE: no node imports (UI components read
 * displayName/brandColor from it).
 */
import type { WarehouseConnectionConfig, WarehouseType } from "@/lib/contracts/connection-configs";

type ConfigOf<K extends WarehouseType> = Extract<WarehouseConnectionConfig, { type: K }>;

export interface EngineDescriptor<K extends WarehouseType = WarehouseType> {
  /** Human name for tabs/cards ("PostgreSQL", "BigQuery", …). */
  displayName: string;
  /** Brand dot color for connection cards/lists. */
  brandColor: string;
  /** One-line label for a saved connection ("Snowflake: acct/db"). */
  connectionLabel(config: ConfigOf<K>): string;
  /**
   * `SELECT * … LIMIT 5` with the engine's identifier quoting — the table
   * preview query. `table` may be a qualified name ("schema.table").
   */
  sampleQuery(table: string): string;
  /**
   * Fully-qualified quoted table name as rendered into the SQL-generation
   * prompt's schema block. `schema` may itself be qualified (Trino/Databricks
   * carry "catalog.schema" in the schema field).
   */
  promptTableName(schema: string, name: string): string;
  /**
   * Whether FOREIGN KEY references in the prompt's schema block should be
   * rendered fully qualified via promptTableName (BigQuery) or left as the
   * bare referenced-table name (everyone else).
   */
  qualifyFkRefs: boolean;
  /** Dialect guidance injected into the SQL-generation system prompt. */
  dialectNotes: string;
  /**
   * The connection form, declaratively (M5-5g): the per-engine form UI and
   * the config coercion both derive from this — closing the audit's "engine
   * fields enumerated in N places" seam. Adding an engine = one ENGINES
   * entry; the form renders itself.
   */
  fields: readonly EngineFieldSpec[];
}

export interface EngineFieldSpec {
  /** Config property this field populates. */
  key: string;
  input: "text" | "password" | "number" | "textarea" | "checkbox" | "select";
  /** Placeholder (inputs) or label (checkbox/select). */
  placeholder: string;
  /** Default true for non-checkbox fields. */
  required?: boolean;
  /** Select options. */
  options?: readonly string[];
  /**
   * Value coercion when building the config:
   * - "number": Number(v) || fallback
   * - "optional": trimmed value or undefined
   * - "fallback": value || fallback
   * (default: string passthrough; checkbox passes boolean through)
   */
  coerce?: "number" | "optional" | "fallback";
  fallback?: string | number;
}

const quoteDouble = (t: string) => `"${t.replace(/"/g, '""')}"`;
const quoteBacktick = (t: string) => `\`${t.replace(/`/g, "\\`")}\``;

export const ENGINES: { [K in WarehouseType]: EngineDescriptor<K> } = {
  postgresql: {
    displayName: "PostgreSQL",
    brandColor: "#3b82f6",
    connectionLabel: (c) => `PostgreSQL: ${c.host}/${c.database}`,
    sampleQuery: (table) => `SELECT * FROM ${quoteDouble(table)} LIMIT 5`,
    promptTableName: (schema, name) => `${schema}.${name}`,
    qualifyFkRefs: false,
    dialectNotes: `Use PostgreSQL syntax. Use double quotes for identifiers if needed. Use :: for type casts. Use LIMIT for row limits.`,
    fields: [
      { key: "host", input: "text", placeholder: "Host (e.g. localhost)" },
      {
        key: "port",
        input: "number",
        placeholder: "Port (default 5432)",
        required: false,
        coerce: "number",
        fallback: 5432,
      },
      { key: "database", input: "text", placeholder: "Database (e.g. mydb)" },
      { key: "user", input: "text", placeholder: "User (e.g. postgres)" },
      { key: "password", input: "password", placeholder: "Password" },
      { key: "ssl", input: "checkbox", placeholder: "SSL (check for cloud databases)" },
      {
        key: "schema",
        input: "text",
        placeholder: "Schema (optional, default 'public')",
        required: false,
        coerce: "optional",
      },
    ],
  },
  bigquery: {
    displayName: "BigQuery",
    brandColor: "#f59e0b",
    connectionLabel: (c) => `BigQuery: ${c.projectId}.${c.dataset}`,
    sampleQuery: (table) => `SELECT * FROM ${quoteBacktick(table)} LIMIT 5`,
    promptTableName: (schema, name) => `\`${schema}.${name}\``,
    qualifyFkRefs: true,
    dialectNotes: `Use Google BigQuery Standard SQL. Use backtick-quoted identifiers (\`project.dataset.table\`). Use LIMIT for row limits. Use APPROX_COUNT_DISTINCT for approximate counts. Date functions: DATE(), TIMESTAMP(), EXTRACT(). IMPORTANT: BigQuery does NOT support backslash escape sequences in strings or LIKE patterns. Do NOT use \\_  to escape underscores in LIKE — underscores are literal wildcard characters in LIKE. To match a literal underscore, use the LIKE ... ESCAPE clause (e.g., LIKE '%x_vendor' ESCAPE 'x') or use REGEXP_CONTAINS instead. To bound a scan, use a real DATE/TIMESTAMP column from the schema — do NOT filter on \`_PARTITIONTIME\`/\`_PARTITIONDATE\` unless the table is genuinely ingestion-time partitioned; on most tables those pseudo-columns are NULL for every row, so any comparison on them returns ZERO rows. GEOGRAPHY: a \`geometry\` column is often a POLYGON, not a point. ST_X / ST_Y require a single POINT and error on a polygon ("Argument to ST_X must be a single point geography") — wrap with ST_CENTROID(geom) first: ST_X(ST_CENTROID(geom)). ST_DISTANCE works on any geographies (polygons included), so use it directly; only point-EXTRACTION (ST_X/ST_Y) needs ST_CENTROID.`,
    fields: [
      { key: "projectId", input: "text", placeholder: "Project ID (e.g. my-gcp-project)" },
      {
        key: "dataset",
        input: "text",
        placeholder: "Dataset (e.g. analytics or bigquery-public-data.stackoverflow)",
      },
      {
        key: "credentialsJson",
        input: "textarea",
        placeholder: "Service Account JSON (paste full key file contents)",
      },
    ],
  },
  clickhouse: {
    displayName: "ClickHouse",
    brandColor: "#10b981",
    connectionLabel: (c) => `ClickHouse: ${c.host}/${c.database}`,
    sampleQuery: (table) => `SELECT * FROM ${quoteBacktick(table)} LIMIT 5`,
    promptTableName: (schema, name) => `${schema}.${name}`,
    qualifyFkRefs: false,
    dialectNotes: `Use ClickHouse SQL syntax. Use backtick-quoted identifiers. Use LIMIT for row limits. Aggregation functions: countDistinct(), avg(), quantile(). Date functions: toDate(), toDateTime(), toYear(). IMPORTANT: When doing arithmetic (division, multiplication, percentage) on Decimal columns, ALWAYS cast operands to Float64 first using toFloat64() to avoid Decimal overflow errors. Example: toFloat64(price - open) / toFloat64(open) instead of (price - open) / open. ClickHouse does NOT support LATERAL joins or correlated subqueries in FROM/JOIN — a subquery in the FROM/JOIN list cannot reference columns from another table in the same query (errors "Lateral joins are not supported" / "Correlated column ... is found in the FROM clause"). To derive a value (e.g. a complexity bucket) from already-joined columns, compute it with multiIf()/CASE directly in the SELECT (or wrap the join in a subquery and compute it in the outer SELECT) — never via a CROSS JOIN to a subquery that references the other table's columns. Pre-aggregate each side in its OWN independent subquery, then JOIN them on key columns. Use HAVING (not a correlated subquery) to filter on aggregates. MEMORY (critical): a ClickHouse JOIN builds a hash table from the RIGHT table IN MEMORY, so joining two large row-level tables before aggregating hits "Query memory limit exceeded" (code 241). ALWAYS shrink each side in a subquery BEFORE the join: apply the WHERE filters AND aggregate to the join grain (e.g. collapse checks to one row per pull_request_number with anyIf/maxIf/countIf flags like "had a failed check") so you join compact per-key aggregates, not raw rows. Put the smaller / more-selectively-filtered table on the RIGHT of the JOIN. Never join raw fact tables and aggregate afterwards — aggregate first, then join. CO-OCCURRENCE / PAIRWISE ("which X occur together per group", "pairs that fail together"): do NOT self-join the fact table — that's a many-to-many explosion that times out. Instead collapse each group to a DISTINCT array first (\`SELECT group_key, groupUniqArray(item) AS items FROM ... GROUP BY group_key\`), then form pairs WITHIN each small array by ARRAY JOINing it twice with a \`<\` guard (\`... ARRAY JOIN items AS a ARRAY JOIN items AS b ... WHERE a < b GROUP BY a, b\`). This reads the table once and pairs only within each group, so it scales.`,
    fields: [
      { key: "host", input: "text", placeholder: "Host (e.g. play.clickhouse.com)" },
      {
        key: "port",
        input: "number",
        placeholder: "Port (8123 for HTTP, 443 for HTTPS)",
        required: false,
        coerce: "number",
        fallback: 8123,
      },
      { key: "database", input: "text", placeholder: "Database (e.g. default)" },
      { key: "user", input: "text", placeholder: "User (e.g. default or play)" },
      {
        key: "password",
        input: "password",
        placeholder: "Password (empty for playground)",
        required: false,
      },
      { key: "ssl", input: "checkbox", placeholder: "SSL (required for port 443)" },
    ],
  },
  trino: {
    displayName: "Trino",
    brandColor: "#8b5cf6",
    connectionLabel: (c) => `Trino: ${c.host}/${c.catalog}.${c.schema}`,
    sampleQuery: (table) => `SELECT * FROM ${quoteDouble(table)} LIMIT 5`,
    // Trino uses "catalog"."schema"."table" — schema field contains "catalog.schema"
    promptTableName: (schema, name) => `"${schema}"."${name}"`,
    qualifyFkRefs: false,
    dialectNotes: `Use Trino (Presto) SQL syntax. Use double quotes for identifiers. Use catalog.schema.table fully qualified names. Use LIMIT for row limits. Use APPROX_DISTINCT for approximate counts. Cast with CAST(x AS type). Date functions: date(), current_date, date_trunc(). String: concat(), substr(). Arrays: ARRAY[], UNNEST().`,
    fields: [
      { key: "host", input: "text", placeholder: "Host (e.g. localhost)" },
      {
        key: "port",
        input: "number",
        placeholder: "Port (default 8080)",
        required: false,
        coerce: "number",
        fallback: 8080,
      },
      { key: "user", input: "text", placeholder: "User (e.g. trino)" },
      { key: "catalog", input: "text", placeholder: "Catalog (e.g. hive)" },
      {
        key: "schema",
        input: "text",
        placeholder: "Schema (default 'default')",
        required: false,
        coerce: "fallback",
        fallback: "default",
      },
      {
        key: "password",
        input: "password",
        placeholder: "Password (optional)",
        required: false,
        coerce: "optional",
      },
      { key: "ssl", input: "checkbox", placeholder: "SSL" },
    ],
  },
  hive: {
    displayName: "Hive",
    brandColor: "#d97706",
    connectionLabel: (c) => `Hive: ${c.host}/${c.database}`,
    sampleQuery: (table) => `SELECT * FROM ${quoteBacktick(table)} LIMIT 5`,
    promptTableName: (schema, name) => `\`${schema}\`.\`${name}\``,
    qualifyFkRefs: false,
    dialectNotes: `Use HiveQL syntax. Use backtick-quoted identifiers. Use LIMIT for row limits. String concat: concat(). Date functions: to_date(), date_format(), datediff(). No INTERSECT or EXCEPT. For exploding arrays use LATERAL VIEW EXPLODE. Use CAST to avoid integer division. Subqueries in WHERE are supported but correlated subqueries are limited.`,
    fields: [
      { key: "host", input: "text", placeholder: "Host (e.g. hiveserver2.example.com)" },
      {
        key: "port",
        input: "number",
        placeholder: "Port (default 10000)",
        required: false,
        coerce: "number",
        fallback: 10000,
      },
      {
        key: "database",
        input: "text",
        placeholder: "Database (default 'default')",
        required: false,
        coerce: "fallback",
        fallback: "default",
      },
      { key: "user", input: "text", placeholder: "User (e.g. hive)" },
      {
        key: "password",
        input: "password",
        placeholder: "Password (optional)",
        required: false,
        coerce: "optional",
      },
      {
        key: "auth",
        input: "select",
        placeholder: "Auth method",
        options: ["NONE", "NOSASL", "LDAP", "KERBEROS"],
      },
    ],
  },
  snowflake: {
    displayName: "Snowflake",
    brandColor: "#29b5e8",
    connectionLabel: (c) => `Snowflake: ${c.account}/${c.database}`,
    // Snowflake unquoted identifiers are uppercased; pass through as-is and let
    // the SQL parser handle case. Quote with double-quotes when caller already
    // provided a qualified name like "db.schema.table".
    sampleQuery: (table) => `SELECT * FROM ${table} LIMIT 5`,
    // Snowflake identifiers are case-sensitive when quoted; we render unquoted
    // (uppercase) so the LLM produces SQL that matches whatever the model server returns.
    promptTableName: (schema, name) => `${schema}.${name}`,
    qualifyFkRefs: false,
    dialectNotes: `Use Snowflake SQL. Identifiers default to UPPERCASE unless double-quoted. Use LIMIT for row limits. Use QUALIFY for window-function filtering. Use IFF(a, b, c) instead of IF. Date functions: TO_DATE(), DATEADD(unit, n, date), DATE_TRUNC(part, expr). String: ||, CONCAT(), SUBSTR(). Use APPROX_COUNT_DISTINCT for approximate counts. Variant/object functions: GET_PATH(), FLATTEN(). For percentile: PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY col).`,
    fields: [
      { key: "account", input: "text", placeholder: "Account (e.g. abc12345.us-east-1)" },
      { key: "user", input: "text", placeholder: "User" },
      { key: "password", input: "password", placeholder: "Password" },
      { key: "database", input: "text", placeholder: "Database (e.g. SNOWFLAKE_SAMPLE_DATA)" },
      {
        key: "schema",
        input: "text",
        placeholder: "Schema (optional, default 'PUBLIC')",
        required: false,
        coerce: "optional",
      },
      {
        key: "warehouse",
        input: "text",
        placeholder: "Warehouse (optional, e.g. COMPUTE_WH)",
        required: false,
        coerce: "optional",
      },
      {
        key: "role",
        input: "text",
        placeholder: "Role (optional, e.g. ANALYST)",
        required: false,
        coerce: "optional",
      },
    ],
  },
  databricks: {
    displayName: "Databricks",
    brandColor: "#ff3621",
    connectionLabel: (c) => `Databricks: ${c.serverHostname}/${c.catalog}`,
    // Databricks (Spark SQL) prefers backticks for three-part Unity Catalog names.
    sampleQuery: (table) => `SELECT * FROM ${quoteBacktick(table)} LIMIT 5`,
    // Databricks uses three-part names; schema field is "catalog.schema"
    promptTableName: (schema, name) => `\`${schema}\`.\`${name}\``,
    qualifyFkRefs: false,
    dialectNotes: `Use Databricks SQL (Spark SQL flavor with Unity Catalog). Use three-part names \`catalog\`.\`schema\`.\`table\` for cross-schema queries. Identifiers in backticks. Use LIMIT for row limits. Date functions: date_trunc('unit', col), date_format(col, 'pattern'), date_add(col, n). Array functions: explode(), array_contains(). Use APPROX_COUNT_DISTINCT for approximate counts. PERCENTILE/PERCENTILE_APPROX for percentiles. No QUALIFY — use a subquery with ROW_NUMBER instead. String concat: concat() or ||.`,
    fields: [
      {
        key: "serverHostname",
        input: "text",
        placeholder: "Server hostname (e.g. abc-123.cloud.databricks.com)",
      },
      {
        key: "httpPath",
        input: "text",
        placeholder: "HTTP path (e.g. /sql/1.0/warehouses/abc123)",
      },
      { key: "token", input: "password", placeholder: "Personal Access Token (dapi...)" },
      { key: "catalog", input: "text", placeholder: "Catalog (Unity Catalog, e.g. samples)" },
      {
        key: "schema",
        input: "text",
        placeholder: "Schema (optional, default 'default')",
        required: false,
        coerce: "optional",
      },
    ],
  },
};

/**
 * Label for any config — the union-correlation helper. TS can't prove that
 * ENGINES[config.type]'s parameter matches config's narrowed type across the
 * two unions; this is the single cast chokepoint.
 */
export function connectionLabel(config: WarehouseConnectionConfig): string {
  const label = ENGINES[config.type].connectionLabel as (c: WarehouseConnectionConfig) => string;
  return label(config);
}
