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

/**
 * Read-only gate: every warehouse SQL string (LLM-generated OR user-edited)
 * runs with the connection's full privileges — nothing previously forced
 * SELECT-only, so a hallucinated or user-supplied DROP/DELETE/UPDATE would
 * have executed. Enforced once at the connector factory (createConnector
 * wraps executeSQL), covering all call sites: generated SQL, Edit-and-Rerun
 * SQL, refreshes, samples, and per-step investigate queries.
 *
 * Rules: exactly ONE statement (no `;` followed by more SQL, judged after
 * blanking strings/comments) whose first keyword is read-only
 * (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / VALUES) — AND no write/DDL
 * keyword anywhere in the statement. The first-keyword check alone was
 * bypassable (code-quality-hardening review): Postgres runs DML inside a CTE
 * (`WITH d AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM d`) and
 * EXPLAIN ANALYZE executes the statement it explains. Throws with an
 * actionable message — which feeds the SQL repair loop for generated queries.
 */
const READ_ONLY_FIRST_KEYWORD = /^\s*(select|with|show|describe|desc|explain|values)\b/i;

// Write/DDL keywords rejected at ANY word boundary of the noise-stripped SQL,
// not just first position. Quoted strings/identifiers are already blanked by
// stripNoise, so a column literally named "delete" passes only when quoted —
// an UNQUOTED identifier colliding with one of these is vanishingly rare, and
// failing closed is correct for a security gate.
const WRITE_KEYWORD =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|call|copy|vacuum|refresh)\b/i;

// EXPLAIN ANALYZE (incl. the option-list form `EXPLAIN (ANALYZE, …)`) EXECUTES
// the statement being explained; plain EXPLAIN only plans and stays allowed.
const EXPLAIN_ANALYZE = /^explain\s*(analy[sz]e\b|\([^)]*\banaly[sz]e\b)/i;

export function assertReadOnlySql(sql: string): void {
  const clean = stripNoise(sql).trim();
  if (!READ_ONLY_FIRST_KEYWORD.test(clean)) {
    const keyword = clean.split(/\s+/, 1)[0] ?? "";
    throw new Error(
      `Refusing to execute non-read-only SQL (starts with "${keyword}"). ` +
        `Only a single SELECT/WITH query is allowed against the warehouse.`
    );
  }
  if (EXPLAIN_ANALYZE.test(clean)) {
    throw new Error(
      "Refusing to execute EXPLAIN ANALYZE — it actually RUNS the statement it explains. " +
        "Use plain EXPLAIN for the plan, or run the SELECT itself."
    );
  }
  // A semicolon is only legal as a trailing terminator. Checked before the
  // keyword scan so a `SELECT …; DROP …` tail gets the multi-statement repair
  // message, not the keyword one.
  const semi = clean.indexOf(";");
  if (semi !== -1 && clean.slice(semi + 1).trim().length > 0) {
    throw new Error("Refusing to execute multi-statement SQL. Send exactly one SELECT/WITH query.");
  }
  const write = WRITE_KEYWORD.exec(clean);
  if (write) {
    throw new Error(
      `Refusing to execute non-read-only SQL (contains "${write[1].toUpperCase()}"). ` +
        `Only a single SELECT/WITH query is allowed against the warehouse — write/DDL ` +
        `keywords are rejected anywhere in the statement, including inside a CTE. ` +
        `If you referenced a column whose name collides with a SQL keyword, quote the identifier.`
    );
  }
}

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

/** Last path segment of a (possibly backtick-quoted, dotted) table reference. */
function tableKey(ref: string): string {
  const bare = ref.replace(/`/g, "").trim();
  const seg = bare.split(".").pop() ?? bare;
  return seg.toLowerCase();
}

/** Does a JOIN ... ON clause bound the join with a real column equality (not
 *  !=, <>, <=, >=)? An equi-join is bounded; a purely inequality/distance ON is
 *  effectively all-pairs. */
function hasRealEquality(onClause: string): boolean {
  return /=/.test(onClause.replace(/!=|<>|<=|>=/g, " "));
}

/**
 * Flag a CROSS / self / non-equi join over a LARGE base table — an O(n²) all-
 * pairs computation that won't scale (the "farthest building from its nearest
 * neighbor" self-join over 2.5B rows). The scalable rewrite is to bucket first
 * (spatial grid / S2 cell for geo, the natural key otherwise) and join within a
 * bucket on an EQUALITY of the bucket key — which clears this check, so the guard
 * forces exactly that repair.
 *
 * Precision: only DIRECT base-table references are sized (subquery-wrapped joins
 * can't be sized statically — those are left to the scale-first prompt + the
 * unordered-LIMIT guard). An equi-join between large tables is NOT flagged.
 */
export function checkUnboundedLargeJoin(
  rawSql: string,
  tables: { name: string; row_count_estimate: number }[],
  largeRowThreshold: number
): string | null {
  const sql = stripNoise(rawSql);
  const sizeByKey = new Map<string, number>();
  for (const t of tables) sizeByKey.set(tableKey(t.name), t.row_count_estimate ?? 0);
  const isLarge = (ref: string) => (sizeByKey.get(tableKey(ref)) ?? 0) >= largeRowThreshold;

  const bigMsg = (rows: number) =>
    `This joins a LARGE table (~${rows.toLocaleString()} rows) with a CROSS / non-equi / self join — that is O(n²) ` +
    "(it enumerates all pairs) and will not scale. BUCKET first: group rows into buckets — a spatial grid or " +
    "S2_CELLIDFROMPOINT for geo, the natural key otherwise — and JOIN within a bucket + its immediate neighbors " +
    "using an EQUALITY on the bucket key; handle the isolated tail (rows with no neighbor in their block) with a " +
    "wider second pass rather than dropping them. Do NOT cross-join or non-equi-join the raw table. If the bucketed " +
    "method introduces any boundary or approximation (a bounded search radius, grid-resolution rounding), disclose it " +
    "with a constant `analysis_scope` column describing the method and its caveat.";

  // 1) CROSS JOIN <largeBaseTable>
  const crossRe = /\bCROSS\s+JOIN\s+(`[^`]+`|[A-Za-z_][\w.]*)/gi;
  for (let m; (m = crossRe.exec(sql)); ) {
    if (isLarge(m[1])) return bigMsg(sizeByKey.get(tableKey(m[1]))!);
  }

  // 2) JOIN <largeBaseTable> [alias] ON <clause> with no real equality (non-equi)
  const joinRe =
    /\bJOIN\s+(`[^`]+`|[A-Za-z_][\w.]*)(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+ON\b([\s\S]*?)(?=\b(?:JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|WINDOW|QUALIFY|UNION|EXCEPT|INTERSECT)\b|\)|$)/gi;
  for (let m; (m = joinRe.exec(sql)); ) {
    if (isLarge(m[1]) && !hasRealEquality(m[2])) return bigMsg(sizeByKey.get(tableKey(m[1]))!);
  }

  return null;
}
