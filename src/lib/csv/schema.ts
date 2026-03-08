import type {
  CSVColumn,
  CSVSchema,
  NumericMeta,
  DateMeta,
  CategoricalMeta,
  BooleanMeta,
  ColumnMeta,
  DataDomain,
  ColumnCorrelation,
} from "@/lib/types";
import type { ParsedCSV } from "./parser";
import { MAX_SAMPLE_ROWS, MAX_PREVIEW_ROWS } from "@/lib/constants";

// ── Helpers ────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = ["$", "€", "£", "¥", "₹"] as const;
const CURRENCY_RE = /^[\s]*[$€£¥₹]/;
const PERCENT_RE = /%\s*$/;
const STRIP_RE = /[$€£¥₹,%\s]/g;

function stripNumericFormatting(v: string): string {
  return v.replace(STRIP_RE, "");
}

function isNumericAfterStrip(v: string): boolean {
  const stripped = stripNumericFormatting(v);
  return stripped !== "" && !isNaN(Number(stripped));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// ── dtype inference (enhanced) ─────────────────────────────────────

function inferDtype(values: string[]): CSVColumn["dtype"] {
  const nonEmpty = values.filter((v) => v !== "" && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return "string";

  const lowerValues = nonEmpty.map((v) => v.toLowerCase().trim());

  // Boolean check
  const allBoolean = lowerValues.every(
    (v) => v === "true" || v === "false" || v === "0" || v === "1" || v === "yes" || v === "no"
  );
  if (allBoolean) return "boolean";

  // Number check — strip currency/percentage/commas first
  const allNumber = nonEmpty.every((v) => isNumericAfterStrip(v));
  if (allNumber) return "number";

  // Date check
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}/, // ISO
    /^\d{1,2}\/\d{1,2}\/\d{2,4}/, // US
    /^\d{1,2}-\d{1,2}-\d{2,4}/, // EU
    /^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{2,4}/i, // "12 January 2024"
    /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{2,4}/i, // "January 12, 2024"
    /^\d{4}\/\d{2}\/\d{2}/, // YYYY/MM/DD
    /^\d{8}$/, // YYYYMMDD compact
  ];
  const allDate = nonEmpty.every(
    (v) => datePatterns.some((p) => p.test(v.trim())) && !isNaN(Date.parse(v))
  );
  if (allDate) return "date";

  return "string";
}

// ── Numeric metadata ──────────────────────────────────────────────

