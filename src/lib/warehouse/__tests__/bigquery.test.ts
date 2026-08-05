import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the options every bq.query() call receives.
const queryMock = vi.fn();
vi.mock("@google-cloud/bigquery", () => ({
  BigQuery: class {
    query = queryMock;
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

beforeEach(() => queryMock.mockReset());

describe("bigquery executeSQL", () => {
  it("does NOT impose a job timeout — a long analysis is never self-killed (Stop is the ceiling)", async () => {
    queryMock.mockResolvedValueOnce([[{ n: 1 }]]);
    const connector = createBigQueryConnector(config);
    await connector.executeSQL("SELECT 1 AS n");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const opts = queryMock.mock.calls[0][0] as { query: string; jobTimeoutMs?: number };
    expect(opts.query).toBe("SELECT 1 AS n");
    // No self-kill timer: superseded by stop-on-demand + BigQuery's own 6h limit.
    expect(opts.jobTimeoutMs).toBeUndefined();
  });

  it("serializes rows to CSV; empty result → empty string", async () => {
    queryMock.mockResolvedValueOnce([[{ a: 1, b: "x,y" }]]);
    const connector = createBigQueryConnector(config);
    const csv = await connector.executeSQL("SELECT 1");
    expect(csv).toBe('a,b\n1,"x,y"\n');

    queryMock.mockResolvedValueOnce([[]]);
    expect(await connector.executeSQL("SELECT 1 WHERE false")).toBe("");
  });

  it("quotes comma-bearing COLUMN NAMES and quote-bearing values (canonical csv-util)", async () => {
    // The pre-consolidation local serializer joined headers unquoted, so an
    // aliased column like `revenue, net` corrupted the whole CSV.
    queryMock.mockResolvedValueOnce([[{ "revenue, net": 100, note: 'said "go"' }]]);
    const connector = createBigQueryConnector(config);
    expect(await connector.executeSQL("SELECT 1")).toBe('"revenue, net",note\n100,"said ""go"""\n');
  });
});
