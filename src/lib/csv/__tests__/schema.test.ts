import { describe, it, expect } from "vitest";
import { extractSchema } from "@/lib/csv/schema";
import type { ParsedCSV } from "@/lib/csv/parser";
import type {
  CSVColumn,
  NumericMeta,
  DateMeta,
  CategoricalMeta,
  BooleanMeta,
} from "@/lib/contracts/data-schema";

// ── Helpers ────────────────────────────────────────────────────────

/** Build a ParsedCSV from a header list and a matrix of row values. */
function makeParsed(headers: string[], rows: string[][]): ParsedCSV {
  const data = rows.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? "";
    });
    return obj;
  });
  return { headers, data, rowCount: data.length };
}

/** Build a ParsedCSV for a single column from a list of cell values. */
function singleColumn(name: string, values: string[]): ParsedCSV {
  return makeParsed(
    [name],
    values.map((v) => [v])
  );
}

function col(schema: ReturnType<typeof extractSchema>, name: string): CSVColumn {
  const c = schema.columns.find((x) => x.name === name);
  if (!c) throw new Error(`column ${name} not found`);
  return c;
}

// ── Top-level shape ────────────────────────────────────────────────

describe("extractSchema — top-level shape", () => {
  it("threads csv_id, filename, row_count, and column names through", () => {
    const parsed = makeParsed(
      ["a", "b"],
      [
        ["1", "x"],
        ["2", "y"],
        ["3", "z"],
      ]
    );
    const schema = extractSchema(parsed, "csv-123", "data.csv");

    expect(schema.csv_id).toBe("csv-123");
    expect(schema.filename).toBe("data.csv");
    expect(schema.row_count).toBe(3); // mirrors parsed.rowCount
    expect(schema.columns.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("caps sample_rows at MAX_PREVIEW_ROWS (10)", () => {
    const rows = Array.from({ length: 25 }, (_, i) => [String(i)]);
    const parsed = singleColumn(
      "n",
      rows.map((r) => r[0])
    );
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.sample_rows).toHaveLength(10);
    expect(schema.row_count).toBe(25);
  });

  it("caps each column's sample_values at MAX_SAMPLE_ROWS (5) from non-empty values", () => {
    const vals = ["", "a", "b", "", "c", "d", "e", "f", "g"];
    const schema = extractSchema(singleColumn("s", vals), "id", "f.csv");
    const c = col(schema, "s");
    // Non-empty: a,b,c,d,e,f,g → first 5
    expect(c.sample_values).toEqual(["a", "b", "c", "d", "e"]);
  });
});

// ── dtype inference ────────────────────────────────────────────────

describe("inferDtype (via extractSchema)", () => {
  it("infers number for plain integers", () => {
    const schema = extractSchema(singleColumn("n", ["10", "20", "30"]), "id", "f.csv");
    expect(col(schema, "n").dtype).toBe("number");
  });

  it("infers number for currency/percent/comma formatted values", () => {
    const schema = extractSchema(
      singleColumn("p", ["$1,000.50", "$2,000", "$3,500.25"]),
      "id",
      "f.csv"
    );
    expect(col(schema, "p").dtype).toBe("number");
  });

  it("infers boolean for true/false", () => {
    const schema = extractSchema(
      singleColumn("b", ["true", "false", "TRUE", "False"]),
      "id",
      "f.csv"
    );
    expect(col(schema, "b").dtype).toBe("boolean");
  });

  it("infers boolean for a pure 0/1 column (boolean check precedes number check)", () => {
    const schema = extractSchema(singleColumn("flag", ["0", "1", "1", "0"]), "id", "f.csv");
    expect(col(schema, "flag").dtype).toBe("boolean");
  });

  it("infers date for ISO dates", () => {
    const schema = extractSchema(
      singleColumn("d", ["2024-01-01", "2024-02-01", "2024-03-01"]),
      "id",
      "f.csv"
    );
    expect(col(schema, "d").dtype).toBe("date");
  });

  it("falls back to string for free text", () => {
    const schema = extractSchema(singleColumn("t", ["apple", "banana", "cherry"]), "id", "f.csv");
    expect(col(schema, "t").dtype).toBe("string");
  });

  it("returns string for an all-empty column", () => {
    const schema = extractSchema(singleColumn("e", ["", "", ""]), "id", "f.csv");
    expect(col(schema, "e").dtype).toBe("string");
  });

  it("infers dtype over ALL rows, not just the first 100 (finding M8a)", () => {
    // First 100 rows numeric, then non-numeric text afterwards. Head-only
    // inference typed this "number" and the numeric extractor silently dropped
    // the trailing text rows; inferring over every value types it "string".
    const numeric = Array.from({ length: 100 }, (_, i) => String(i + 1));
    const text = ["foo", "bar"];
    const schema = extractSchema(singleColumn("x", [...numeric, ...text]), "id", "f.csv");
    expect(col(schema, "x").dtype).toBe("string");
  });
});

// ── Numeric metadata ───────────────────────────────────────────────

describe("extractNumericMeta", () => {
  it("computes min/max/mean/median and integer flag", () => {
    const schema = extractSchema(singleColumn("n", ["1", "2", "3", "4", "5"]), "id", "f.csv");
    const meta = col(schema, "n").meta as NumericMeta;
    expect(meta.kind).toBe("number");
    expect(meta.is_integer).toBe(true);
    expect(meta.decimal_precision).toBe(0);
    expect(meta.min).toBe(1);
    expect(meta.max).toBe(5);
    expect(meta.mean).toBe(3);
    expect(meta.median).toBe(3);
    expect(meta.zero_count).toBe(0);
    expect(meta.negative_count).toBe(0);
  });

  it("detects floats and decimal precision", () => {
    const schema = extractSchema(singleColumn("f", ["1.5", "2.25", "3.125"]), "id", "f.csv");
    const meta = col(schema, "f").meta as NumericMeta;
    expect(meta.is_integer).toBe(false);
    expect(meta.decimal_precision).toBe(3); // "3.125" → 3 decimals
    expect(meta.mean).toBe(round((1.5 + 2.25 + 3.125) / 3, 2));
  });

  it("counts zeros and negatives", () => {
    const schema = extractSchema(singleColumn("n", ["-2", "-1", "0", "1", "2"]), "id", "f.csv");
    const meta = col(schema, "n").meta as NumericMeta;
    expect(meta.zero_count).toBe(1);
    expect(meta.negative_count).toBe(2);
    expect(meta.min).toBe(-2);
    expect(meta.max).toBe(2);
    expect(meta.mean).toBe(0);
  });

  it("detects currency and dominant currency symbol", () => {
    const schema = extractSchema(
      singleColumn("price", ["$10", "$20", "$30", "$40"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "price").meta as NumericMeta;
    expect(meta.is_currency).toBe(true);
    expect(meta.currency_symbol).toBe("$");
    expect(meta.is_percentage).toBe(false);
  });

  it("does not flag currency when fewer than half the values carry a symbol", () => {
    // 2 of 5 carry "$" → 0.4, not > 0.5
    const schema = extractSchema(
      singleColumn("v", ["$10", "$20", "30", "40", "50"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "v").meta as NumericMeta;
    expect(meta.is_currency).toBe(false);
  });

  it("detects percentage", () => {
    const schema = extractSchema(singleColumn("pct", ["10%", "20%", "30%"]), "id", "f.csv");
    const meta = col(schema, "pct").meta as NumericMeta;
    expect(meta.is_percentage).toBe(true);
  });

  it("computes p25/p75 and std_dev for a known distribution", () => {
    // values 0..10 inclusive (11 values)
    const vals = Array.from({ length: 11 }, (_, i) => String(i));
    const schema = extractSchema(singleColumn("n", vals), "id", "f.csv");
    const meta = col(schema, "n").meta as NumericMeta;
    // percentile uses linear interpolation on the (length-1) index basis:
    // p25 idx = .25*10 = 2.5 → 2.5; p75 idx = .75*10 = 7.5 → 7.5
    expect(meta.p25).toBe(2.5);
    expect(meta.p75).toBe(7.5);
    expect(meta.median).toBe(5);
    // population std-dev of 0..10 = sqrt(10) ≈ 3.1623 → rounded 2dp
    expect(meta.std_dev).toBe(3.16);
  });

  it("reports null_pct based on empty cells", () => {
    const schema = extractSchema(singleColumn("n", ["1", "", "3", ""]), "id", "f.csv");
    const c = col(schema, "n");
    expect(c.null_count).toBe(2);
    const meta = c.meta as NumericMeta;
    expect(meta.null_pct).toBe(50); // 2/4 * 100
  });

  it("flags outliers beyond the 1.5×IQR fence", () => {
    // tight cluster plus one extreme high value
    const vals = ["10", "11", "12", "13", "14", "15", "16", "17", "18", "1000"];
    const schema = extractSchema(singleColumn("n", vals), "id", "f.csv");
    const meta = col(schema, "n").meta as NumericMeta;
    expect(meta.outlier_count).toBeGreaterThanOrEqual(1);
  });
});

// ── Date metadata ──────────────────────────────────────────────────

describe("extractDateMeta", () => {
  it("infers day granularity and min/max dates for consecutive daily ISO dates", () => {
    const schema = extractSchema(
      singleColumn("d", ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "d").meta as DateMeta;
    expect(meta.kind).toBe("date");
    expect(meta.format).toBe("YYYY-MM-DD");
    expect(meta.min_date).toBe("2024-01-01");
    expect(meta.max_date).toBe("2024-01-04");
    expect(meta.granularity).toBe("day");
    expect(meta.has_time).toBe(false);
    expect(meta.uses_month_names).toBe(false);
  });

  it("infers month granularity from ~monthly spacing", () => {
    const schema = extractSchema(
      singleColumn("d", ["2024-01-15", "2024-02-15", "2024-03-15", "2024-04-15"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "d").meta as DateMeta;
    // median gap ~31 days → between 14 and 70 → "month"
    expect(meta.granularity).toBe("month");
  });

  it("infers year granularity from ~yearly spacing", () => {
    const schema = extractSchema(
      singleColumn("d", ["2020-01-01", "2021-01-01", "2022-01-01", "2023-01-01"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "d").meta as DateMeta;
    expect(meta.granularity).toBe("year");
  });

  it("detects timestamps with a time component and second granularity", () => {
    const schema = extractSchema(
      singleColumn("ts", ["2024-01-01T00:00:01", "2024-01-01T00:00:02", "2024-01-01T00:00:03"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "ts").meta as DateMeta;
    expect(meta.format).toBe("YYYY-MM-DDTHH:mm:ss");
    expect(meta.has_time).toBe(true);
    expect(meta.granularity).toBe("second");
  });

  it("detects month-name format", () => {
    const schema = extractSchema(
      singleColumn("d", ["January 12, 2024", "February 12, 2024", "March 12, 2024"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "d").meta as DateMeta;
    expect(meta.kind).toBe("date");
    expect(meta.format).toBe("Month DD, YYYY");
    expect(meta.uses_month_names).toBe(true);
  });
});

// ── Boolean metadata ───────────────────────────────────────────────

describe("extractBooleanMeta", () => {
  it("counts true/false and reports representation", () => {
    const schema = extractSchema(
      singleColumn("b", ["true", "false", "true", "true"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "b").meta as BooleanMeta;
    expect(meta.kind).toBe("boolean");
    expect(meta.true_count).toBe(3);
    expect(meta.false_count).toBe(1);
    expect(meta.representation).toBe("true/false");
  });

  it("reports yes/no representation", () => {
    const schema = extractSchema(singleColumn("b", ["yes", "no", "yes"]), "id", "f.csv");
    const meta = col(schema, "b").meta as BooleanMeta;
    expect(meta.representation).toBe("yes/no");
    expect(meta.true_count).toBe(2);
    expect(meta.false_count).toBe(1);
  });

  it("reports 0/1 representation", () => {
    const schema = extractSchema(singleColumn("b", ["1", "0", "1"]), "id", "f.csv");
    const meta = col(schema, "b").meta as BooleanMeta;
    expect(meta.representation).toBe("0/1");
  });

  it("reports mixed representation when more than one form is present", () => {
    const schema = extractSchema(singleColumn("b", ["true", "1", "no", "false"]), "id", "f.csv");
    const meta = col(schema, "b").meta as BooleanMeta;
    expect(meta.representation).toBe("mixed");
  });
});

// ── Categorical metadata ───────────────────────────────────────────

describe("extractCategoricalMeta", () => {
  it("lists sorted distinct_values when distinct_count <= 30 (no top_values)", () => {
    const schema = extractSchema(
      singleColumn("cat", ["b", "a", "b", "c", "a", "a"]),
      "id",
      "f.csv"
    );
    const meta = col(schema, "cat").meta as CategoricalMeta;
    expect(meta.kind).toBe("categorical");
    expect(meta.distinct_count).toBe(3);
    expect(meta.distinct_values).toEqual(["a", "b", "c"]); // sorted
    expect(meta.top_values).toBeUndefined();
    expect(meta.is_unique).toBe(false);
  });

  it("emits top_values (top 10 by count desc) when distinct_count > 30", () => {
    // 31 distinct categories so we cross the 30 threshold.
    // Give "hot" a huge count so it sorts to the top deterministically.
    const rows: string[] = [];
    for (let i = 0; i < 31; i++) rows.push(`c${i}`); // 31 distinct, each once
    for (let i = 0; i < 50; i++) rows.push("hot"); // makes "hot" the most frequent
    // Now distinct = 32 ( > 30 )
    const schema = extractSchema(singleColumn("cat", rows), "id", "f.csv");
    const meta = col(schema, "cat").meta as CategoricalMeta;
    expect(meta.distinct_count).toBe(32);
    expect(meta.distinct_values).toBeUndefined();
    expect(meta.top_values).toBeDefined();
    expect(meta.top_values).toHaveLength(10);
    expect(meta.top_values![0]).toEqual({ value: "hot", count: 50 });
    // all counts are descending
    const counts = meta.top_values!.map((t) => t.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("flags is_unique for an all-unique multi-row column", () => {
    const schema = extractSchema(singleColumn("id", ["x1", "x2", "x3", "x4"]), "id", "f.csv");
    const meta = col(schema, "id").meta as CategoricalMeta;
    expect(meta.is_unique).toBe(true);
    expect(meta.distinct_count).toBe(4);
  });

  it("does not flag is_unique for a single-value column (needs length > 1)", () => {
    const schema = extractSchema(singleColumn("only", ["solo"]), "id", "f.csv");
    const meta = col(schema, "only").meta as CategoricalMeta;
    expect(meta.is_unique).toBe(false);
    expect(meta.distinct_count).toBe(1);
  });

  it("computes string length stats", () => {
    const schema = extractSchema(singleColumn("s", ["a", "bb", "ccc"]), "id", "f.csv");
    const meta = col(schema, "s").meta as CategoricalMeta;
    expect(meta.min_length).toBe(1);
    expect(meta.max_length).toBe(3);
    expect(meta.avg_length).toBe(2); // (1+2+3)/3
  });

  it("detects an email pattern", () => {
    const vals = ["a@x.com", "b@y.com", "c@z.com", "d@w.com", "e@v.com", "f@u.com"];
    const schema = extractSchema(singleColumn("email", vals), "id", "f.csv");
    const meta = col(schema, "email").meta as CategoricalMeta;
    expect(meta.detected_pattern).toBe("email");
  });
});

// ── Categorical-vs-numeric / boolean boundary ──────────────────────

describe("dtype boundary behaviour", () => {
  it("treats numbers mixed with text as a string (categorical) column", () => {
    const schema = extractSchema(singleColumn("mixed", ["1", "2", "three", "4"]), "id", "f.csv");
    const c = col(schema, "mixed");
    expect(c.dtype).toBe("string");
    expect(c.meta.kind).toBe("categorical");
  });

  it("treats a multi-valued integer column (not all 0/1) as number, not boolean", () => {
    const schema = extractSchema(singleColumn("n", ["0", "1", "2", "3"]), "id", "f.csv");
    expect(col(schema, "n").dtype).toBe("number");
  });
});

// ── Edge cases ─────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles a single-row dataset", () => {
    const parsed = makeParsed(["n", "s"], [["42", "hello"]]);
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.row_count).toBe(1);
    const numMeta = col(schema, "n").meta as NumericMeta;
    expect(numMeta.kind).toBe("number");
    expect(numMeta.min).toBe(42);
    expect(numMeta.max).toBe(42);
    expect(numMeta.mean).toBe(42);
    // single value → no skewness/kurtosis (needs >= 3)
    expect(numMeta.skewness).toBeUndefined();
    const catMeta = col(schema, "s").meta as CategoricalMeta;
    expect(catMeta.is_unique).toBe(false); // length not > 1
  });

  it("handles an all-empty column as an empty categorical", () => {
    const schema = extractSchema(singleColumn("e", ["", "", ""]), "id", "f.csv");
    const c = col(schema, "e");
    expect(c.dtype).toBe("string");
    expect(c.null_count).toBe(3);
    const meta = c.meta as CategoricalMeta;
    expect(meta.distinct_count).toBe(0);
    expect(meta.distinct_values).toEqual([]);
    expect(meta.avg_length).toBe(0);
    expect(meta.is_unique).toBe(false);
  });

  it("handles an empty dataset (no rows)", () => {
    const parsed: ParsedCSV = { headers: ["a"], data: [], rowCount: 0 };
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.row_count).toBe(0);
    expect(schema.sample_rows).toEqual([]);
    const c = col(schema, "a");
    expect(c.dtype).toBe("string");
    expect(c.null_count).toBe(0);
    // null_pct only added when values.length > 0, here it's 0 → none added,
    // but dtype is string anyway so meta is categorical.
    expect(c.meta.kind).toBe("categorical");
  });
});

// ── Domain detection ───────────────────────────────────────────────

describe("detectDomain", () => {
  it("detects financial via OHLC column names", () => {
    const parsed = makeParsed(
      ["open", "high", "low", "close"],
      [
        ["10", "12", "9", "11"],
        ["11", "13", "10", "12"],
      ]
    );
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.detected_domain).toBe("financial");
  });

  it("detects financial via >=2 financial keyword column names", () => {
    const parsed = makeParsed(
      ["ticker", "revenue", "name"],
      [
        ["AAA", "100", "Acme"],
        ["BBB", "200", "Beta"],
      ]
    );
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.detected_domain).toBe("financial");
  });

  it("detects time_series with a date column plus >=2 numeric columns", () => {
    const parsed = makeParsed(
      ["day", "x", "y"],
      [
        ["2024-01-01", "1", "5"],
        ["2024-01-02", "2", "6"],
        ["2024-01-03", "3", "7"],
      ]
    );
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.detected_domain).toBe("time_series");
  });

  it("detects statistical with >=5 numeric columns and no date", () => {
    const headers = ["m1", "m2", "m3", "m4", "m5"];
    const rows = [
      ["1", "2", "3", "4", "5"],
      ["6", "7", "8", "9", "10"],
      ["11", "12", "13", "14", "15"],
    ];
    const parsed = makeParsed(headers, rows);
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.detected_domain).toBe("statistical");
  });

  it("falls back to general for plain mixed data", () => {
    const parsed = makeParsed(
      ["label", "qty"],
      [
        ["a", "1"],
        ["b", "2"],
      ]
    );
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.detected_domain).toBe("general");
  });
});

// ── Correlations ───────────────────────────────────────────────────

describe("computeCorrelations", () => {
  it("returns a perfect positive correlation for y = 2x", () => {
    const n = 12; // need >= 10 valid pairs
    const rows = Array.from({ length: n }, (_, i) => [String(i + 1), String((i + 1) * 2)]);
    const parsed = makeParsed(["x", "y"], rows);
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.correlations).toBeDefined();
    expect(schema.correlations).toHaveLength(1);
    const c = schema.correlations![0];
    expect(c.col_a).toBe("x");
    expect(c.col_b).toBe("y");
    expect(c.pearson).toBe(1);
  });

  it("returns a perfect negative correlation", () => {
    const n = 12;
    const rows = Array.from({ length: n }, (_, i) => [String(i + 1), String(-(i + 1))]);
    const parsed = makeParsed(["x", "y"], rows);
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.correlations![0].pearson).toBe(-1);
  });

  it("omits correlations entirely when there are fewer than 10 valid pairs", () => {
    const rows = Array.from({ length: 5 }, (_, i) => [String(i + 1), String(i + 1)]);
    const parsed = makeParsed(["x", "y"], rows);
    const schema = extractSchema(parsed, "id", "f.csv");
    // < 10 valid pairs → pair skipped → no correlations key
    expect(schema.correlations).toBeUndefined();
  });

  it("omits correlations when there is only one numeric column", () => {
    const rows = Array.from({ length: 12 }, (_, i) => [String(i), "text"]);
    const parsed = makeParsed(["x", "label"], rows);
    const schema = extractSchema(parsed, "id", "f.csv");
    expect(schema.correlations).toBeUndefined();
  });

  it("sorts returned pairs by absolute correlation strength (top first)", () => {
    // a strongly correlates with b (y=2x), weakly with c (noise-ish)
    const n = 20;
    const rows = Array.from({ length: n }, (_, i) => {
      const a = i + 1;
      const b = a * 2; // perfect with a
      const c = i % 2 === 0 ? 1 : 2; // weakly related to a
      return [String(a), String(b), String(c)];
    });
    const parsed = makeParsed(["a", "b", "c"], rows);
    const schema = extractSchema(parsed, "id", "f.csv");
    const corrs = schema.correlations!;
    // first pair should be the strongest by |pearson|
    const absSorted = corrs.map((c) => Math.abs(c.pearson));
    expect([...absSorted].sort((x, y) => y - x)).toEqual(absSorted);
    expect(Math.abs(corrs[0].pearson)).toBe(1); // a/b is perfect
  });
});

// local round mirroring schema.ts round() for assertions above
function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

describe("month keys vs the phone pattern (run-4 regression)", () => {
  it("classifies YYYY-MM month columns as dates, not phone-patterned strings", () => {
    const schema = extractSchema(
      singleColumn("month", ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06"]),
      "c1",
      "t.csv"
    );
    expect(schema.columns[0].dtype).toBe("date");
    expect(
      (schema.columns[0].meta as { detected_pattern?: string }).detected_pattern
    ).toBeUndefined();
  });

  it("still detects real phone numbers, and never claims ISO dates", () => {
    const phones = extractSchema(
      singleColumn("contact", [
        "555-123-4567",
        "(212) 555-0182",
        "+1 415 555 2671",
        "555-987-6543",
        "555 555 5555",
      ]),
      "c2",
      "t.csv"
    );
    expect((phones.columns[0].meta as { detected_pattern?: string }).detected_pattern).toBe(
      "phone"
    );

    // Short digit-and-dash codes (< 7 digits) must not read as phones either.
    const codes = extractSchema(
      singleColumn("code", ["12-345", "67-890", "11-222", "33-444", "55-666"]),
      "c3",
      "t.csv"
    );
    expect((codes.columns[0].meta as { detected_pattern?: string }).detected_pattern).not.toBe(
      "phone"
    );
  });
});

// ── Type-inference robustness (finding M8) ─────────────────────────

describe("dtype inference over all rows (M8a)", () => {
  it("types a column that turns non-numeric after row 100 as string, not number", () => {
    // Numeric for the first 100 rows, then a string, then more numbers. Head-only
    // inference typed this "number" and the numeric extractor dropped the string
    // rows; inferring over all values types it "string".
    const values = [...Array(100).fill("42"), "not-a-number", ...Array(20).fill("7")];
    const schema = extractSchema(singleColumn("mixed", values), "c", "t.csv");
    expect(col(schema, "mixed").dtype).toBe("string");
  });
});

describe("date parsing honors the detected format (M8b)", () => {
  it("parses a DD-MM-YYYY column with day>12 to the correct min/max_date", () => {
    const schema = extractSchema(
      singleColumn("d", ["13-05-2024", "25-12-2024", "01-01-2024"]),
      "c",
      "t.csv"
    );
    const c = col(schema, "d");
    expect(c.dtype).toBe("date");
    const meta = c.meta as DateMeta;
    expect(meta.format).toBe("DD-MM-YYYY");
    // Date.parse alone read these month-first (NaN for day>12); format-aware
    // parsing gets the range right.
    expect(meta.min_date).toBe("2024-01-01");
    expect(meta.max_date).toBe("2024-12-25");
  });
});

describe("granularity dedupes repeated timestamps (M8c)", () => {
  it("infers 'day' for a daily column with many rows per day, not 'second'", () => {
    // 10 distinct days, 50 identical-date rows each. Without deduping, most
    // adjacent gaps are 0 → median 0 → "second".
    const values: string[] = [];
    for (let day = 1; day <= 10; day++) {
      const ds = `2024-01-${String(day).padStart(2, "0")}`;
      for (let r = 0; r < 50; r++) values.push(ds);
    }
    const schema = extractSchema(singleColumn("dt", values), "c", "t.csv");
    const meta = col(schema, "dt").meta as DateMeta;
    expect(meta.kind).toBe("date");
    expect(meta.granularity).toBe("day");
  });
});

describe("extractSchema — dtype overrides (build log D25)", () => {
  /**
   * The Parquet paths already KNOW the column types; text inference is only a
   * fallback for real CSVs. Without the override a parquet column round-tripped
   * through CSV gets re-guessed, and a typed source silently becomes a
   * mis-typed schema.
   */
  const parsed = {
    headers: ["id", "when", "note"],
    data: [
      { id: "20240101", when: "2024-01-01", note: "5" },
      { id: "20240102", when: "2024-01-02", note: "6" },
    ],
    rowCount: 2,
  };

  it("honors the caller's dtype over what the text looks like", () => {
    const schema = extractSchema(parsed, "cid", "f.parquet", {
      id: "string", // 8-digit ints that inference would happily call numbers/dates
      note: "string", // "5"/"6" look numeric
    });
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c.dtype]));
    expect(byName.id).toBe("string");
    expect(byName.note).toBe("string");
  });

  it("still INFERS any column the caller did not name", () => {
    const schema = extractSchema(parsed, "cid", "f.parquet", { id: "string" });
    const when = schema.columns.find((c) => c.name === "when");
    expect(when?.dtype).toBe("date");
  });

  it("drives meta extraction from the OVERRIDE, not the inferred type", () => {
    // The meta shape follows dtype: a forced "string" must produce categorical
    // meta, not the numeric meta inference would have built.
    const schema = extractSchema(parsed, "cid", "f.parquet", { note: "string" });
    expect(schema.columns.find((c) => c.name === "note")?.meta.kind).toBe("categorical");
  });

  it("behaves exactly as before when no overrides are passed", () => {
    expect(extractSchema(parsed, "cid", "f.csv")).toEqual(
      extractSchema(parsed, "cid", "f.csv", {})
    );
  });
});