function extractNumericMeta(rawValues: string[]): NumericMeta {
  const nonEmpty = rawValues.filter((v) => v !== "" && v !== null && v !== undefined);

  // Detect currency
  const currencyMatches = nonEmpty.filter((v) => CURRENCY_RE.test(v));
  const isCurrency = currencyMatches.length / nonEmpty.length > 0.5;
  let currencySymbol: string | undefined;
  if (isCurrency) {
    const counts: Record<string, number> = {};
    for (const v of currencyMatches) {
      for (const sym of CURRENCY_SYMBOLS) {
        if (v.includes(sym)) {
          counts[sym] = (counts[sym] ?? 0) + 1;
        }
      }
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) currencySymbol = best[0];
  }

  // Detect percentage
  const percentMatches = nonEmpty.filter((v) => PERCENT_RE.test(v));
  const isPercentage = percentMatches.length / nonEmpty.length > 0.5;

  // Parse numbers
  const nums = nonEmpty.map((v) => Number(stripNumericFormatting(v))).filter((n) => !isNaN(n));

  if (nums.length === 0) {
    return {
      kind: "number",
      is_integer: true,
      decimal_precision: 0,
      is_currency: isCurrency,
      ...(currencySymbol && { currency_symbol: currencySymbol }),
      is_percentage: isPercentage,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      std_dev: 0,
      p25: 0,
      p75: 0,
      zero_count: 0,
      negative_count: 0,
    };
  }

  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const variance = nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / nums.length;

  // Decimal precision — max decimal places across stripped values
  let maxDecimals = 0;
  for (const v of nonEmpty) {
    const stripped = stripNumericFormatting(v);
    const dot = stripped.indexOf(".");
    if (dot !== -1) {
      const decimals = stripped.length - dot - 1;
      if (decimals > maxDecimals) maxDecimals = decimals;
    }
  }

  const isInteger = maxDecimals === 0;

  const stdDev = Math.sqrt(variance);
  const p25Val = percentile(sorted, 25);
  const p75Val = percentile(sorted, 75);
  const iqr = p75Val - p25Val;

  // Skewness (Fisher's) and excess kurtosis
  let skewness: number | undefined;
  let kurtosis: number | undefined;
  if (nums.length >= 3 && stdDev > 0) {
    const m3 = nums.reduce((acc, n) => acc + ((n - mean) / stdDev) ** 3, 0) / nums.length;
    const m4 = nums.reduce((acc, n) => acc + ((n - mean) / stdDev) ** 4, 0) / nums.length;
    skewness = round(m3, 2);
    kurtosis = round(m4 - 3, 2); // excess kurtosis
  }

  // Outlier count: beyond 1.5×IQR fences
  const lowerFence = p25Val - 1.5 * iqr;
  const upperFence = p75Val + 1.5 * iqr;
  const outlierCount = nums.filter((n) => n < lowerFence || n > upperFence).length;

  const meta: NumericMeta = {
    kind: "number",
    is_integer: isInteger,
    decimal_precision: maxDecimals,
    is_currency: isCurrency,
    is_percentage: isPercentage,
    min: round(sorted[0], 4),
    max: round(sorted[sorted.length - 1], 4),
    mean: round(mean, 2),
    median: round(percentile(sorted, 50), 2),
    std_dev: round(stdDev, 2),
    p25: round(p25Val, 2),
    p75: round(p75Val, 2),
    zero_count: nums.filter((n) => n === 0).length,
    negative_count: nums.filter((n) => n < 0).length,
    ...(skewness !== undefined && { skewness }),
    ...(kurtosis !== undefined && { kurtosis }),
    ...(outlierCount > 0 && { outlier_count: outlierCount }),
  };

  if (currencySymbol) meta.currency_symbol = currencySymbol;

  return meta;
}

// ── Date metadata ─────────────────────────────────────────────────

const DATE_FORMAT_PATTERNS: { re: RegExp; format: string }[] = [
  { re: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, format: "YYYY-MM-DDTHH:mm:ss" },
  { re: /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/, format: "YYYY-MM-DD HH:mm:ss" },
  { re: /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/, format: "YYYY-MM-DD HH:mm" },
  { re: /^\d{4}-\d{2}-\d{2}$/, format: "YYYY-MM-DD" },
  { re: /^\d{4}-\d{2}$/, format: "YYYY-MM" },
  { re: /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/, format: "MM/DD/YYYY HH:mm:ss" },
  { re: /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{2}:\d{2}/, format: "MM/DD/YYYY HH:mm" },
  { re: /^\d{1,2}\/\d{1,2}\/\d{4}/, format: "MM/DD/YYYY" },
  { re: /^\d{1,2}\/\d{1,2}\/\d{2}$/, format: "MM/DD/YY" },
  { re: /^\d{1,2}-\d{1,2}-\d{4}/, format: "DD-MM-YYYY" },
  { re: /^\d{4}\/\d{2}\/\d{2}/, format: "YYYY/MM/DD" },
  { re: /^\d{8}$/, format: "YYYYMMDD" },
  {
    re: /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}/i,
    format: "Month DD, YYYY",
  },
  {
    re: /^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}/i,
    format: "DD Month YYYY",
  },
];

const MONTH_NAME_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

const DAY_NAME_RE =
  /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;

function inferGranularity(timestamps: number[]): DateMeta["granularity"] {
  if (timestamps.length < 2) return "day";
  const sorted = [...timestamps].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i] - sorted[i - 1]);
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const seconds = medianGap / 1000;

  if (seconds < 60) return "second";
  if (seconds < 3600) return "minute";
  if (seconds < 86400) return "hour";
  if (seconds < 86400 * 5) return "day";
  if (seconds < 86400 * 14) return "week";
  if (seconds < 86400 * 70) return "month";
  if (seconds < 86400 * 200) return "quarter";
  return "year";
}

