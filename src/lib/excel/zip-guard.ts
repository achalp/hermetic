import { MAX_XLSX_UNCOMPRESSED_BYTES } from "@/lib/constants";

/**
 * Zip-bomb guard for .xlsx ingestion (security F2).
 *
 * An .xlsx is a ZIP archive of XML. `exceljs`'s `workbook.xlsx.load()` fully
 * decompresses every entry into memory with no bound of its own, so a small
 * upload (bounded by MAX_CSV_SIZE_BYTES) can inflate to tens of GB and OOM the
 * process. This guard reads the ZIP **central directory** — which records each
 * entry's declared uncompressed size — and sums those sizes WITHOUT
 * decompressing anything, rejecting the file before `load()` sees it if the
 * total would exceed MAX_XLSX_UNCOMPRESSED_BYTES.
 *
 * The central directory is authoritative for a well-formed ZIP; a crafted
 * archive could lie, but exceljs streams the actual DEFLATE data and would
 * itself diverge from a lying header — this guard closes the cheap, high-ratio
 * amplification (the header honestly declares the huge inflated size, which is
 * exactly what a legitimate reader must allocate). Malformed / unparseable
 * archives fall through unchanged: exceljs then raises its own error, so the
 * guard never makes a currently-working file fail.
 */

const EOCD_SIGNATURE = 0x06054b50; // End Of Central Directory record
const CDFH_SIGNATURE = 0x02014b50; // Central Directory File Header
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const U32_MAX = 0xffffffff;
const ZIP64_EXTRA_ID = 0x0001;

export class XlsxTooLargeError extends Error {
  constructor(
    readonly declaredBytes: number,
    readonly limitBytes: number
  ) {
    super(
      `This spreadsheet decompresses to about ${Math.round(declaredBytes / (1024 * 1024))} MB, ` +
        `over the ${Math.round(limitBytes / (1024 * 1024))} MB limit for .xlsx files. ` +
        `It may be corrupt or a decompression bomb; export the sheet you need as CSV and upload that.`
    );
    this.name = "XlsxTooLargeError";
  }
}

function toBuffer(input: Buffer | ArrayBufferLike | Uint8Array): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array)
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(input as ArrayBuffer);
}

/**
 * Read the ZIP64 "true" uncompressed size for an entry whose 32-bit field is
 * saturated (0xFFFFFFFF). The value lives in the extra field under tag 0x0001;
 * its layout is position-dependent — the 8-byte uncompressed size is present
 * only if the 32-bit uncompressed field was saturated, and it comes first.
 * Returns null if the extra block is absent/short (caller treats absent ZIP64
 * data on a saturated field as "unknown → assume over-limit").
 */
function zip64UncompressedSize(extra: Buffer, uncompressedSaturated: boolean): number | null {
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const size = extra.readUInt16LE(off + 2);
    const body = off + 4;
    if (id === ZIP64_EXTRA_ID) {
      // The uncompressed size (if saturated) is the FIRST 8-byte field.
      if (uncompressedSaturated && body + 8 <= extra.length) {
        return Number(extra.readBigUInt64LE(body));
      }
      return null;
    }
    off = body + size;
  }
  return null;
}

/**
 * Throw XlsxTooLargeError if the archive's declared total uncompressed size
 * exceeds the limit. Silently returns for any buffer that isn't a parseable ZIP
 * central directory (exceljs will surface its own error downstream).
 */
export function assertXlsxDecompressionSafe(
  input: Buffer | ArrayBufferLike | Uint8Array,
  limitBytes: number = MAX_XLSX_UNCOMPRESSED_BYTES
): void {
  const buf = toBuffer(input);
  if (buf.length < 22) return; // smaller than a bare EOCD record — not a ZIP

  // Locate the EOCD by scanning backward from the end over the max comment
  // window (0xFFFF) plus the 22-byte fixed record.
  const scanStart = Math.max(0, buf.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return; // no EOCD → not a well-formed ZIP; let exceljs decide

  let entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: a saturated entry count or CD offset means the real values live in
  // the ZIP64 EOCD record, found via the locator that sits just before the
  // classic EOCD. Without it we can't trust the 32-bit fields, so bail out
  // (exceljs handles ZIP64 itself; the common bomb doesn't need it).
  if (entryCount === 0xffff || cdOffset === U32_MAX) {
    const locOff = eocd - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
      const zip64EocdOffset = Number(buf.readBigUInt64LE(locOff + 8));
      if (zip64EocdOffset < 0 || zip64EocdOffset + 56 > buf.length) return;
      if (buf.readUInt32LE(zip64EocdOffset) !== 0x06064b50) return;
      entryCount = Number(buf.readBigUInt64LE(zip64EocdOffset + 32));
      cdOffset = Number(buf.readBigUInt64LE(zip64EocdOffset + 48));
    } else {
      return;
    }
  }

  let total = 0;
  let off = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDFH_SIGNATURE) {
      return; // central directory doesn't parse cleanly — defer to exceljs
    }
    const uncompressed = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const extraStart = off + 46 + nameLen;

    let entryUncompressed = uncompressed;
    if (uncompressed === U32_MAX) {
      const extra = buf.subarray(extraStart, extraStart + extraLen);
      const real = zip64UncompressedSize(extra, true);
      // A saturated 32-bit field with no readable ZIP64 value means the entry
      // is >= 4 GiB by definition — over any sane limit.
      entryUncompressed = real ?? limitBytes + 1;
    }

    total += entryUncompressed;
    if (total > limitBytes) {
      throw new XlsxTooLargeError(total, limitBytes);
    }
    off = extraStart + extraLen + commentLen;
  }
}
