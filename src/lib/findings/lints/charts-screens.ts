/**
 * Findings coherence lints (spec §3.3, §7.2, §7.3) — pure, advisory.
 * Split from the former lints.ts god module (L7); see ./index.ts.
 */
import type { FindingEntry, FindingIssue } from "@/lib/contracts/findings";
import type { ProductRolesIndex } from "@/lib/product";
import { SCREEN_LIKE_DTYPES } from "./screen-dtypes";

/**
 * Two chart series in ONE payload disagreeing about the same (x, column)
 * cell — 1966 max_price null in price_trend_over_time and 10000 in
 * price_spread_over_time — is the screen applied to some series and not
 * others; and a peak/max superlative naming a smaller value than a chart
 * column beside it ships two answers. Deterministic, advisory.
 *
 * "One payload" means one POLICY SCOPE: in an Investigate merge each step is
 * its own analysis with its own legitimate policies, so cells are compared
 * only within a step (the step_N_/step_N. prefixes mark the scope), and a
 * step's superlative is checked only against that step's charts.
 */
export function lintChartConsistency(
  chartData: Record<string, unknown>,
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  // POLICY SCOPE: one analysis, one policy — but an Investigate run merges
  // MANY analyses, and different steps legitimately compute the same measure
  // under different scopes/screens. The step prefix is the deterministic
  // scope marker on both namespaces (step_N_ on merged chart keys, step_N.
  // on manifest names), so cells are compared only within their scope.
  // Single-shot Ask has no prefixes: everything shares scope "" — unchanged.
  const scopeOfKey = (k: string): string => /^(step_\d+)_/.exec(k)?.[1] ?? "";
  const scopeOfFinding = (name: string): string => /^(step_\d+)\./.exec(name)?.[1] ?? "";
  // Cell maps per scope: column -> xValue -> {nulls: series[], nums: Map<series, number>}
  type ByX = Map<string, { nulls: string[]; nums: Map<string, number> }>;
  const scopedCells = new Map<string, Map<string, ByX>>();
  const xKeyOf = (row: Record<string, unknown>): string | undefined => {
    for (const k of ["year", "month", "date", "period", "x", "label"]) {
      if (k in row) return String(row[k]);
    }
    return undefined;
  };
  for (const [series, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows)) continue;
    const cells = scopedCells.get(scopeOfKey(series)) ?? new Map<string, ByX>();
    scopedCells.set(scopeOfKey(series), cells);
    // Declared x role beats the well-known-key guess for declared series.
    const declaredX = rolesIdx?.get(series)?.xCol;
    for (const raw of rows) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const x = declaredX !== undefined ? String(row[declaredX]) : xKeyOf(row);
      if (x === undefined) continue;
      for (const [col, val] of Object.entries(row)) {
        if (col === declaredX) continue;
        if (["year", "month", "date", "period", "x", "label"].includes(col)) continue;
        const byX: ByX = cells.get(col) ?? new Map();
        cells.set(col, byX);
        const cell = byX.get(x) ?? { nulls: [] as string[], nums: new Map<string, number>() };
        byX.set(x, cell);
        if (val === null) cell.nulls.push(series);
        else if (typeof val === "number") cell.nums.set(series, val);
      }
    }
  }
  let divergences = 0;
  for (const cells of scopedCells.values()) {
    for (const [col, byX] of cells) {
      for (const [x, cell] of byX) {
        if (cell.nulls.length > 0 && cell.nums.size > 0 && divergences < 3) {
          divergences++;
          const [numSeries, num] = [...cell.nums.entries()][0];
          issues.push({
            kind: "chart_policy_divergence",
            detail: `${col} at ${x} is null in ${cell.nulls[0]} but ${num} in ${numSeries} — the same cell under two policies; a screen applied to some series and not others`,
          });
        }
      }
    }
  }
  // Superlative vs chart max: a peak/max finding whose value a chart column
  // exceeds — checked only against the finding's OWN scope's charts (a
  // step-2 peak over a screened subset is not contradicted by step-3's
  // unscreened chart of the full corpus).
  // Dimensional compatibility (run f62eefbb, two false positives): a
  // per-PAYEE peak of 948 was flagged against a per-LOCATION rollup's 3130
  // — same measure word, different dimension, no contradiction. The
  // finding's non-measure tokens (payee, daily, weekly...) must overlap the
  // SERIES KEY before its columns can adjudicate; findings whose names
  // carry only measure words keep the legacy any-series comparison (the
  // original max_price catch has no dimension token to demand).
  const MEASURE_WORDS = new Set([
    "spend",
    "price",
    "usd",
    "total",
    "amount",
    "value",
    "cost",
    "revenue",
    "sales",
    "sum",
  ]);
  const dimTokens = (s: string) =>
    s.split(/[._]/).filter((t) => t.length > 2 && !MEASURE_WORDS.has(t.toLowerCase()));
  for (const f of findings) {
    if (!/peak|max/.test(f.name) || f.value === null || typeof f.value !== "object") continue;
    const val = (f.value as Record<string, unknown>).value;
    if (typeof val !== "number") continue;
    const cells = scopedCells.get(scopeOfFinding(f.name));
    if (!cells) continue;
    const tokens = f.name.split(/[._]/).filter((t) => t.length > 2 && !["peak", "max"].includes(t));
    const fDims = dimTokens(f.name).filter((t) => !["peak", "max", "largest"].includes(t));
    for (const [col, byX] of cells) {
      if (!tokens.some((t) => col.includes(t))) continue;
      let best: { x: string; v: number; series: string } | null = null;
      for (const [x, cell] of byX) {
        for (const [series, v] of cell.nums.entries()) {
          if (!best || v > best.v) best = { x, v, series };
        }
      }
      if (best && best.v > val * 1.05) {
        if (fDims.length > 0) {
          const sDims = new Set(dimTokens(best.series).map((t) => t.toLowerCase()));
          if (!fDims.some((t) => sDims.has(t.toLowerCase()))) continue;
        }
        issues.push({
          kind: "superlative_contradicted_by_chart",
          name: f.name,
          detail: `${f.name} reports ${val} but chart column ${col} holds ${best.v} at ${best.x} — the finding and the chart beside it disagree about the maximum`,
        });
        break;
      }
    }
  }
  return issues;
}

