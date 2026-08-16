/**
 * Restoring a REMOTE cloud-Parquet analysis rebuilds a LIVE remote ref, so a
 * follow-up reads the bucket directly instead of failing with "CSV not found
 * or expired. Please re-upload." (observed: a restored Overture run whose
 * follow-up "do the same for San Francisco" dead-ended). The history record
 * persists only the URL; credentials are re-resolved from the recent-source
 * keyed by the same URL (secret-at-rest — history never stores keys).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots, hermeticPaths } from "@/lib/paths";
import { saveHistoryEntry } from "@/lib/history/storage";
import { getStoredCSV, isRemoteFile } from "@/lib/csv/storage";
import { GET } from "../[id]/route";
import { rehydrateRemoteSourceFromHistory } from "@/lib/history/rehydrate-source";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const URL = "s3://overturemaps-us-west-2/release/2026-07-22.0/theme=places/type=place/*";
const schema: CSVSchema = {
  csv_id: "orig",
  filename: "*",
  row_count: 74223561,
  columns: [],
  sample_rows: [],
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hermetic-restore-remote-"));
  setPathRoots({ dataRoot: dir, userRoot: dir });
  // Seed a recent-source carrying creds for the SAME url the history entry
  // records — this is where restore re-resolves credentials from.
  mkdirSync(hermeticPaths.userDir(), { recursive: true });
  writeFileSync(
    hermeticPaths.recentSourcesFile(),
    JSON.stringify([
      {
        id: "src1",
        kind: "remote-parquet",
        name: "places",
        subtitle: URL,
        url: URL,
        creds: { s3AccessKeyId: "AKIA", s3SecretAccessKey: "sek" },
        isHivePartitioned: true,
        lastUsedAt: new Date().toISOString(),
        useCount: 1,
      },
    ])
  );
});

afterAll(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

describe("history restore — remote parquet rehydration", () => {
  it("persists the remote URL in the history meta", async () => {
    const meta = await saveHistoryEntry({
      question: "chains in seattle",
      spec: {},
      generatedCode: "",
      schema,
      sourceFile: "*",
      sourceType: "upload",
      remoteParquetUrl: URL,
      isHivePartitioned: true,
      executionMs: 1,
    });
    expect(meta.remoteParquetUrl).toBe(URL);
  });

  it("restore rebuilds a live remote ref, re-resolving creds from recent-sources", async () => {
    const meta = await saveHistoryEntry({
      question: "chains in seattle",
      spec: {},
      generatedCode: "",
      schema,
      sourceFile: "*",
      sourceType: "upload",
      remoteParquetUrl: URL,
      isHivePartitioned: true,
      executionMs: 1,
    });

    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: meta.id }),
    });
    const body = (await res.json()) as { csvId: string };
    const csvId = body.csvId;

    // The fresh restore csvId is a LIVE remote ref (not a dead placeholder).
    expect(isRemoteFile(csvId)).toBe(true);
    const stored = getStoredCSV(csvId)!;
    expect(stored.remoteParquetUrl).toBe(URL);
    expect(stored.isHivePartitioned).toBe(true);
    // Creds were NEVER in history — re-resolved from the recent-source by URL.
    expect(stored.remoteCreds?.s3AccessKeyId).toBe("AKIA");
  });
});

describe("query-path cold-miss recovery — rehydrate from the history record", () => {
  it("rehydrates a remote source under a follow-up csvId from its history id", async () => {
    const meta = await saveHistoryEntry({
      question: "chains in seattle",
      spec: {},
      generatedCode: "",
      schema,
      sourceFile: "*",
      sourceType: "upload",
      remoteParquetUrl: URL,
      isHivePartitioned: true,
      executionMs: 1,
    });
    // Simulate a cold in-memory store (e.g. after a server restart): the
    // follow-up's csvId maps to nothing.
    const followUpCsvId = `cold-${meta.id}`;
    expect(getStoredCSV(followUpCsvId)).toBeUndefined();

    const ok = await rehydrateRemoteSourceFromHistory(followUpCsvId, meta.id);
    expect(ok).toBe(true);
    // The follow-up now reads the original bucket — no re-upload.
    expect(isRemoteFile(followUpCsvId)).toBe(true);
    expect(getStoredCSV(followUpCsvId)?.remoteParquetUrl).toBe(URL);
    expect(getStoredCSV(followUpCsvId)?.remoteCreds?.s3AccessKeyId).toBe("AKIA");
  });

  it("no-ops for an upload entry (no bucket to point back at) and an unknown id", async () => {
    const upload = await saveHistoryEntry({
      question: "local",
      spec: {},
      generatedCode: "",
      schema,
      sourceFile: "f.csv",
      sourceType: "upload",
      executionMs: 1,
    });
    expect(await rehydrateRemoteSourceFromHistory("c2", upload.id)).toBe(false);
    expect(await rehydrateRemoteSourceFromHistory("c3", "does-not-exist")).toBe(false);
  });
});
