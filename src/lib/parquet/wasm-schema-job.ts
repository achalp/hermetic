/**
 * Connect-time schema extraction IN THE WORKER (build log D24 decision, D27 build).
 *
 * ── The two doors, and why this file exists ──
 * Everything D18–D21 built hangs off the QUERY pipeline: a run exists, an NDJSON
 * stream is open to `emit()` a job into, and a worker is booted per execute-request.
 * Schema extraction hangs off SOURCE CONNECT, which has none of those. So the parts
 * were never missing — they were reachable only through a door connect never walks
 * through. That is what "requires Docker" was really encoding: a container runs
 * synchronously from wherever it is called.
 *
 * The fix inverts the direction. Connect is USER-INITIATED, so the browser already
 * owns a worker (`runInWorker`) and can be handed a job to run instead of waiting to
 * be pushed one. This module prepares that job host-side and parses what comes back.
 *
 * ── TRUST: the schema is computed CLIENT-SIDE here ──
 * Stated rather than left implicit. The returned profile is produced by the worker
 * and posted back, so the host is trusting the browser's arithmetic. That is
 * defensible for exactly two reasons, and only these: the schema feeds PROMPT
 * CONTEXT and never a security decision; and it is derived from bytes the host
 * itself authorized and fetched. What the host does NOT delegate is the part that
 * matters — the URL, the allowlist, the token budget, and the lease all stay here.
 * The worker chooses byte offsets within a capability, exactly as during a query.
 * If a future consumer ever makes a trust decision from a schema, this changes.
 */
import { randomUUID } from "node:crypto";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import type { HandoffEnvelope } from "@/lib/sandbox/wasm/handoff-registry";
import { enumerateRemoteParquetFiles, resolveRemoteHttpsFetch } from "@/lib/sandbox/remote-fetch";
import { deriveAllowedEgressHosts } from "@/lib/sandbox/egress";
import { buildHiveAliases, budgetForFile } from "@/lib/sandbox/wasm/remote-hive";
import { getRangeRegistry } from "@/lib/sandbox/wasm/range-singleton";
import { buildWasmRemoteSchemaScript } from "./schema-script";
import { logger } from "@/lib/logger";

/**
 * How long a connect-time range lease lives. A query's tokens are released
 * deterministically by `releaseRun`; these have no run, so TIME is the only ceiling
 * that is guaranteed to arrive. Long enough for a cold Pyodide + DuckDB boot plus
 * the profile, short enough that an abandoned connect does not leave a live
 * capability lying around.
 */
export const CONNECT_LEASE_MS = 10 * 60 * 1000;

/** A prepared extraction, handed to the browser to run in its worker. */
export interface WasmSchemaJob {
  /** Opaque id the client returns with the envelope; names the server-side lease. */
  requestId: string;
  request: WasmExecuteRequest;
}

/** Server-side state for one in-flight connect extraction. */
export interface WasmSchemaLease {
  requestId: string;
  tokens: string[];
  csvId: string;
  filename: string;
  readUrl: string;
  creds?: RemoteCreds;
  isHivePartitioned: boolean;
  sourceKey: string;
  expiresAt: number;
}

/**
 * Enumerate the source, mint one lease-scoped range token per file, and build the
 * worker job. One token per FILE (never a prefix-scoped token) keeps the D20
 * invariant: the worker picks offsets, never destinations.
 */
