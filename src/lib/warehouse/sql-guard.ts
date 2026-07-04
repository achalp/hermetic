/**
 * Deterministic guard against a warehouse query that SAMPLES the input of an
 * aggregate/global computation with an unordered LIMIT — which silently changes
 * the answer (e.g. "which building is farthest from its nearest neighbor" run
 * over a `LIMIT 500` sample of buildings). A prompt can discourage this; this
 * check catches it before the query runs, so the repair loop must fix it.
 *
 * Precision: only an UNORDERED inner LIMIT is flagged. `... ORDER BY x DESC
 * LIMIT 10` is a deliberate top-N (e.g. "average of the top 10") and is fine; a
 * bare `LIMIT 500` inside a subquery that feeds an aggregate is an arbitrary
 * sample and is not. A final top-level LIMIT on the OUTPUT ranking is always ok.
 */

// Reducing aggregate functions (NOT window-only fns like row_number). GROUP BY
// is handled separately.
const AGG_FN =
  /\b(count|sum|avg|min|max|stddev|stddev_pop|stddev_samp|variance|var|var_pop|var_samp|median|quantile|quantiles|quantileexact|percentile_cont|percentile_disc|approx_count_distinct|approx_quantiles|corr|covar_pop|covar_samp|group_concat|string_agg|array_agg|grouparray|groupuniqarray|argmin|argmax)\s*\(/i;

/** Blank out string literals and comments so keywords inside them don't match. */
function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/'(?:[^']|'')*'/g, " '' ") // single-quoted strings (keep '' shape)
    .replace(/"(?:[^"]|"")*"/g, ' "" '); // double-quoted strings/identifiers
}

/**
 * Returns a repair message if the query aggregates over an unordered, LIMIT-ed
 * subquery input; null when the query is safe.
 */
export function checkAggregateInputLimit(rawSql: string): string | null {
  const sql = stripNoise(rawSql);
  const lower = sql.toLowerCase();

  const hasAggregate = AGG_FN.test(sql) || /\bgroup\s+by\b/i.test(sql);
  if (!hasAggregate) return null;

  const parenStarts: number[] = [];
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "(") {
      parenStarts.push(i);
      continue;
    }
    if (c === ")") {
      parenStarts.pop();
      continue;
    }
    // A LIMIT clause: the keyword followed by a number (skips a column named
    // "limit"), at a word boundary.
    if ((c === "l" || c === "L") && (i === 0 || !/\w/.test(sql[i - 1]))) {
      if (!/^limit\s+\d/i.test(sql.slice(i, i + 12))) continue;
      const depth = parenStarts.length;
      if (depth === 0) continue; // a top-level output LIMIT is fine
      const groupStart = parenStarts[depth - 1];
      const group = lower.slice(groupStart, i);
      // Only care about a real subquery (a derived table / CTE body) that isn't
      // ordered — an unordered LIMIT there is an arbitrary sample.
      if (group.includes("select") && !/\border\s+by\b/.test(group)) {
        return (
          "This query applies a LIMIT to the INPUT of an aggregate/global computation WITHOUT an ORDER BY, " +
          "which selects an arbitrary sample of rows and CHANGES THE ANSWER (the aggregate is computed over a " +
          "partial, random subset, not the real data). Remove the inner LIMIT and compute the aggregate over the " +
          "complete filtered set. If the full computation is too expensive, make the SCOPE cheaper with a WHERE the " +
          "question implies (a named region / a recent time window) — do NOT sample with a bare LIMIT. A final " +
          "top-level LIMIT on the OUTPUT ranking is fine; an ORDER BY … LIMIT top-N inside a subquery is fine too."
        );
      }
    }
  }
  return null;
}
