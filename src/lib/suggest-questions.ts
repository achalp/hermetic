/**
 * Generate natural-language question suggestions from schema metadata.
 * Targets non-technical users — questions should feel conversational,
 * not like SQL queries.
 */

import type {
  CSVSchema,
  CSVColumn,
  CategoricalMeta,
  NumericMeta,
  WarehouseTableSchema,
  DataDomain,
} from "@/lib/types";

// ── Helpers ────────────────────────────────────────────────────────

/** Convert snake_case / camelCase column names to human-readable form. */
function niceName(colName: string): string {
  // Common uppercase abbreviations we want to keep uppercased
  const abbreviations = new Set(["id", "usd", "url", "api", "ip", "sku"]);

  return (
    colName
      // insert space before uppercase runs in camelCase ("closeDate" → "close Date")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      // replace underscores/hyphens with spaces
      .replace(/[_-]+/g, " ")
      .toLowerCase()
      .split(" ")
      .map((w) => (abbreviations.has(w) ? w.toUpperCase() : w))
      .join(" ")
  );
}

/** Pick columns by dtype shorthand. */
function colsByType(schema: CSVSchema, dtype: string): CSVColumn[] {
  return schema.columns.filter((c) => c.dtype === dtype);
}

/** Find a categorical column with a reasonable number of groups. */
function groupableCategory(schema: CSVSchema): CSVColumn | undefined {
  return schema.columns.find(
    (c) =>
      c.meta.kind === "categorical" &&
      !c.meta.is_unique &&
      c.meta.distinct_count >= 3 &&
      c.meta.distinct_count <= 15
  );
}

/** Find a categorical column that looks like a unique identifier/name. */
function uniqueLabel(schema: CSVSchema): CSVColumn | undefined {
  return schema.columns.find((c) => c.meta.kind === "categorical" && c.meta.is_unique);
}

// ── CSV Suggestions ────────────────────────────────────────────────

const DOMAIN_SUGGESTIONS: Partial<Record<DataDomain, string>> = {
  financial: "What are the revenue trends by quarter?",
  // sales / marketing / hr etc. are not in the current DataDomain union,
  // but we keep the map extensible for future domains.
};

export function generateSuggestions(schema: CSVSchema): string[] {
  const suggestions: string[] = [];

  const dates = colsByType(schema, "date");
  const numerics = colsByType(schema, "number");
  const category = groupableCategory(schema);
  const label = uniqueLabel(schema);

  // 1. Time trend — date + numeric
  if (dates.length > 0 && numerics.length > 0) {
    suggestions.push(`How does ${niceName(numerics[0].name)} change over time?`);
  }

  // 2. Comparison — categorical group + numeric
  if (category && numerics.length > 0) {
    suggestions.push(
      `Compare ${niceName(numerics[0].name)} across different ${niceName(category.name)} values`
    );
  }

  // 3. Distribution with outliers
  const outlierCol = numerics.find(
    (c) => (c.meta as NumericMeta).outlier_count && (c.meta as NumericMeta).outlier_count! > 0
  );
  if (outlierCol) {
    suggestions.push(
      `What's the distribution of ${niceName(outlierCol.name)}? Are there outliers?`
    );
  }

  // 4. Correlation
  if (schema.correlations?.length) {
    const strong = schema.correlations.find((r) => Math.abs(r.pearson) > 0.5);
    if (strong) {
      suggestions.push(
        `What's the relationship between ${niceName(strong.col_a)} and ${niceName(strong.col_b)}?`
      );
    }
  }

  // 5. Top/Bottom — unique label + numeric
  if (label && numerics.length > 0) {
    suggestions.push(
      `What are the top and bottom ${niceName(label.name)} by ${niceName(numerics[0].name)}?`
    );
  }

  // 6. Domain-specific hint
  if (schema.detected_domain && DOMAIN_SUGGESTIONS[schema.detected_domain]) {
    suggestions.push(DOMAIN_SUGGESTIONS[schema.detected_domain]!);
  }

  // 7. Summary fallback — always available if we have few specific questions
  if (suggestions.length < 3) {
    suggestions.push("Summarize the key patterns in this data");
  }

  // Deduplicate and cap at 5
  return [...new Set(suggestions)].slice(0, 5);
}

// ── Warehouse Suggestions ──────────────────────────────────────────

const DATE_KEYWORDS = ["date", "time", "created", "updated", "timestamp", "at"];
const NUMERIC_SQL_TYPES = [
  "int",
  "integer",
  "bigint",
  "smallint",
  "float",
  "double",
  "decimal",
  "numeric",
  "real",
  "number",
  "money",
];

function isDateLikeColumn(name: string): boolean {
  const lower = name.toLowerCase();
  return DATE_KEYWORDS.some((kw) => lower.includes(kw));
}

function isNumericType(sqlType: string): boolean {
  const lower = sqlType.toLowerCase();
  return NUMERIC_SQL_TYPES.some((t) => lower.includes(t));
}

export function generateWarehouseSuggestions(schemas: WarehouseTableSchema[]): string[] {
  const suggestions: string[] = [];

  // Foreign key relationships between tables
  for (const table of schemas) {
    if (table.foreign_keys?.length) {
      for (const fk of table.foreign_keys) {
        suggestions.push(
          `How do ${niceName(table.name)} relate to ${niceName(fk.references_table)}?`
        );
        if (suggestions.length >= 5) break;
      }
    }
    if (suggestions.length >= 5) break;
  }

  // Time trends within individual tables
  for (const table of schemas) {
    const dateCol = table.columns.find((c) => isDateLikeColumn(c.name));
    const numCol = table.columns.find((c) => isNumericType(c.type));
    if (dateCol && numCol) {
      suggestions.push(
        `Show trends in ${niceName(numCol.name)} from ${niceName(table.name)} over time`
      );
    }
    if (suggestions.length >= 5) break;
  }

  // Large tables worth summarising
  for (const table of schemas) {
    if (table.row_count_estimate > 100_000) {
      suggestions.push(`What are the key statistics for ${niceName(table.name)}?`);
    }
    if (suggestions.length >= 5) break;
  }

  // Fallback
  if (suggestions.length < 3) {
    suggestions.push("Summarize the structure and key metrics across all tables");
  }

  return [...new Set(suggestions)].slice(0, 5);
}
