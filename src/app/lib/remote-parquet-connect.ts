"use client";

import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";
import type { HandoffEnvelope } from "@/lib/sandbox/wasm/handoff-registry";

/**
 * The client half of connect-time schema extraction on the built-in (wasm)
 * runtime (build log D27).
 *
 * Lives beside the typed API client rather than inside it: `api.ts` is a thin
 * request/response layer, and this is a two-hop ORCHESTRATION — POST, run a job in
 * the worker, POST the envelope back. Mixing the two is what pushed api.ts over the
 * oversized-module ratchet, and the split is the honest fix rather than a bigger
 * baseline.
 *
 * Why the client drives at all: connect is not a streaming endpoint, so the server
 * has no channel to push a job down. But connect is USER-INITIATED, so the browser
 * already owns a worker and can be handed the job instead.
 */

/** What `/api/remote-parquet/schema` returns INSTEAD of a schema on this runtime. */
export interface WasmSchemaJobResponse {
  /**
   * The discriminant. Present ONLY on the job response — without it a job would
   * read as a schema with no columns, which fails silently rather than loudly.
   */
  needs_worker: true;
  job: { requestId: string; request: WasmExecuteRequest };
}

/** A completed connect: the stored id plus the schema the source resolved to. */
export interface RemoteParquetResult {
  csv_id: string;
  schema: CSVSchema;
  /** "hit" | "miss" | "forced" — diagnostic only; the UI does not branch on it. */
  cache_status?: string;
}

/** Narrow a `/api/remote-parquet/schema` body to the job case. */
export function isWasmSchemaJob(
  body: RemoteParquetResult | WasmSchemaJobResponse
): body is WasmSchemaJobResponse {
  return "needs_worker" in body;
}

/** Credentials for a private bucket; omitted entirely for a public source. */
export interface RemoteParquetCreds {
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3Region?: string;
  s3Endpoint?: string;
}

/**
 * Connect a remote Parquet source and return its schema.
 *
 * On Docker this is one request. On the built-in runtime the first response is a
 * JOB instead of a schema, and this drives the second hop: run it in the worker,
 * POST the envelope to `/complete`, and return what that stores.
 *
 * `parse` is the caller's response reader (it owns error typing), and `run` is
 * injected so the round trip is testable without a worker or a network.
 */
export async function connectRemoteParquet(
  body: { url: string; creds?: RemoteParquetCreds; force?: boolean },
  parse: <T>(res: Response) => Promise<T>,
  run?: (req: WasmExecuteRequest) => Promise<HandoffEnvelope>
): Promise<RemoteParquetResult> {
  const first = await parse<RemoteParquetResult | WasmSchemaJobResponse>(
    await post("/api/remote-parquet/schema", body)
  );
  if (!isWasmSchemaJob(first)) return first;

  // Imported lazily so a Docker-runtime connect never pulls in the worker client.
  const exec = run ?? (await import("@/app/lib/wasm-worker-client")).runInWorker;
  const envelope = await exec(first.job.request);
  return parse<RemoteParquetResult>(
    await post("/api/remote-parquet/schema/complete", {
      requestId: first.job.requestId,
      envelope,
    })
  );
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