function extractDateMeta(rawValues: string[]): DateMeta {
  const nonEmpty = rawValues.filter((v) => v !== "" && v !== null && v !== undefined);

  // Detect format
  let format = "unknown";
  for (const { re, format: fmt } of DATE_FORMAT_PATTERNS) {
    if (nonEmpty.length > 0 && re.test(nonEmpty[0].trim())) {
      format = fmt;
      break;
    }
  }

  // Parse timestamps
  const timestamps = nonEmpty.map((v) => Date.parse(v)).filter((ts) => !isNaN(ts));

  const sorted = [...timestamps].sort((a, b) => a - b);
  const minDate = sorted.length > 0 ? new Date(sorted[0]).toISOString().split("T")[0] : "unknown";
  const maxDate =
    sorted.length > 0 ? new Date(sorted[sorted.length - 1]).toISOString().split("T")[0] : "unknown";

  const usesMonthNames = nonEmpty.some((v) => MONTH_NAME_RE.test(v));
  const usesDayNames = nonEmpty.some((v) => DAY_NAME_RE.test(v));
  const hasTime = nonEmpty.some((v) => /\d{2}:\d{2}/.test(v));

  return {
    kind: "date",
    format,
    min_date: minDate,
    max_date: maxDate,
    uses_month_names: usesMonthNames,
    uses_day_names: usesDayNames,
    has_time: hasTime,
    granularity: inferGranularity(timestamps),
  };
}

// ── String pattern detection ──────────────────────────────────────

const STRING_PATTERNS: { name: string; re: RegExp; threshold: number }[] = [
  { name: "email", re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, threshold: 0.7 },
  { name: "url", re: /^https?:\/\/.+/i, threshold: 0.7 },
  {
    name: "phone",
    re: /^[+]?[\d\s().-]{7,20}$/,
    threshold: 0.7,
  },
  { name: "zip_us", re: /^\d{5}(-\d{4})?$/, threshold: 0.8 },
  {
    name: "uuid",
    re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    threshold: 0.8,
  },
  {
    name: "ip_address",
    re: /^(\d{1,3}\.){3}\d{1,3}$/,
    threshold: 0.8,
  },
  { name: "hex_color", re: /^#[0-9a-fA-F]{6}$/, threshold: 0.8 },
  { name: "iso_country", re: /^[A-Z]{2}$/, threshold: 0.9 },
];

function detectStructuralCode(sample: string[]): string | undefined {
  if (sample.length < 5) return undefined;

  // Try to generalize: replace letter runs with A, digit runs with N
  const patterns = sample
    .slice(0, 50)
    .map((v) => v.replace(/[A-Za-z]+/g, "A").replace(/\d+/g, "N"));

  const counts: Record<string, number> = {};
  for (const p of patterns) {
    counts[p] = (counts[p] ?? 0) + 1;
  }

  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] / patterns.length >= 0.6 && best[0].length <= 20) {
    return `code:${best[0]}`;
  }
  return undefined;
}

function detectStringPattern(sample: string[]): string | undefined {
  const testSet = sample.slice(0, 200);
  if (testSet.length === 0) return undefined;

  for (const { name, re, threshold } of STRING_PATTERNS) {
    const matchCount = testSet.filter((v) => re.test(v.trim())).length;
    if (matchCount / testSet.length >= threshold) return name;
  }

  return detectStructuralCode(testSet);
}

// ── Categorical metadata ──────────────────────────────────────────

