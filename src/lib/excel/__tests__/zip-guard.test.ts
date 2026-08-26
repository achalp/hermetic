/**
 * Security F2: reject a decompression-bomb .xlsx before exceljs inflates it into
 * memory. The guard reads DECLARED uncompressed sizes from the ZIP central
 * directory without decompressing; these tests hand-build central directories
 * with honest and inflated size fields.
 */
import { describe, it, expect } from "vitest";
import { assertXlsxDecompressionSafe, XlsxTooLargeError } from "@/lib/excel/zip-guard";

/**
 * Build a minimal ZIP consisting of one central-directory file header + an EOCD.
 * No local file data is needed — the guard only reads the central directory.
 */
function buildZip(entries: { name: string; compressed: number; uncompressed: number }[]): Buffer {
  const cds: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); // central dir file header signature
    h.writeUInt32LE(e.compressed >>> 0, 20);
    h.writeUInt32LE(e.uncompressed >>> 0, 24);
    h.writeUInt16LE(name.length, 28); // file name length
    h.writeUInt16LE(0, 30); // extra length
    h.writeUInt16LE(0, 32); // comment length
    cds.push(Buffer.concat([h, name]));
  }
  const cd = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cd.length, 12); // central dir size
  eocd.writeUInt32LE(cd.length /* offset: CD starts right after (empty) data region */, 16);
  // Prepend an empty "data region" of length = cdOffset so cdOffset points at cd.
  const dataRegion = Buffer.alloc(cd.length);
  return Buffer.concat([dataRegion, cd, eocd]);
}

describe("assertXlsxDecompressionSafe", () => {
  it("passes a normal workbook whose declared sizes are modest", () => {
    const zip = buildZip([
      { name: "xl/worksheets/sheet1.xml", compressed: 2_000, uncompressed: 40_000 },
      { name: "xl/sharedStrings.xml", compressed: 1_000, uncompressed: 20_000 },
    ]);
    expect(() => assertXlsxDecompressionSafe(zip, 2 * 1024 * 1024 * 1024)).not.toThrow();
  });

  it("throws when the declared uncompressed total exceeds the limit (zip bomb)", () => {
    // One tiny compressed entry declaring a 3 GiB inflated size.
    const zip = buildZip([
      {
        name: "xl/worksheets/sheet1.xml",
        compressed: 100_000,
        uncompressed: 3 * 1024 * 1024 * 1024,
      },
    ]);
    expect(() => assertXlsxDecompressionSafe(zip, 2 * 1024 * 1024 * 1024)).toThrow(
      XlsxTooLargeError
    );
  });

  it("sums across entries — many mid-size sheets that together blow the cap", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      name: `xl/worksheets/sheet${i}.xml`,
      compressed: 50_000,
      uncompressed: 60 * 1024 * 1024, // 60 MiB each → 2.4 GiB total
    }));
    expect(() => assertXlsxDecompressionSafe(buildZip(entries), 2 * 1024 * 1024 * 1024)).toThrow(
      XlsxTooLargeError
    );
  });

  it("treats a saturated 32-bit size with no ZIP64 record as over-limit", () => {
    const zip = buildZip([
      { name: "xl/worksheets/sheet1.xml", compressed: 100_000, uncompressed: 0xffffffff },
    ]);
    expect(() => assertXlsxDecompressionSafe(zip, 2 * 1024 * 1024 * 1024)).toThrow(
      XlsxTooLargeError
    );
  });

  it("is a no-op for a non-ZIP buffer (exceljs surfaces its own error later)", () => {
    expect(() => assertXlsxDecompressionSafe(Buffer.from("not a zip at all"))).not.toThrow();
    expect(() => assertXlsxDecompressionSafe(Buffer.alloc(0))).not.toThrow();
  });

  it("accepts an ArrayBuffer / Uint8Array, not just Buffer", () => {
    const zip = buildZip([{ name: "x", compressed: 10, uncompressed: 100 }]);
    const u8 = new Uint8Array(zip);
    expect(() => assertXlsxDecompressionSafe(u8, 2 * 1024 * 1024 * 1024)).not.toThrow();
    expect(() =>
      assertXlsxDecompressionSafe(u8.buffer.slice(0), 2 * 1024 * 1024 * 1024)
    ).not.toThrow();
  });
});