// ── Results-provenance lint (run-31: superlative with no finding) ────

/** A superlative-shaped results scalar (peak_/trough_/max_/min_) with no
 *  finding sharing its name tokens has a broken provenance chain — the
 *  manifest exists so every headline value traces to a declared finding. */
export function lintResultsProvenance(
  results: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const findingTokens = findings.map(
    (f) => new Set(f.name.split(/[._]/).filter((t) => t.length > 2))
  );
  for (const [key, val] of Object.entries(results)) {
    if (typeof val !== "number") continue;
    if (
      !/^(peak|trough|max|min|largest|smallest)_/.test(key) &&
      !/_(p_value|slope|slope_per_year|pct_change|r2|r_squared|pearson_r)$/.test(key)
    )
      continue;
    const toks = key.split(/[._]/).filter((t) => t.length > 2);
    const backed = findingTokens.some((ft) => toks.filter((t) => ft.has(t)).length >= 2);
    if (!backed && issues.length < 5) {
      issues.push({
        kind: "unbacked_superlative",
        detail: `results.${key} = ${val} has no finding backing it — a statistical claim shipped without the provenance the manifest exists to provide`,
      });
    }
  }
  return issues;
}

// ── Undeclared-screen lint (run-32: max_price screened, no contract) ──

/** A *_screened column in chart_data with no check declaring a screen over
 *  its base column: the parallel-columns contract eliminated consumer-side
 *  assumptions, but a screen with no declaration is a transformation with
 *  no contract behind it. */