function extractCategoricalMeta(rawValues: string[]): CategoricalMeta {
  const nonEmpty = rawValues.filter((v) => v !== "" && v !== null && v !== undefined);

  // Frequency map
  const freq: Record<string, number> = {};
  for (const v of nonEmpty) {
    freq[v] = (freq[v] ?? 0) + 1;
  }

  const distinctValues = Object.keys(freq);
  const distinctCount = distinctValues.length;
  const isUnique = distinctCount === nonEmpty.length && nonEmpty.length > 1;

  // String length stats
  const lengths = nonEmpty.map((v) => v.length);
  const avgLength =
    lengths.length > 0 ? round(lengths.reduce((a, b) => a + b, 0) / lengths.length, 1) : 0;
  const maxLength = lengths.length > 0 ? Math.max(...lengths) : 0;
  const minLength = lengths.length > 0 ? Math.min(...lengths) : 0;

  const meta: CategoricalMeta = {
    kind: "categorical",
    distinct_count: distinctCount,
    avg_length: avgLength,
    max_length: maxLength,
    min_length: minLength,
    is_unique: isUnique,
  };

  // Include distinct values if ≤30, otherwise top 10
  if (distinctCount <= 30) {
    meta.distinct_values = distinctValues.sort();
  } else {
    meta.top_values = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));
  }

  // Pattern detection
  const pattern = detectStringPattern(nonEmpty);
  if (pattern) meta.detected_pattern = pattern;

  return meta;
}

// ── Boolean metadata ──────────────────────────────────────────────

function extractBooleanMeta(rawValues: string[]): BooleanMeta {
  const nonEmpty = rawValues.filter((v) => v !== "" && v !== null && v !== undefined);

  let trueCount = 0;
  let falseCount = 0;
  let hasTrueFalse = false;
  let hasZeroOne = false;
  let hasYesNo = false;

  for (const v of nonEmpty) {
    const lower = v.toLowerCase().trim();
    if (lower === "true") {
      trueCount++;
      hasTrueFalse = true;
    } else if (lower === "false") {
      falseCount++;
      hasTrueFalse = true;
    } else if (lower === "1") {
      trueCount++;
      hasZeroOne = true;
    } else if (lower === "0") {
      falseCount++;
      hasZeroOne = true;
    } else if (lower === "yes") {
      trueCount++;
      hasYesNo = true;
    } else if (lower === "no") {
      falseCount++;
      hasYesNo = true;
    }
  }

  let representation: BooleanMeta["representation"] = "mixed";
  const repCount = [hasTrueFalse, hasZeroOne, hasYesNo].filter(Boolean).length;
  if (repCount === 1) {
    if (hasTrueFalse) representation = "true/false";
    else if (hasZeroOne) representation = "0/1";
    else if (hasYesNo) representation = "yes/no";
  }

  return {
    kind: "boolean",
    true_count: trueCount,
    false_count: falseCount,
    representation,
  };
}

// ── Extract column metadata by dtype ──────────────────────────────

function extractColumnMeta(dtype: CSVColumn["dtype"], rawValues: string[]): ColumnMeta {
  switch (dtype) {
    case "number":
      return extractNumericMeta(rawValues);
    case "date":
      return extractDateMeta(rawValues);
    case "boolean":
      return extractBooleanMeta(rawValues);
    case "string":
      return extractCategoricalMeta(rawValues);
  }
}

// ── Public API ────────────────────────────────────────────────────

// ── Domain detection ──────────────────────────────────────────────

/** OHLC column name patterns (case-insensitive) */
const OHLC_PATTERNS = [/\bopen\b/i, /\bhigh\b/i, /\blow\b/i, /\bclose\b/i];
const FINANCIAL_NAME_PATTERNS = [
  /\b(price|volume|ticker|symbol|market.?cap|dividend|eps|pe.?ratio|revenue|profit|loss|margin|ebitda|nav|aum|yield|coupon|maturity|strike|bid|ask|spread)\b/i,
];
const RETURN_PATTERNS = [
  /\b(return|pnl|p&l|gain|drawdown|sharpe|sortino|volatility|beta|alpha|cagr)\b/i,
];

