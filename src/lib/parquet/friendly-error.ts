/**
 * Turn a raw DuckDB/Python schema-extraction traceback into a short, actionable,
 * user-facing message. The extractor runs a Python script in the sandbox; on
 * failure its stderr is a full traceback ending in e.g.
 * `duckdb.duckdb.IOException: IO Error: No files found that match the pattern …`.
 * Surfacing that verbatim in the UI (capped mid-word by apiError's 300-char cut)
 * is noise. This maps the common failure classes to plain English and, for the
 * unknown tail, extracts just the exception message instead of the whole stack.
 *
 * The RAW traceback is still logged server-side by the caller — this only shapes
 * the client copy.
 */
export function friendlyParquetError(rawStderr: string): string {
  const s = rawStderr || "";
  const lc = s.toLowerCase();
  const pref = "Couldn't read that Parquet source";

  // Order matters: most-specific / most-common first.
  if (/no files found that match the pattern/.test(lc)) {
    return `${pref}: no Parquet files were found at that location. Check the URL points to a Parquet file, or to a folder that contains .parquet files.`;
  }
  if (/nosuchbucket/.test(lc)) {
    return `${pref}: that bucket doesn't exist — check the bucket name in the URL.`;
  }
  if (/403|access denied|accessdenied|forbidden|signaturedoesnotmatch|invalidaccesskey/.test(lc)) {
    return `${pref}: access was denied. If the bucket is private, add credentials; if it's public, it may be in a different region.`;
  }
  if (/permanentredirect|authorizationheadermalformed|wrong region|different region/.test(lc)) {
    return `${pref}: the bucket appears to be in a different region than expected. Add the correct region (or a region-specific endpoint).`;
  }
  if (/404|nosuchkey|not found/.test(lc)) {
    return `${pref}: the location returned 404 (not found). Double-check the URL is correct.`;
  }
  if (/list-type|listobjects|unknown error for http get/.test(lc)) {
    return `${pref}: couldn't list files in that bucket. It may be private, empty, or in a different region.`;
  }
  if (
    /unable to connect|could not establish|connection refused|connection reset|timed out|timeout|network is unreachable|could not resolve|name or service not known|temporary failure in name resolution/.test(
      lc
    )
  ) {
    return `${pref}: couldn't reach the remote host. Check the URL and your network connection.`;
  }
  if (
    /not a parquet file|magic bytes|invalid input error|no magic bytes|expected .*parquet|thrift|corrupt/.test(
      lc
    )
  ) {
    return `${pref}: the file couldn't be read as Parquet — it may be a different format or corrupted.`;
  }

  // Unknown failure — surface the LAST exception message, not the whole traceback.
  const excLine = s
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => /(Exception|Error):/.test(l));
  const msg = (excLine ?? "").replace(/^.*?(?:Exception|Error):\s*/, "").trim();
  return `${pref}: ${msg || "the schema couldn't be extracted."}`.slice(0, 280);
}