export function lintUndeclaredScreen(
  chartData: Record<string, unknown>,
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  // Structured path (exact, no morphology): a measure declared as a variant
  // with no screened_by is a transformation without a contract; a
  // screened_by naming a check the manifest doesn't carry is a dangling ref.
  const checkNames = new Set(
    findings.filter((f) => SCREEN_LIKE_DTYPES.has(f.dtype)).map((f) => f.name)
  );
  for (const [key, info] of rolesIdx ?? []) {
    for (const m of info.measures) {
      if (m.variant_of !== undefined && m.screened_by === undefined) {
        issues.push({
          kind: "undeclared_screen",
          detail: `series ${key} declares ${m.column} as a variant of ${m.variant_of} with no screened_by — a transformation with no declaration behind it (which rule, what threshold, how many excluded?)`,
        });
      } else if (m.screened_by !== undefined && !checkNames.has(m.screened_by)) {
        issues.push({
          kind: "undeclared_screen",
          detail: `series ${key} measure ${m.column} cites screened_by ${m.screened_by}, but no check with that name is declared — the screen reference dangles`,
        });
      }
    }
  }
  const screenedBases = new Set<string>();
  for (const [key, v] of Object.entries(chartData)) {
    if (rolesIdx?.has(key)) continue; // covered by the structured path above
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    for (const col of Object.keys(rows[0] as Record<string, unknown>)) {
      const m = /^(.*?)_screened(?:_[a-z]+)?$/.exec(col);
      if (m) screenedBases.add(m[1]);
    }
  }
  // The EXECUTED-screen signature, independent of naming convention and of
  // whether the series was declared: a column null at rows where its _raw
  // sibling holds a value. Presence of the pair alone proves nothing; the
  // null-beside-raw divergence is a transformation that RAN (avg_price
  // null for 1986, avg_price_raw 13.68 — and no screen finding anywhere in
  // the manifest). Columns whose series declares the variant with a valid
  // screened_by are exempt — the structured path owns those.
  for (const [key, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    const contracted = new Set(
      (rolesIdx?.get(key)?.screens ?? [])
        .filter((s) => checkNames.has(s.checkName))
        .map((s) => s.screenedCol)
    );
    const first = rows[0] as Record<string, unknown>;
    for (const col of Object.keys(first)) {
      const rm = /^(.*?)_raw$/.exec(col);
      if (!rm || !(rm[1] in first) || contracted.has(rm[1])) continue;
      const base = rm[1];
      const executed = (rows as Record<string, unknown>[]).some(
        (r) =>
          (r[base] === null || r[base] === undefined) && r[col] !== null && r[col] !== undefined
      );
      if (executed) screenedBases.add(base);
    }
  }
  for (const base of screenedBases) {
    const tokens = base.split(/_/).filter((t) => t.length > 2);
    const declared = findings.some(
      (f) =>
        SCREEN_LIKE_DTYPES.has(f.dtype) &&
        /screen|outlier|exclusion/.test(f.name + " " + f.definition.toLowerCase()) &&
        tokens.some((t) => f.name.includes(t) || f.definition.toLowerCase().includes(t))
    );
    if (!declared) {
      issues.push({
        kind: "undeclared_screen",
        detail: `chart_data carries ${base}_screened* columns but no check declares a screen over ${base} — a transformation with no declaration behind it (which rule, what threshold, how many excluded?)`,
      });
    }
  }
  return issues;
}

// ── Screen-scope mismatch + series-consumption lints (run-33) ────────

interface ScreenedColumnEntry {
  excludedX: Set<string>;
  rawKeys: Set<string>;
  screenedKeys: Set<string>;
  /** Checks declared to own this screen (analysis-product roles) — when
   *  present, scope lints deref these instead of token-matching. */
  checkNames: Set<string>;
}

function screenedColumnMap(
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): Map<string, ScreenedColumnEntry> {
  const map = new Map<string, ScreenedColumnEntry>();
  const X_KEYS = ["year", "month", "date", "period", "x", "label", "decade"];
  const newEntry = (): ScreenedColumnEntry => ({
    excludedX: new Set<string>(),
    rawKeys: new Set<string>(),
    screenedKeys: new Set<string>(),
    checkNames: new Set<string>(),
  });
  // Structured path (analysis-product spec §3): declared screened_by/
  // variant_of roles say exactly which column is a screen of which, under
  // which check — no name morphology involved. Keys covered by the roles
  // index are EXCLUDED from the legacy convention scan below.
  for (const [key, info] of rolesIdx ?? []) {
    const v = chartData[key];
    const rows = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
    for (const screen of info.screens) {
      const base = screen.rawCol ?? screen.screenedCol;
      const entry = map.get(base) ?? newEntry();
      map.set(base, entry);
      entry.screenedKeys.add(key);
      entry.checkNames.add(screen.checkName);
      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const rawVal = screen.rawCol !== undefined ? row[screen.rawCol] : undefined;
        const excluded =
          screen.rawCol !== undefined
            ? rawVal !== null && rawVal !== undefined && row[screen.screenedCol] === null
            : row[screen.screenedCol] === null;
        if (excluded) entry.excludedX.add(String(row[info.xCol]));
      }
    }
  }
  for (const [key, v] of Object.entries(chartData)) {
    if (rolesIdx?.has(key)) continue;
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    for (const col of cols) {
      const m = /^(.*?)_screened(_[a-z]+)?$/.exec(col);
      if (!m) continue;
      const base = m[1] + (m[2] ?? "");
      const entry = map.get(m[1]) ?? newEntry();
      map.set(m[1], entry);
      entry.screenedKeys.add(key);
      const xCol = cols.find((c) => X_KEYS.includes(c.toLowerCase()));
      for (const raw of rows as Record<string, unknown>[]) {
        const baseVal = raw[base] ?? raw[m[1] + "_usd"] ?? raw[m[1]];
        if (baseVal !== null && baseVal !== undefined && raw[col] === null && xCol) {
          entry.excludedX.add(String(raw[xCol]));
        }
      }
    }
  }
  // Second pass: raw-only consumption — must run AFTER all screened bases
  // are known (a raw chart earlier in iteration order than its screened
  // sibling would otherwise be missed).
  for (const [key, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    const info = rolesIdx?.get(key);
    if (info) {
      // A declared series consumes raw when a measure matches a screened
      // base and no measure in the same series screens it.
      for (const m of info.measures) {
        const base = m.column.replace(/_(usd|pct|pp)$/, "");
        const entry = map.get(base) ?? map.get(m.column);
        if (
          entry &&
          m.screened_by === undefined &&
          !info.screens.some((s) => s.rawCol === m.column)
        ) {
          entry.rawKeys.add(key);
        }
      }
      continue;
    }
    for (const col of cols) {
      if (/_screened/.test(col)) continue;
      const base = col.replace(/_(usd|pct|pp)$/, "");
      const entry = map.get(base);
      if (entry && !cols.some((c) => c.startsWith(base + "_screened"))) {
        entry.rawKeys.add(key);
      }
    }
  }
  return map;
}

/** The screen a *_screened column ACTUALLY applied (base non-null, screened
 *  null) must match the declared check's evidence set — {1966, 1980}
 *  applied against a declared {1980, 1999, 2012} is two exclusion sets
 *  under one manifest entry. */
export function lintScreenScopeMismatch(
  chartData: Record<string, unknown>,
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [base, entry] of screenedColumnMap(chartData, rolesIdx)) {
    if (entry.excludedX.size === 0) continue;
    // Structured path: screened_by names the owning check — dereference it
    // exactly. Legacy path: token-match check names/definitions.
    const declaring =
      entry.checkNames.size > 0
        ? findings.filter((f) => SCREEN_LIKE_DTYPES.has(f.dtype) && entry.checkNames.has(f.name))
        : findings.filter((f) => {
            const tokens = base.split(/_/).filter((t) => t.length > 2);
            return (
              SCREEN_LIKE_DTYPES.has(f.dtype) &&
              /screen|outlier|exclusion/.test(f.name + " " + f.definition.toLowerCase()) &&
              tokens.some((t) => f.name.includes(t) || f.definition.toLowerCase().includes(t))
            );
          });
    if (declaring.length === 0) continue; // undeclared_screen covers that
    const declared = new Set<string>();
    for (const f of declaring) {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (typeof v === "number") declared.add(String(v));
        else if (typeof v === "string" && /^\d{3,4}$/.test(v)) declared.add(v);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(f.value);
    }
    if (declared.size === 0) continue;
    const outside = [...entry.excludedX].filter((x) => !declared.has(x));
    if (outside.length > 0) {
      issues.push({
        kind: "screen_scope_mismatch",
        name: declaring[0].name,
        detail: `${base}_screened excludes {${[...entry.excludedX].join(", ")}} but ${declaring[0].name} declares {${[...declared].join(", ")}} — ${outside.join(", ")} excluded by no declared rule (two exclusion sets, one manifest entry)`,
      });
    }
  }
  return issues;
}