export async function prepareWasmRemoteSchemaJob(args: {
  readUrl: string;
  csvId: string;
  filename: string;
  sourceKey: string;
  creds?: RemoteCreds;
  isHivePartitioned: boolean;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<{ job: WasmSchemaJob; lease: WasmSchemaLease }> {
  const { readUrl, creds, isHivePartitioned } = args;
  const now = args.now ?? (() => Date.now());
  const expiresAt = now() + CONNECT_LEASE_MS;
  const registry = getRangeRegistry();
  const allowlist = deriveAllowedEgressHosts(readUrl, creds);
  if (allowlist.length === 0) {
    throw new Error(
      "Refusing to read this remote source: no safe egress host could be derived from the URL."
    );
  }

  // The SAME discriminant the query path uses (run-ask-query's `wasmMultiFile`).
  // Not `splitS3Prefix(readUrl)`: that succeeds for a literal single-file s3 key
  // too, and listing `a/f.parquet/` as a prefix returns nothing — a single-file
  // s3:// source would have failed with "No Parquet files found".
  const isMultiFile = isHivePartitioned || readUrl.includes("*");
  let aliases: { name: string; url: string }[];
  if (isMultiFile) {
    const { host, objects } = await enumerateRemoteParquetFiles(
      { remoteParquetUrl: readUrl, ...(creds ? { remoteCreds: creds } : {}) },
      { ...(args.signal ? { signal: args.signal } : {}) }
    );
    if (objects.length === 0) {
      throw new Error("No Parquet files found under that prefix.");
    }
    aliases = buildHiveAliases(objects, host, (url, sizeBytes) =>
      registry.register({ url, allowlist, budgetBytes: budgetForFile(sizeBytes), expiresAt })
    );
    logger.info("WASM connect: enumerated remote source for schema", {
      files: aliases.length,
      totalBytes: objects.reduce((n, o) => n + o.size, 0),
    });
  } else {
    // A single https:// object: one alias, one token. Its byte budget is a fixed
    // ceiling rather than a fraction of the size, because a footer + a bounded row
    // prefix is all the profile reads — and we have not paid to learn the size.
    const plan = await resolveRemoteHttpsFetch({
      remoteParquetUrl: readUrl,
      ...(creds ? { remoteCreds: creds } : {}),
      isHivePartitioned,
    });
    if (!plan.ok) throw new Error(`Cannot read this remote source: ${plan.unsupported}`);
    const token = registry.register({
      url: plan.url,
      allowlist: plan.allowlist,
      budgetBytes: SINGLE_OBJECT_PROFILE_BUDGET,
      expiresAt,
    });
    aliases = [{ name: singleObjectAlias(readUrl), url: `/api/wasm-range/${token}` }];
  }

  const request: WasmExecuteRequest = {
    type: "wasm-execute",
    id: randomUUID(),
    csvContent: "",
    code: buildWasmRemoteSchemaScript(
      aliases.map((a) => a.name),
      isHivePartitioned
    ),
    files: [],
    duckdb: { base: "/duckdb/", aliases },
  };

  const requestId = randomUUID();
  return {
    job: { requestId, request },
    lease: {
      requestId,
      tokens: aliases.map((a) => a.url.split("/").pop()!),
      csvId: args.csvId,
      filename: args.filename,
      readUrl,
      ...(creds ? { creds } : {}),
      isHivePartitioned,
      sourceKey: args.sourceKey,
      expiresAt,
    },
  };
}

/**
 * Byte ceiling for profiling ONE remote object. The profile reads the footer plus a
 * bounded row prefix, not the file — so this is generous headroom, not a size
 * estimate. A fixed number (rather than a fraction of the object) also means we
 * never issue a request just to learn how much to allow.
 */
export const SINGLE_OBJECT_PROFILE_BUDGET = 512 * 1024 * 1024;

/**
 * A SQL-visible name for a single remote object. Keeps the trailing path segments
 * so a `key=value` folder still yields hive columns, for the same reason
 * `aliasForKey` does on the multi-file path.
 */
export function singleObjectAlias(readUrl: string): string {
  const withoutScheme = readUrl.replace(/^[a-z0-9+.-]+:\/\//i, "");
  const path = withoutScheme.split("/").slice(1).join("/");
  return path || "remote.parquet";
}

/** The profile the worker writes to /data/output.json. */
interface WorkerSchemaOutput {
  row_count: number;
  columns: CSVSchema["columns"];
  sample_rows: CSVSchema["sample_rows"];
  correlations?: CSVSchema["correlations"] | null;
  detected_domain?: CSVSchema["detected_domain"] | null;
}

/**
 * Turn the worker's envelope into a CSVSchema, or throw with a message worth
 * showing. Validates SHAPE before trusting it: this payload crossed a client, so
 * "the worker said so" is not by itself a reason to store it as a schema.
 */
export function parseWasmSchemaEnvelope(
  envelope: HandoffEnvelope,
  csvId: string,
  filename: string
): CSVSchema {
  if (envelope.exitCode !== 0) {
    const detail = (envelope.stderr ?? "").trim().slice(-500);
    throw new Error(detail || "Schema extraction failed in the built-in runtime.");
  }
  const raw = envelope.output;
  const data = (typeof raw === "string" ? safeJson(raw) : raw) as WorkerSchemaOutput | null;
  if (!data || typeof data !== "object" || !Array.isArray(data.columns)) {
    throw new Error("Schema extraction returned no usable profile.");
  }
  if (data.columns.length === 0) {
    throw new Error("Schema extraction found no columns in that source.");
  }
  const rowCount = Number(data.row_count);
  return {
    csv_id: csvId,
    filename,
    row_count: Number.isFinite(rowCount) && rowCount >= 0 ? Math.trunc(rowCount) : 0,
    columns: data.columns,
    sample_rows: Array.isArray(data.sample_rows) ? data.sample_rows : [],
    ...(data.correlations ? { correlations: data.correlations } : {}),
    detected_domain: data.detected_domain ?? "general",
    source_type: "file",
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