function detectDomain(columns: CSVColumn[]): DataDomain {
  const names = columns.map((c) => c.name);
  const hasDate = columns.some((c) => c.dtype === "date");
  const numericCols = columns.filter((c) => c.dtype === "number");

  // OHLC detection: at least 3 of 4 OHLC columns present
  const ohlcMatches = OHLC_PATTERNS.filter((p) => names.some((n) => p.test(n))).length;
  if (ohlcMatches >= 3) return "financial";

  // Financial keyword detection in column names
  const financialHits = names.filter(
    (n) => FINANCIAL_NAME_PATTERNS.some((p) => p.test(n)) || RETURN_PATTERNS.some((p) => p.test(n))
  ).length;
  if (financialHits >= 2) return "financial";

  // Currency columns
  const currencyCols = numericCols.filter((c) => c.meta.kind === "number" && c.meta.is_currency);
  if (currencyCols.length >= 2) return "financial";

  // Time series: has a date column + multiple numeric columns
  if (hasDate && numericCols.length >= 2) return "time_series";

  // Statistical: many numeric columns without dates (cross-sectional data)
  if (!hasDate && numericCols.length >= 5) return "statistical";

  return "general";
}

// ── Pairwise correlations ────────────────────────────────────────

function computeCorrelations(
  parsed: ParsedCSV,
  columns: CSVColumn[],
  maxPairs: number = 5
): ColumnCorrelation[] {
  const numericCols = columns.filter((c) => c.dtype === "number");
  if (numericCols.length < 2) return [];

  // Cap at first 1000 rows for performance
  const sampleData = parsed.data.slice(0, 1000);

  // Parse numeric arrays
  const numArrays: Record<string, number[]> = {};
  for (const col of numericCols) {
    numArrays[col.name] = sampleData.map((row) => {
      const raw = row[col.name] ?? "";
      return Number(stripNumericFormatting(raw));
    });
  }

  const pairs: ColumnCorrelation[] = [];
  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const a = numArrays[numericCols[i].name];
      const b = numArrays[numericCols[j].name];

      // Filter to rows where both are valid numbers
      const validPairs: [number, number][] = [];
      for (let k = 0; k < a.length; k++) {
        if (!isNaN(a[k]) && !isNaN(b[k])) validPairs.push([a[k], b[k]]);
      }
      if (validPairs.length < 10) continue;

      const meanA = validPairs.reduce((s, p) => s + p[0], 0) / validPairs.length;
      const meanB = validPairs.reduce((s, p) => s + p[1], 0) / validPairs.length;
      let cov = 0,
        varA = 0,
        varB = 0;
      for (const [va, vb] of validPairs) {
        const da = va - meanA;
        const db = vb - meanB;
        cov += da * db;
        varA += da * da;
        varB += db * db;
      }
      const denom = Math.sqrt(varA * varB);
      if (denom === 0) continue;
      const pearson = round(cov / denom, 3);

      pairs.push({ col_a: numericCols[i].name, col_b: numericCols[j].name, pearson });
    }
  }

  // Return top pairs by absolute correlation
  pairs.sort((a, b) => Math.abs(b.pearson) - Math.abs(a.pearson));
  return pairs.slice(0, maxPairs);
}

// ── Public API ────────────────────────────────────────────────────

export function extractSchema(parsed: ParsedCSV, csvId: string, filename: string): CSVSchema {
  const columns: CSVColumn[] = parsed.headers.map((name) => {
    const values = parsed.data.map((row) => row[name] ?? "");
    const nonEmpty = values.filter((v) => v !== "" && v !== null && v !== undefined);
    const nullCount = values.length - nonEmpty.length;
    const dtype = inferDtype(values.slice(0, 100));
    const meta = extractColumnMeta(dtype, values);
    const sampleValues = nonEmpty.slice(0, MAX_SAMPLE_ROWS);

    // Add null_pct to numeric metadata
    if (meta.kind === "number" && values.length > 0) {
      meta.null_pct = round((nullCount / values.length) * 100, 1);
    }

    return { name, dtype, null_count: nullCount, meta, sample_values: sampleValues };
  });

  const sampleRows = parsed.data.slice(0, MAX_PREVIEW_ROWS);
  const detected_domain = detectDomain(columns);
  const correlations = computeCorrelations(parsed, columns);

  return {
    csv_id: csvId,
    filename,
    row_count: parsed.rowCount,
    columns,
    sample_rows: sampleRows,
    detected_domain,
    ...(correlations.length > 0 && { correlations }),
  };
}
