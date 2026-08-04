import { describe, it, expect } from "vitest";
import { storeRemoteParquetRef, isRemoteFile, isLocalFile, getStoredCSV } from "@/lib/csv/storage";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { RemoteCreds } from "@/lib/contracts/storage-types";

const schema = { row_count: 100, columns: [] } as unknown as CSVSchema;

describe("storeRemoteParquetRef / isRemoteFile", () => {
  it("registers a remote Parquet reference with its URL and creds", () => {
    const creds: RemoteCreds = { s3Region: "us-west-2" };
    storeRemoteParquetRef("remote-1", schema, "s3://bucket/x.parquet", creds);

    const stored = getStoredCSV("remote-1");
    expect(stored?.remoteParquetUrl).toBe("s3://bucket/x.parquet");
    expect(stored?.remoteCreds).toEqual(creds);
    expect(stored?.isParquet).toBe(true);
    expect(stored?.filePath).toBe("");
  });

  it("reports a remote source via isRemoteFile but not isLocalFile", () => {
    storeRemoteParquetRef("remote-2", schema, "https://host/data.parquet");
    expect(isRemoteFile("remote-2")).toBe(true);
    expect(isLocalFile("remote-2")).toBe(false);
  });

  it("is false for an unknown id", () => {
    expect(isRemoteFile("does-not-exist")).toBe(false);
  });
});
