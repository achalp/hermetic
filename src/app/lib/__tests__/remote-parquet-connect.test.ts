import { describe, it, expect, vi, afterEach } from "vitest";
import {
  connectRemoteParquet,
  isWasmSchemaJob,
  type WasmSchemaJobResponse,
  type RemoteParquetResult,
} from "@/app/lib/remote-parquet-connect";
import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";

/**
 * The client half of connect (build log D27/D29). Two endpoints and a worker, so
 * the discriminant between "here is a schema" and "here is a job" is the protocol.
 */

const SCHEMA: RemoteParquetResult = {
  csv_id: "cid",
  schema: { csv_id: "cid", filename: "f", row_count: 1, columns: [], sample_rows: [] },
};

const JOB: WasmSchemaJobResponse = {
  needs_worker: true,
  job: {
    requestId: "req-1",
    request: { type: "wasm-execute", id: "x", csvContent: "", code: "", files: [] },
  },
};

// Restore the global `fetch` this file stubs. Without it the stub outlives the
// file and can be seen by another suite reusing the worker — the repo convention
// (see api.test.ts), and the cause of one intermittent pre-push failure.
afterEach(() => vi.unstubAllGlobals());

/** A `parse` that replays queued bodies, and a fetch that records what was sent. */
function harness(bodies: unknown[]) {
  const sent: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return {} as Response;
  });
  let i = 0;
  const parse = (async () => bodies[i++]) as <T>(res: Response) => Promise<T>;
  return { sent, parse };
}

describe("isWasmSchemaJob", () => {
  it("discriminates on `needs_worker`, not on a missing schema", () => {
    // A job read as a schema would surface as a source with no columns rather
    // than as an error — the failure mode this flag exists to prevent.
    expect(isWasmSchemaJob(JOB)).toBe(true);
    expect(isWasmSchemaJob(SCHEMA)).toBe(false);
  });
});

describe("connectRemoteParquet", () => {
  it("returns the schema in ONE hop when the server already has it", async () => {
    const { sent, parse } = harness([SCHEMA]);
    const run = vi.fn();
    const out = await connectRemoteParquet({ url: "s3://b/x" }, parse, run);
    expect(out).toEqual(SCHEMA);
    expect(sent).toHaveLength(1);
    // No container? Still no worker: a cached/Docker connect must not boot one.
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the job and posts the envelope back on the second hop", async () => {
    const { sent, parse } = harness([JOB, SCHEMA]);
    const envelope = { exitCode: 0, output: { row_count: 1 } };
    const run = vi.fn(async (_r: WasmExecuteRequest) => envelope);
    const out = await connectRemoteParquet({ url: "s3://b/x" }, parse, run);

    expect(run).toHaveBeenCalledWith(JOB.job.request);
    expect(out).toEqual(SCHEMA);
    expect(sent[1]).toEqual({
      url: "/api/remote-parquet/schema/complete",
      // The requestId comes from the server's job, never invented client-side.
      body: { requestId: "req-1", envelope },
    });
  });

  it("sends url, creds and force on the first hop", async () => {
    const { sent, parse } = harness([SCHEMA]);
    const creds = { s3AccessKeyId: "AK", s3SecretAccessKey: "SK" };
    await connectRemoteParquet({ url: "s3://b/x", creds, force: true }, parse, vi.fn());
    expect(sent[0]).toEqual({
      url: "/api/remote-parquet/schema",
      body: { url: "s3://b/x", creds, force: true },
    });
  });

  it("propagates a worker failure instead of posting a bogus envelope", async () => {
    const { sent, parse } = harness([JOB, SCHEMA]);
    const run = vi.fn(async () => {
      throw new Error("worker died");
    });
    await expect(connectRemoteParquet({ url: "s3://b/x" }, parse, run)).rejects.toThrow(
      /worker died/
    );
    expect(sent).toHaveLength(1); // never reached /complete
  });
});
