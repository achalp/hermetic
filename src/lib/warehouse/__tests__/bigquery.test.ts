import { describe, it, expect, vi, beforeEach } from "vitest";
import { WAREHOUSE_QUERY_TIMEOUT_MS } from "@/lib/constants";

// Capture the options every bq.query() call receives.
const queryMock = vi.fn();
vi.mock("@google-cloud/bigquery", () => ({
  BigQuery: class {
    query = queryMock;
  },
}));

import { createBigQueryConnector } from "@/lib/warehouse/bigquery";
import type { BigQueryConnectionConfig } from "@/lib/types";

const config: BigQueryConnectionConfig = {
  type: "bigquery",
  projectId: "proj",
  dataset: "bigquery-public-data.overture_maps",
  credentialsJson: JSON.stringify({ client_email: "x@y", private_key: "k" }),
};

beforeEach(() => queryMock.mockReset());

describe("bigquery executeSQL", () => {
  it("caps every query with jobTimeoutMs so a runaway query can't run to BigQuery's 6-hour limit", async () => {
    queryMock.mockResolvedValueOnce([[{ n: 1 }]]);
    const connector = createBigQueryConnector(config);
    await connector.executeSQL("SELECT 1 AS n");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const opts = queryMock.mock.calls[0][0] as { query: string; jobTimeoutMs?: number };
    expect(opts.query).toBe("SELECT 1 AS n");
    // The cap that turns a 6-hour hang into a minutes-long failure.
    expect(opts.jobTimeoutMs).toBe(WAREHOUSE_QUERY_TIMEOUT_MS);
  });

  it("serializes rows to CSV; empty result → empty string", async () => {
    queryMock.mockResolvedValueOnce([[{ a: 1, b: "x,y" }]]);
    const connector = createBigQueryConnector(config);
    const csv = await connector.executeSQL("SELECT 1");
    expect(csv).toBe('a,b\n1,"x,y"\n');

    queryMock.mockResolvedValueOnce([[]]);
    expect(await connector.executeSQL("SELECT 1 WHERE false")).toBe("");
  });
});
