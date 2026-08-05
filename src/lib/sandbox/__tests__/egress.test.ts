/**
 * Egress allowlist derivation (lib/sandbox/egress.ts): the exact hostnames a
 * remote source may reach — deny-by-default, nothing derivable → nothing
 * allowed.
 */
import { describe, it, expect } from "vitest";
import { deriveAllowedEgressHosts } from "../egress";

describe("deriveAllowedEgressHosts", () => {
  it("s3 without region: bucket vhost + path-style hosts only", () => {
    expect(deriveAllowedEgressHosts("s3://mybucket/data/x.parquet").sort()).toEqual([
      "mybucket.s3.amazonaws.com",
      "s3.amazonaws.com",
    ]);
  });

  it("s3 with region adds regional variants", () => {
    const hosts = deriveAllowedEgressHosts("s3://b/x.parquet", { s3Region: "eu-west-1" });
    expect(hosts).toContain("b.s3.eu-west-1.amazonaws.com");
    expect(hosts).toContain("s3.eu-west-1.amazonaws.com");
    expect(hosts).toHaveLength(4);
  });

  it("custom endpoint (R2/MinIO) replaces AWS hosts entirely", () => {
    const hosts = deriveAllowedEgressHosts("s3://b/x.parquet", {
      s3Endpoint: "https://accountid.r2.cloudflarestorage.com",
    });
    expect(hosts.sort()).toEqual([
      "accountid.r2.cloudflarestorage.com",
      "b.accountid.r2.cloudflarestorage.com",
    ]);
    expect(hosts.join(",")).not.toContain("amazonaws");
  });

  it("https URL: exactly its host", () => {
    expect(deriveAllowedEgressHosts("https://data.example.org/dumps/t.parquet")).toEqual([
      "data.example.org",
    ]);
  });

  it("gs URL: googleapis hosts", () => {
    expect(deriveAllowedEgressHosts("gs://pub/x").sort()).toEqual([
      "pub.storage.googleapis.com",
      "storage.googleapis.com",
    ]);
  });

  it("garbage grants nothing", () => {
    expect(deriveAllowedEgressHosts("not a url")).toEqual([]);
    expect(deriveAllowedEgressHosts("https://")).toEqual([]);
  });
});
