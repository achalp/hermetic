import { describe, it, expect } from "vitest";
import { parseListBlobs, splitAzurePrefix } from "@/lib/sandbox/azure-list";

/**
 * Azure Blob "List Blobs" parsing — the Azure twin of s3-list. Fixtures are shaped
 * like the anonymous (default service version) response a public container serves,
 * which is the only listing this path can obtain.
 */
const PAGE = `<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults ServiceEndpoint="https://acct.blob.core.windows.net/" ContainerName="release">
  <Prefix>2026-08-19.0/theme=buildings/type=building/</Prefix>
  <MaxResults>1000</MaxResults>
  <Blobs>
    <Blob>
      <Name>2026-08-19.0/theme=buildings/type=building/part-00000-a.zstd.parquet</Name>
      <Properties>
        <Last-Modified>Wed, 19 Aug 2026 00:00:00 GMT</Last-Modified>
        <Content-Length>525687024</Content-Length>
        <BlobType>BlockBlob</BlobType>
      </Properties>
    </Blob>
    <Blob>
      <Name>2026-08-19.0/theme=buildings/type=building/part-00001-b.zstd.parquet</Name>
      <Properties><Content-Length>516872041</Content-Length></Properties>
    </Blob>
  </Blobs>
  <NextMarker />
</EnumerationResults>`;

describe("parseListBlobs", () => {
  it("reads names and sizes from a List Blobs page", () => {
    const { objects, nextMarker } = parseListBlobs(PAGE);
    expect(objects).toHaveLength(2);
    expect(objects[0].key).toBe(
      "2026-08-19.0/theme=buildings/type=building/part-00000-a.zstd.parquet"
    );
    expect(objects[0].size).toBe(525687024);
    expect(nextMarker).toBeUndefined();
  });

  it("paginates on a NON-EMPTY NextMarker only", () => {
    expect(
      parseListBlobs(PAGE.replace("<NextMarker />", "<NextMarker>2!MTA=!MDAx</NextMarker>"))
    ).toHaveProperty("nextMarker", "2!MTA=!MDAx");
    // Azure has no IsTruncated: an empty marker is how the LAST page says "done".
    // Treating it as a token would loop the listing against the same page forever.
    expect(
      parseListBlobs(PAGE.replace("<NextMarker />", "<NextMarker></NextMarker>")).nextMarker
    ).toBeUndefined();
    expect(
      parseListBlobs(PAGE.replace("<NextMarker />", "<NextMarker>  </NextMarker>")).nextMarker
    ).toBeUndefined();
  });

  it("ignores <BlobPrefix> stubs — they are directories, not readable files", () => {
    const xml = `<EnumerationResults><Blobs>
      <BlobPrefix><Name>theme=buildings/</Name></BlobPrefix>
      <Blob><Name>a/part-0.parquet</Name><Properties><Content-Length>10</Content-Length></Properties></Blob>
    </Blobs><NextMarker /></EnumerationResults>`;
    expect(parseListBlobs(xml).objects.map((o) => o.key)).toEqual(["a/part-0.parquet"]);
  });

  it("decodes XML entities in blob names — a name may legitimately contain &", () => {
    const xml = `<EnumerationResults><Blobs><Blob>
      <Name>a/b&amp;c/d&amp;amp;e.parquet</Name>
      <Properties><Content-Length>10</Content-Length></Properties>
    </Blob></Blobs></EnumerationResults>`;
    // &amp; → &, and the doubly-escaped &amp;amp; → &amp; (not &)
    expect(parseListBlobs(xml).objects[0].key).toBe("a/b&c/d&amp;e.parquet");
  });

  it("drops directory placeholder blobs (trailing slash, as ADLS Gen2 writes them)", () => {
    const xml = `<EnumerationResults><Blobs><Blob>
      <Name>theme=buildings/</Name><Properties><Content-Length>0</Content-Length></Properties>
    </Blob></Blobs></EnumerationResults>`;
    expect(parseListBlobs(xml).objects).toEqual([]);
  });

  it("returns nothing for junk rather than throwing (a remote server feeds this)", () => {
    expect(parseListBlobs("").objects).toEqual([]);
    expect(parseListBlobs("<Error><Code>PublicAccessNotPermitted</Code></Error>").objects).toEqual(
      []
    );
  });
});

describe("splitAzurePrefix", () => {
  it("splits a folder source into host + container + literal prefix", () => {
    expect(
      splitAzurePrefix(
        "https://acct.blob.core.windows.net/release/2026-08-19.0/theme=buildings/type=building"
      )
    ).toEqual({
      account: "acct",
      host: "acct.blob.core.windows.net",
      container: "release",
      prefix: "2026-08-19.0/theme=buildings/type=building/",
      search: "",
    });
  });

  it("stops at the first wildcard segment — List Blobs has no globbing either", () => {
    expect(
      splitAzurePrefix("https://acct.blob.core.windows.net/c/release/**/*.parquet")?.prefix
    ).toBe("release/");
    expect(splitAzurePrefix("https://acct.blob.core.windows.net/c/a/b*/c.parquet")?.prefix).toBe(
      "a/"
    );
    // A bare container lists everything in it.
    expect(splitAzurePrefix("https://acct.blob.core.windows.net/c")?.prefix).toBe("");
    expect(splitAzurePrefix("https://acct.blob.core.windows.net/c/")?.prefix).toBe("");
  });

  it("percent-DECODES the prefix — Azure matches it against decoded blob names", () => {
    // The names in the response are decoded, so sending `a%20b/` as the prefix
    // would match nothing and the source would silently look empty.
    expect(splitAzurePrefix("https://acct.blob.core.windows.net/c/a%20b/*.parquet")?.prefix).toBe(
      "a b/"
    );
  });

  it("rejects a wildcard CONTAINER instead of narrowing it to one container", () => {
    // A listing is scoped to a single container; answering this with whichever
    // container happened to match would return partial data as if it were whole.
    expect(splitAzurePrefix("https://acct.blob.core.windows.net/*/x.parquet")).toBeNull();
    expect(splitAzurePrefix("https://acct.blob.core.windows.net/")).toBeNull();
  });

  it("matches blob endpoints only — ADLS/dfs and other hosts fall through", () => {
    // dfs.core.windows.net speaks a DIFFERENT API; matching it here would build a
    // listing URL that 404s instead of routing the source somewhere that works.
    expect(splitAzurePrefix("https://acct.dfs.core.windows.net/c/x/*.parquet")).toBeNull();
    expect(splitAzurePrefix("https://bucket.s3.us-west-2.amazonaws.com/a/*.parquet")).toBeNull();
    expect(splitAzurePrefix("s3://bucket/a/*.parquet")).toBeNull();
    expect(splitAzurePrefix("not a url")).toBeNull();
    // Sovereign clouds run the same REST API on a different suffix.
    expect(splitAzurePrefix("https://acct.blob.core.chinacloudapi.cn/c/x/*.parquet")?.host).toBe(
      "acct.blob.core.chinacloudapi.cn"
    );
  });

  it("keeps a SAS query OUT of the prefix and reports it separately", () => {
    // If the query leaked into the prefix the listing would match nothing; the
    // caller refuses SAS sources outright (the per-file reads cannot carry it).
    const split = splitAzurePrefix(
      "https://acct.blob.core.windows.net/c/a/*.parquet?sv=2026-01-01&sig=abc%3D"
    );
    expect(split?.prefix).toBe("a/");
    expect(split?.search).toBe("sv=2026-01-01&sig=abc%3D");
  });
});
