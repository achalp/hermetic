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
