import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateRemoteParquetFiles } from "@/lib/sandbox/remote-fetch";

/**
 * enumerateRemoteParquetFiles over Azure Blob. The egress core is replaced by a
 * fake bin (the same `binPath` seam the materialize test uses) that LOGS the URL
 * it was handed and serves canned pages — so the request shape and the pagination
 * loop are both observable without a storage account.
 *
 * What matters here is that the Azure branch returns the SAME `{host, objects}`
 * contract the S3 branch does, because every consumer downstream (hive aliases,
 * footer prefetch, range tokens) builds `https://<host>/<key>` from it.
 */
const blob = (name: string, size: number) =>
  `<Blob><Name>${name}</Name><Properties><Content-Length>${size}</Content-Length></Properties></Blob>`;

const PAGE1 = `<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults ContainerName="release"><Blobs>
${blob("2026-08-19.0/type=building/part-00000.zstd.parquet", 100)}
${blob("2026-08-19.0/type=building/_manifest.json", 20)}
</Blobs><NextMarker>2!MTA=!MDAx</NextMarker></EnumerationResults>`;

const PAGE2 = `<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults ContainerName="release"><Blobs>
${blob("2026-08-19.0/type=building/part-00001.zstd.parquet", 200)}
</Blobs><NextMarker /></EnumerationResults>`;

/** A fake egress-fetch: absolute /bin/cat so no PATH is needed (spawn replaces env). */
function fakeCore(dir: string): { binPath: string; urls: () => string[] } {
  const log = join(dir, "urls.txt");
  const p1 = join(dir, "p1.xml");
  const p2 = join(dir, "p2.xml");
  writeFileSync(p1, PAGE1);
  writeFileSync(p2, PAGE2);
  const bin = join(dir, "fake-egress.sh");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$1" >> '${log}'\ncase "$1" in\n  *marker=*) exec /bin/cat '${p2}' ;;\n  *) exec /bin/cat '${p1}' ;;\nesac\n`
  );
  chmodSync(bin, 0o755);
  return {
    binPath: bin,
    urls: () => readFileSync(log, "utf8").trim().split("\n"),
  };
}

describe("enumerateRemoteParquetFiles — Azure Blob", () => {
  it("lists a container across pages and returns CONTAINER-QUALIFIED keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "az-enum-"));
    try {
      const core = fakeCore(dir);
      const { host, objects } = await enumerateRemoteParquetFiles(
        {
          remoteParquetUrl:
            "https://acct.blob.core.windows.net/release/2026-08-19.0/type=building/*.parquet",
        },
        { binPath: core.binPath }
      );

      expect(host).toBe("acct.blob.core.windows.net");
      // Container-qualified: `https://<host>/<key>` must be the blob's real URL,
      // since that is exactly how the hive aliases and footer prefetch build it.
      expect(objects).toEqual([
        { key: "release/2026-08-19.0/type=building/part-00000.zstd.parquet", size: 100 },
        { key: "release/2026-08-19.0/type=building/part-00001.zstd.parquet", size: 200 },
      ]);
      // The key keeps its hive segment, which is where DuckDB derives `type` from.
      expect(objects[0].key).toContain("type=building");

      const [first, second] = core.urls();
      const u = new URL(first!);
      expect(u.pathname).toBe("/release");
      expect(u.searchParams.get("restype")).toBe("container");
      expect(u.searchParams.get("comp")).toBe("list");
      expect(u.searchParams.get("prefix")).toBe("2026-08-19.0/type=building/");
      // Page 2 is driven by the marker the first page returned — not by a token
      // shape borrowed from S3 (Azure has no continuation-token).
      expect(new URL(second!).searchParams.get("marker")).toBe("2!MTA=!MDAx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps only parquet — a release prefix also carries manifests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "az-enum-"));
    try {
      const core = fakeCore(dir);
      const { objects } = await enumerateRemoteParquetFiles(
        { remoteParquetUrl: "https://acct.blob.core.windows.net/release/*.parquet" },
        { binPath: core.binPath }
      );
      expect(objects.some((o) => o.key.endsWith("_manifest.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a source that expands past the cap instead of minting endless tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "az-enum-"));
    try {
      const core = fakeCore(dir);
      await expect(
        enumerateRemoteParquetFiles(
          { remoteParquetUrl: "https://acct.blob.core.windows.net/release/*.parquet" },
          { binPath: core.binPath, maxFiles: 1 }
        )
      ).rejects.toThrow(/expands to more than 1 parquet files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a SAS-signed source LOUDLY rather than listing what it cannot read", async () => {
    // The listing could carry the token; the per-file read URLs minted downstream
    // cannot — so a run would enumerate happily and then 403 on every byte inside
    // the worker. Failing here keeps the diagnosis where the cause is.
    await expect(
      enumerateRemoteParquetFiles({
        remoteParquetUrl: "https://acct.blob.core.windows.net/c/a/*.parquet?sv=2026-01-01&sig=x",
      })
    ).rejects.toThrow(/SAS/);
  });

  it("still fails closed for a host with no listing at all", async () => {
    await expect(
      enumerateRemoteParquetFiles({ remoteParquetUrl: "https://files.example.com/dir/*.parquet" })
    ).rejects.toThrow(/not an enumerable source/);
  });
});
