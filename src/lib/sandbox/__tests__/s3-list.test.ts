import { describe, it, expect } from "vitest";
import {
  parseS3ListXml,
  parquetObjectsOnly,
  splitS3Prefix,
  aliasForKey,
  MAX_ENUMERATED_FILES,
} from "@/lib/sandbox/s3-list";

/** A page shaped exactly like the live Overture listing this was built against. */
const PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>overturemaps-us-west-2</Name>
  <Contents>
    <Key>release/2026-07-22.0/theme=buildings/type=building/part-00000-a.zstd.parquet</Key>
    <Size>525687024</Size>
  </Contents>
  <Contents>
    <Key>release/2026-07-22.0/theme=buildings/type=building/part-00001-b.zstd.parquet</Key>
    <Size>516872041</Size>
  </Contents>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

describe("parseS3ListXml", () => {
  it("reads keys and sizes from a ListObjectsV2 page", () => {
    const { objects, nextToken } = parseS3ListXml(PAGE);
    expect(objects).toHaveLength(2);
    expect(objects[0].key).toContain("theme=buildings/type=building/part-00000");
    expect(objects[0].size).toBe(525687024);
    expect(nextToken).toBeUndefined();
  });

  it("surfaces the continuation token only when the page is truncated", () => {
    const truncated = PAGE.replace(
      "<IsTruncated>false</IsTruncated>",
      "<IsTruncated>true</IsTruncated><NextContinuationToken>tok/abc+def=</NextContinuationToken>"
    );
    expect(parseS3ListXml(truncated).nextToken).toBe("tok/abc+def=");
    // A token present but IsTruncated=false must NOT drive another page.
    const notTruncated = PAGE.replace(
      "<IsTruncated>false</IsTruncated>",
      "<IsTruncated>false</IsTruncated><NextContinuationToken>stale</NextContinuationToken>"
    );
    expect(parseS3ListXml(notTruncated).nextToken).toBeUndefined();
  });

  it("decodes XML entities in keys — a key may legitimately contain &", () => {
    const xml = `<ListBucketResult><Contents>
      <Key>a/b&amp;c/d&amp;amp;e.parquet</Key><Size>10</Size>
    </Contents><IsTruncated>false</IsTruncated></ListBucketResult>`;
    // &amp; → &, and the doubly-escaped &amp;amp; → &amp; (not &)
    expect(parseS3ListXml(xml).objects[0].key).toBe("a/b&c/d&amp;e.parquet");
  });

  it("drops folder placeholders (trailing slash) — they are not readable parquet", () => {
    const xml = `<ListBucketResult><Contents>
      <Key>release/theme=buildings/</Key><Size>0</Size>
    </Contents><IsTruncated>false</IsTruncated></ListBucketResult>`;
    expect(parseS3ListXml(xml).objects).toHaveLength(0);
  });

  it("returns nothing for junk rather than throwing (a remote server feeds this)", () => {
    expect(parseS3ListXml("").objects).toEqual([]);
    expect(parseS3ListXml("<html>403 Forbidden</html>").objects).toEqual([]);
  });
});

describe("parquetObjectsOnly", () => {
  it("keeps parquet with content, drops manifests/checksums and zero-byte entries", () => {
    const kept = parquetObjectsOnly([
      { key: "a/part-0.parquet", size: 100 },
      { key: "a/_SUCCESS", size: 0 },
      { key: "a/manifest.json", size: 20 },
      { key: "a/part-1.PARQUET", size: 50 },
      { key: "a/empty.parquet", size: 0 },
    ]);
    expect(kept.map((o) => o.key)).toEqual(["a/part-0.parquet", "a/part-1.PARQUET"]);
  });
});

describe("splitS3Prefix", () => {
  it("splits a folder source into bucket + literal prefix", () => {
    expect(
      splitS3Prefix(
        "s3://overturemaps-us-west-2/release/2026-07-22.0/theme=buildings/type=building"
      )
    ).toEqual({
      bucket: "overturemaps-us-west-2",
      prefix: "release/2026-07-22.0/theme=buildings/type=building/",
    });
  });

  it("stops at the first wildcard segment — S3 lists by literal prefix only", () => {
    expect(splitS3Prefix("s3://b/release/theme=x/**/*.parquet")).toEqual({
      bucket: "b",
      prefix: "release/theme=x/",
    });
    expect(splitS3Prefix("s3://b/a/b*/c.parquet")).toEqual({ bucket: "b", prefix: "a/" });
  });

  it("rejects malformed urls", () => {
    expect(splitS3Prefix("https://example.com/x")).toBeNull();
    expect(splitS3Prefix("s3://")).toBeNull();
  });
});

describe("aliasForKey — hive partition columns survive the indirection", () => {
  it("keeps the key's path shape verbatim so hive_partitioning still derives columns", () => {
    const key = "release/2026-07-22.0/theme=buildings/type=building/part-00000.parquet";
    // If this became a synthetic name like "src_0.parquet", DuckDB's
    // hive_partitioning=true would silently stop producing `theme` and `type`,
    // and a query grouping on them would change meaning rather than fail loudly.
    expect(aliasForKey(key)).toContain("theme=buildings");
    expect(aliasForKey(key)).toContain("type=building");
  });
});

describe("enumeration ceiling", () => {
  it("is bounded so a huge tree fails loudly instead of minting endless tokens", () => {
    expect(MAX_ENUMERATED_FILES).toBeGreaterThan(512); // Overture buildings fits
    expect(MAX_ENUMERATED_FILES).toBeLessThanOrEqual(5000);
  });
});
