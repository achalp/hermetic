import { describe, it, expect } from "vitest";
import { storageIdentity, sameStorageHost, enforceSameHost } from "@/lib/manifest/same-host";
import type { DatasetManifest } from "@/lib/contracts/dataset-manifest";

/**
 * The STRICT same-host gate (spec §5.3/§8 — decided: no override in v1).
 * "Same host" means the same STORAGE NAMESPACE: a manifest on a bucket's https
 * vhost may name its own objects as s3:// keys, and those must be KEPT — while a
 * hostile manifest naming any other origin must be dropped, always.
 */

describe("storageIdentity", () => {
  it("resolves s3:// and the bucket's https vhost to the SAME identity", () => {
    expect(storageIdentity("s3://my-bucket/data/x.parquet")).toEqual({
      ns: "s3",
      key: "my-bucket",
    });
    expect(storageIdentity("https://my-bucket.s3.amazonaws.com/data/x.parquet")).toEqual({
      ns: "s3",
      key: "my-bucket",
    });
    // Regional vhost — the same bucket, and dropping it would exclude half the
    // legitimate manifests in the wild.
    expect(storageIdentity("https://my-bucket.s3.us-west-2.amazonaws.com/x.parquet")).toEqual({
      ns: "s3",
      key: "my-bucket",
    });
  });

  it("handles GCS in all three spellings", () => {
    expect(storageIdentity("gs://b/x.parquet")).toEqual({ ns: "gs", key: "b" });
    expect(storageIdentity("https://b.storage.googleapis.com/x.parquet")).toEqual({
      ns: "gs",
      key: "b",
    });
    expect(storageIdentity("https://storage.googleapis.com/b/x.parquet")).toEqual({
      ns: "gs",
      key: "b",
    });
  });

  it("treats an Azure account host as a plain https identity", () => {
    expect(storageIdentity("https://acct.blob.core.windows.net/data/x.parquet")).toEqual({
      ns: "https",
      key: "acct.blob.core.windows.net",
    });
  });

  it("never ACCEPTS by failing to parse", () => {
    expect(storageIdentity("not a url")).toBeNull();
    expect(sameStorageHost("not a url", "also not")).toBe(false);
  });

  it("a bucket named to LOOK like another bucket's vhost does not collide", () => {
    // s3://evil.s3.amazonaws.com (a bucket literally named with dots) parses as
    // ns=s3 key="evil.s3.amazonaws.com" — NOT equal to bucket "evil".
    expect(sameStorageHost("s3://evil.s3.amazonaws.com/x.parquet", "s3://evil/x.parquet")).toBe(
      false
    );
  });
});

describe("enforceSameHost", () => {
  const manifest = (entities: { name: string; url: string }[]): DatasetManifest => ({
    manifestUrl: "https://acct.blob.core.windows.net/data/manifest.json",
    format: "files-array",
    entities,
  });

  it("keeps same-host entries and drops cross-host ones WITH a reason", () => {
    const { kept, excluded } = enforceSameHost(
      manifest([
        { name: "ok", url: "https://acct.blob.core.windows.net/data/ok.parquet" },
        { name: "evil", url: "https://evil.example.com/exfil.parquet" },
        { name: "sneaky-s3", url: "s3://other-bucket/x.parquet" },
      ])
    );
    expect(kept.map((e) => e.name)).toEqual(["ok"]);
    expect(excluded.map((e) => e.name)).toEqual(["evil", "sneaky-s3"]);
    expect(excluded[0]!.reason).toMatch(/cross-host/);
  });

  it("keeps s3:// entries in a manifest served from that bucket's https vhost", () => {
    const m: DatasetManifest = {
      manifestUrl: "https://bkt.s3.us-east-1.amazonaws.com/manifest.json",
      format: "files-array",
      entities: [{ name: "e", url: "s3://bkt/data/e.parquet" }],
    };
    expect(enforceSameHost(m).kept).toHaveLength(1);
  });

  it("an ALL-cross-host manifest keeps nothing — the caller fails the connect closed", () => {
    const { kept, excluded } = enforceSameHost(
      manifest([{ name: "evil", url: "https://evil.example.com/x.parquet" }])
    );
    expect(kept).toHaveLength(0);
    expect(excluded).toHaveLength(1);
  });

  it("scheme difference alone (http vs https) is not cross-host", () => {
    const { kept } = enforceSameHost(
      manifest([{ name: "e", url: "http://acct.blob.core.windows.net/data/e.parquet" }])
    );
    // The egress core upgrades/validates the scheme; the NAMESPACE is the same.
    expect(kept).toHaveLength(1);
  });
});