/** A chart consuming the RAW series while a screened sibling exists
 *  elsewhere is an undeclared choice that WILL drift between runs (the
 *  decade rollup silently flipping raw/screened moved the 1980s bar 10x). */
export function lintSeriesConsumption(
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [base, entry] of screenedColumnMap(chartData, rolesIdx)) {
    if (entry.rawKeys.size > 0 && entry.screenedKeys.size > 0 && issues.length < 4) {
      issues.push({
        kind: "undeclared_series_choice",
        detail: `${[...entry.rawKeys].join(", ")} consume(s) raw ${base} while screened ${base} exists (${[...entry.screenedKeys].join(", ")}) — an element's raw-vs-screened choice must be declared or it drifts between runs`,
      });
    }
  }
  return issues;
}

// ── Unscreened-superlative lint (run-35: screens vanished, raw peak shipped) ──

/** A peak/max finding whose value dwarfs its own chart column's median
 *  (>50x) with no screened variant anywhere is a transcription error
 *  promoted to a finding — the outlier-screen policy as a deterministic
 *  detector, so it survives runs where no screen was declared at all. */
export function lintUnscreenedSuperlative(
  chartData: Record<string, unknown>,
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    if (!/peak|max|largest/.test(f.name) || f.value === null || typeof f.value !== "object")
      continue;
    const val = (f.value as Record<string, unknown>).value;
    if (typeof val !== "number") continue;
    const tokens = f.name
      .split(/[._]/)
      .filter((t) => t.length > 2 && !["peak", "max", "largest"].includes(t));
    for (const [key, v] of Object.entries(chartData)) {
      const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
      if (!Array.isArray(rows) || rows.length < 5 || typeof rows[0] !== "object") continue;
      const info = rolesIdx?.get(key);
      // Structured path: a measure declaring of=<finding> is the series view
      // of this finding — exact linkage, no token matching. Prefer the raw
      // variant when the of-measure is itself the screened one.
      const ofMeasure = info?.measures.find((m) => m.of === f.name);
      const col =
        (ofMeasure ? (ofMeasure.variant_of ?? ofMeasure.column) : undefined) ??
        Object.keys(rows[0] as object).find(
          (c) => !/_screened/.test(c) && tokens.some((t) => c.includes(t))
        );
      if (!col) continue;
      const nums = (rows as Record<string, unknown>[])
        .map((r) => r[col])
        .filter((x): x is number => typeof x === "number" && x > 0)
        .sort((a, b) => a - b);
      if (nums.length < 5) continue;
      const median = nums[Math.floor(nums.length / 2)];
      if (median > 0 && val > 50 * median && issues.length < 3) {
        // Was THIS value screened? A screened sibling column with null at
        // the peak row means yes. A screen that exists but let the peak
        // through is the cluster-validation failure: a rolling baseline
        // computed on unscreened data lets errors vouch for each other
        // (1980's \$30,000 cleared 100x because 1966/72/75/77's errors
        // raised the bar).
        const screenedCol =
          info?.screens.find((s) => s.rawCol === col)?.screenedCol ??
          Object.keys(rows[0] as object).find((c) => c.startsWith(col) && /_screened/.test(c));
        const peakRow = (rows as Record<string, unknown>[]).find((r) => r[col] === val);
        const wasScreened = screenedCol && peakRow ? peakRow[screenedCol] === null : false;
        if (!wasScreened) {
          issues.push({
            kind: screenedCol ? "screen_missed_superlative" : "unscreened_superlative",
            name: f.name,
            detail: screenedCol
              ? `${f.name} = ${val} is ${Math.round(val / median)}x the median of ${col} and the screen let it through — a baseline computed on unscreened data lets error clusters validate each other; iterate the screen or use a robust (trimmed) baseline`
              : `${f.name} = ${val} is ${Math.round(val / median)}x the median of ${col} with NO screened series in the payload — a magnitude outlier promoted to a finding`,
          });
        }
      }
      break;
    }
  }
  return issues;
}

