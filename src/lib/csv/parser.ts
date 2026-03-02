import Papa from "papaparse";

export interface ParsedCSV {
  headers: string[];
  data: Record<string, string>[];
  rowCount: number;
}

/**
 * Ensure every header is non-empty and unique so the schema column names
 * match what `pd.read_csv` will produce in the sandbox.
 */
function sanitizeHeaders(headers: string[]): {
  clean: string[];
  renamed: boolean;
} {
  const seen = new Map<string, number>();
  const clean: string[] = [];
  let renamed = false;

  for (let i = 0; i < headers.length; i++) {
    let h = headers[i].trim();
    if (!h) {
      h = `column_${i + 1}`;
      renamed = true;
    }
    const count = seen.get(h) ?? 0;
    if (count > 0) {
      h = `${h}_${count + 1}`;
      renamed = true;
    }
    seen.set(headers[i].trim() || `column_${i + 1}`, count + 1);
    seen.set(h, (seen.get(h) ?? 0));
    clean.push(h);
  }

  return { clean, renamed };
}

export function parseCSV(text: string): ParsedCSV {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  if (result.errors.length > 0) {
    const critical = result.errors.find(
      (e) => e.type === "Delimiter" || e.type === "FieldMismatch"
    );
    if (critical) {
      throw new Error(`CSV parse error: ${critical.message}`);
    }
  }

  const rawHeaders = result.meta.fields ?? [];
  const { clean, renamed } = sanitizeHeaders(rawHeaders);

  // If headers were renamed, remap row keys to match
  let data = result.data;
  if (renamed) {
    data = result.data.map((row) => {
      const out: Record<string, string> = {};
      for (let i = 0; i < rawHeaders.length; i++) {
        out[clean[i]] = row[rawHeaders[i]] ?? "";
      }
      return out;
    });
  }

  return {
    headers: clean,
    data,
    rowCount: data.length,
  };
}

/**
 * Re-serialize a ParsedCSV back to CSV text with sanitized headers.
 * Use this to ensure the stored CSV file has the same headers as the schema.
 */
export function toCSVText(parsed: ParsedCSV): string {
  return Papa.unparse({ fields: parsed.headers, data: parsed.data });
}
