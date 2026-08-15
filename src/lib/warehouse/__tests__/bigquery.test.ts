import { describe, it, expect, vi, beforeEach } from "vitest";

// executeSQL now runs through createQueryJob (so we hold a JOB handle to cancel
// on abort — the fix for the 6h-billing TODO). Mock the job + its paginated
// getQueryResults + cancel. The introspection paths still use bq.query().
const createQueryJobMock = vi.fn();
const getQueryResultsMock = vi.fn();
const cancelMock = vi.fn(async () => [{}]);
const queryMock = vi.fn();

vi.mock("@google-cloud/bigquery", () => ({
  BigQuery: class {
    query = queryMock;
    createQueryJob = createQueryJobMock;
  },
}));

import { createBigQueryConnector } from "@/lib/warehouse/bigquery";
import type { BigQueryConnectionConfig } from "@/lib/contracts/connection-configs";

const config: BigQueryConnectionConfig = {
  type: "bigquery",
  projectId: "proj",
  dataset: "bigquery-public-data.overture_maps",
  credentialsJson: JSON.stringify({ client_email: "x@y", private_key: "k" }),
};

/** A fake Job whose getQueryResults returns one page (nextQuery = null → done). */
function jobReturning(rows: Record<string, unknown>[]) {
  getQueryResultsMock.mockReset();
  getQueryResultsMock.mockResolvedValueOnce([rows, null, {}]);
  return { getQueryResults: getQueryResultsMock, cancel: cancelMock };
}

beforeEach(() => {
  createQueryJobMock.mockReset();
  getQueryResultsMock.mockReset();
  cancelMock.mockClear();
});

describe("bigquery executeSQL", () => {
  it("submits the query as a JOB (createQueryJob), not a self-killing bq.query", async () => {
    createQueryJobMock.mockResolvedValueOnce([jobReturning([{ n: 1 }])]);
    const connector = createBigQueryConnector(config);
    await connector.executeSQL("SELECT 1 AS n");

    expect(createQueryJobMock).toHaveBeenCalledTimes(1);
    const opts = createQueryJobMock.mock.calls[0][0] as { query: string; jobTimeoutMs?: number };
    expect(opts.query).toBe("SELECT 1 AS n");
    // No self-kill timer: superseded by stop-on-demand + BigQuery's own 6h limit.
    expect(opts.jobTimeoutMs).toBeUndefined();
  });

  it("serializes rows to CSV; empty result → empty string", async () => {
    createQueryJobMock.mockResolvedValueOnce([jobReturning([{ a: 1, b: "x,y" }])]);
    const connector = createBigQueryConnector(config);
    const csv = await connector.executeSQL("SELECT 1");
    expect(csv).toBe('a,b\n1,"x,y"\n');

    createQueryJobMock.mockResolvedValueOnce([jobReturning([])]);
    expect(await connector.executeSQL("SELECT 1 WHERE false")).toBe("");
  });

  it("quotes comma-bearing COLUMN NAMES and quote-bearing values (canonical csv-util)", async () => {
    createQueryJobMock.mockResolvedValueOnce([
      jobReturning([{ "revenue, net": 100, note: 'said "go"' }]),
    ]);
    const connector = createBigQueryConnector(config);
    expect(await connector.executeSQL("SELECT 1")).toBe('"revenue, net",note\n100,"said ""go"""\n');
  });

  it("paginates: follows pageToken across pages and concatenates rows", async () => {
    getQueryResultsMock.mockReset();
    // Page 1 hands back a nextQuery carrying pageToken; page 2 ends (null).
    getQueryResultsMock
      .mockResolvedValueOnce([[{ a: 1 }], { pageToken: "tok2" }, {}])
      .mockResolvedValueOnce([[{ a: 2 }], null, {}]);
    createQueryJobMock.mockResolvedValueOnce([
      { getQueryResults: getQueryResultsMock, cancel: cancelMock },
    ]);
    const connector = createBigQueryConnector(config);
    expect(await connector.executeSQL("SELECT a")).toBe("a\n1\n2\n");
    expect(getQueryResultsMock).toHaveBeenCalledTimes(2);
    expect(getQueryResultsMock.mock.calls[1][0]).toMatchObject({ pageToken: "tok2" });
  });

  it("cancels the server-side JOB when the abort signal fires (stops billing)", async () => {
    const ac = new AbortController();
    // getQueryResults hangs until we abort, then rejects — mimicking a cancelled
    // job. onAbort (registered before the loop) calls job.cancel().
    getQueryResultsMock.mockReset();
    getQueryResultsMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          ac.signal.addEventListener("abort", () => reject(new Error("cancelled")));
        })
    );
    createQueryJobMock.mockResolvedValueOnce([
      { getQueryResults: getQueryResultsMock, cancel: cancelMock },
    ]);
    const connector = createBigQueryConnector(config);
    const p = connector.executeSQL("SELECT 1", ac.signal);
    // Abort after the job handle + listener are in place (next microtask).
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // flush job.cancel()
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("throws immediately if the signal is already aborted", async () => {
    const connector = createBigQueryConnector(config);
    await expect(connector.executeSQL("SELECT 1", AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(createQueryJobMock).not.toHaveBeenCalled();
  });
});