// ── Well-attested-screened lint (run-37: 2012/$38 on 1,312 listings deleted) ──

/** A screen exists to remove transcription errors — which are low-n or
 *  magnitude-implausible. A screened-out x whose COUNT column is at or
 *  above the series median is well-attested data: screening it means the
 *  baseline is miscalibrated (a global pooled median on a trending series
 *  flags growth as error). */
export function lintWellAttestedScreened(
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const X_KEYS = ["year", "month", "date", "period", "x", "label", "decade"];
  for (const [key, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length < 5 || typeof rows[0] !== "object") continue;
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    // Declared roles are authoritative when this key is a declared series.
    const info = rolesIdx?.get(key);
    const countCol =
      info?.countCol ??
      cols.find((c) => /(^|_)(item_count|n_items|count|listings|n_obs|observations)($|_)/.test(c));
    const xCol = info?.xCol ?? cols.find((c) => X_KEYS.includes(c.toLowerCase()));
    if (!countCol || !xCol) continue;
    const counts = (rows as Record<string, unknown>[])
      .map((r) => r[countCol])
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b);
    if (counts.length < 5) continue;
    const medianCount = counts[Math.floor(counts.length / 2)];
    // Screen pairs: declared roles when available, name morphology otherwise.
    const pairs = info
      ? info.screens
          .filter((s) => s.rawCol !== undefined)
          .map((s) => ({ screened: s.screenedCol, base: s.rawCol!, label: s.rawCol! }))
      : cols.flatMap((col) => {
          const m = /^(.*?)_screened/.exec(col);
          const base = m && cols.find((c) => c.startsWith(m[1]) && !/_screened/.test(c));
          return m && base ? [{ screened: col, base, label: m[1] }] : [];
        });
    for (const { screened, base, label } of pairs) {
      for (const r of rows as Record<string, unknown>[]) {
        if (
          r[screened] === null &&
          typeof r[base] === "number" &&
          typeof r[countCol] === "number" &&
          (r[countCol] as number) >= medianCount &&
          issues.length < 3
        ) {
          issues.push({
            kind: "well_attested_screened",
            detail: `${key}: ${label} screened out at ${String(r[xCol])} despite ${String(r[countCol])} ${countCol} (>= series median ${medianCount}) — transcription errors are low-n or magnitude-implausible; a well-attested value screened means the baseline is miscalibrated (use a rolling/within-era baseline on trending series, never a global pooled one)`,
          });
        }
      }
    }
  }
  return issues;
}

