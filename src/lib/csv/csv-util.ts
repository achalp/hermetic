/**
 * Canonical rows→CSV serialization — the ONLY place CSV escaping lives.
 *
 * Five warehouse connectors carried their own copy of csvValue + the
 * header/rows loop, and the copies had ALREADY drifted: databricks/snowflake
 * serialized Date → ISO and objects → JSON, while postgres/hive/trino
 * stringified them — postgres's pg driver returns Date objects for
 * timestamps, so those came out as locale strings ("Wed Jul 06 2026 …").
 * This is the superset behavior; an escaping fix now lands once.
 * (ClickHouse legitimately differs — it uses the server-side CSVWithNames
 * format.)
 *
 * Moved out of lib/warehouse (code-quality-hardening review): the re-rolled
 * copies had drifted AGAIN — bigquery joined headers unquoted (corrupting
 * comma-bearing column names), and step-frames/scheduler dropped \r handling.
 * Every rows→CSV call path must import from here.
 */

/** One CSV field: RFC-4180 quoting; Date → ISO; objects → JSON; null → "". */
export function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) {
    s = v.toISOString();
  } else if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v);
  }
  return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/** Serialize header + row objects to CSV text (trailing newline included). */
export function rowsToCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(csvValue).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvValue(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}