/** Two representations of one absence: a finding field is null while its
 *  mirrored results key is 0 (run-37: step_change_delta 0 in results, null
 *  in the finding) — the mirror must be read, not re-defaulted. */
export function lintNullZeroMirror(
  results: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    if (f.value === null || typeof f.value !== "object" || Array.isArray(f.value)) continue;
    for (const [field, val] of Object.entries(f.value as Record<string, unknown>)) {
      const base = f.name.replace(/^step_\d+\./, "");
      for (const rk of [`${base}_${field}`, `${field}`]) {
        if (!(rk in results) || issues.length >= 4) continue;
        if (val === null && results[rk] === 0) {
          issues.push({
            kind: "null_zero_mirror",
            name: f.name,
            detail: `results.${rk} = 0 while ${f.name}.${field} is null — two representations of the same absence; the results mirror must READ the declared dict (0 asserts a measurement that returned nothing)`,
          });
        } else if (val !== null && typeof val === "number" && results[rk] === null) {
          // Inverse loss (run-41: results.median_price_skewness null while
          // the manifest's distribution carries skew 4.25).
          issues.push({
            kind: "mirror_dropped_value",
            name: f.name,
            detail: `results.${rk} is null while ${f.name}.${field} = ${val} — results dropped a value its own manifest carries; the mirror must READ the declared dict`,
          });
        }
      }
    }
  }
  return issues;
}

/** An attestation-screened superlative narrated WITHOUT its raw extreme:
 *  the audit caught "peaked at 0.4" shipped while the raw max was 65x
 *  larger with 90% of years screened — the reader sees the screen's output
 *  but never learns a screen ran. Fires when the attested value appears in
 *  the narrative, differs materially from raw_value, and the raw value
 *  appears nowhere. Post-resolution narrative texts; advisory. */
export function lintSuperlativeHidesRaw(
  findings: FindingEntry[],
  narrativeTexts: string[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  if (narrativeTexts.length === 0) return issues;
  const text = narrativeTexts.join("\n");
  const renders = (v: number): string[] => {
    const out = [String(v)];
    if (Number.isInteger(v)) out.push(v.toLocaleString("en-US"));
    else out.push(v.toFixed(2), v.toFixed(1));
    return out;
  };
  // The same symmetry in both attestation-gated shapes: a superlative's
  // raw_value, and a current-state's latest_value (the reviewed run walked
  // back 68 thin years and the $26/2012 endpoint vanished from the story).
  const PAIRS: Array<{ rawField: string; periodField: string; scaleField: string }> = [
    { rawField: "raw_value", periodField: "raw_period", scaleField: "thin_periods_skipped" },
    { rawField: "latest_value", periodField: "latest_period", scaleField: "excluded_trailing" },
  ];
  for (const f of findings) {
    if (f.value === null || typeof f.value !== "object" || issues.length >= 3) continue;
    const fv = f.value as Record<string, unknown>;
    const val = fv.value;
    if (typeof val !== "number") continue;
    for (const { rawField, periodField, scaleField } of PAIRS) {
      const raw = fv[rawField];
      if (typeof raw !== "number") continue;
      if (Math.abs(raw - val) <= 0.2 * Math.max(Math.abs(val), 1e-9)) continue;
      const valShown = renders(val).some((r) => text.includes(r));
      const rawShown = renders(raw).some((r) => text.includes(r));
      if (valShown && !rawShown) {
        issues.push({
          kind: "superlative_hides_raw",
          name: f.name,
          detail: `${f.name} narrates the attested value ${val} while ${rawField} ${raw} (${String(fv[periodField] ?? "?")}${typeof fv[scaleField] === "number" ? `, ${scaleField}=${fv[scaleField]}` : ""}) appears nowhere — the gate may decide what the headline emphasizes, never what the reader can see; state both values`,
        });
        break;
      }
    }
  }
  return issues;
}

/** The regime envelope makes policy ENFORCEABLE: a series whose profile
 *  fired ZERO_INFLATED + MONETARY must have had its zeros excluded — a
 *  blocking check that CLAIMS record-level exclusion while reporting
 *  n_excluded=0 and leaving 12 $0.00 rows in the series is a check
 *  validating a filter that never ran (compiled-run review 2026-08-09). */
export function lintRegimePolicy(
  regimes: Record<string, unknown> | undefined,
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [id, prof] of Object.entries(regimes ?? {})) {
    if (issues.length >= 3 || prof === null || typeof prof !== "object") continue;
    const flags = (prof as { flags?: unknown }).flags;
    if (!Array.isArray(flags) || !flags.includes("ZERO_INFLATED") || !flags.includes("MONETARY"))
      continue;
    const rows = chartData[id];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const info = rolesIdx?.get(id);
    const col = info?.measures[0]?.column;
    if (!col) continue;
    // Count-corroborated zeros are REAL (runtime _zero_screen, run
    // d82a39ce): a $0 row whose count column is also 0 is a period nothing
    // happened — the sentinel policy is SUPPOSED to keep it. Only zeros
    // with recorded activity (count > 0) or no count information count as
    // unapplied policy.
    const countCol =
      info?.countCol ??
      Object.keys((rows as Record<string, unknown>[])[0] ?? {}).find((c) =>
        /(^|_)(n|count|transactions?)$/.test(c)
      );
    const zeros = (rows as Record<string, unknown>[]).filter((r) => {
      if (r[col] !== 0) return false;
      if (countCol === undefined) return true;
      const c = r[countCol];
      return !(typeof c === "number" && c === 0);
    }).length;
    if (zeros > 0) {
      issues.push({
        kind: "zero_sentinel_unapplied",
        name: id,
        detail: `series ${id}: the regime profile fired ZERO_INFLATED on a monetary measure (zero_share ${String((prof as Record<string, unknown>).zero_share)}), but ${zeros} zero-valued rows remain in ${col} — the sentinel policy was declared, not applied (a check claiming exclusion with n_excluded=0 is validating a filter that never ran); exclude at the record level via zero_policy(profile_regimes(...))`,
      });
    }
  }
  return issues;
}

/** An aggregation that didn't aggregate: a declared series whose x repeats
 *  consecutively with no group role — 34 rows tagged "(1850.999, 1916.0]"
 *  each carrying a single year's median is a per-year series wearing an
 *  era costume (and raw pandas Interval strings as labels). */
export function lintUnaggregatedRollup(
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [id, info] of rolesIdx ?? []) {
    if (issues.length >= 2 || info.groupCol) continue;
    const rows = chartData[id];
    if (!Array.isArray(rows) || rows.length < 4) continue;
    const xs = (rows as Record<string, unknown>[]).map((r) => String(r[info.xCol]));
    const dupRun = xs.some((x, i) => i > 0 && x === xs[i - 1]);
    const intervalLabels = xs.some((x) => /^[([][\d.]+, ?[\d.]+[)\]]$/.test(x));
    if (dupRun || intervalLabels) {
      issues.push({
        kind: "unaggregated_rollup",
        name: id,
        detail: `series ${id}: ${dupRun ? `x (${info.xCol}) repeats consecutively with no group role — the rollup never grouped (one row per underlying period wearing the bucket label)` : ""}${dupRun && intervalLabels ? "; " : ""}${intervalLabels ? "x labels are raw pandas Interval strings — name the buckets explicitly (e.g. '1850–1916'), str(Interval) is not a label" : ""}`,
      });
    }
  }
  return issues;
}

// ── Thin-superlative lint (run-39: 52-item year crowned the headline) ──
