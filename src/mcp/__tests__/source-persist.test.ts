/**
 * Source persistence tests: source_ids survive the host recycling the
 * server (the Claude Desktop chat lifecycle), credentials never touch
 * disk, and concurrent processes don't clobber each other's entries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setPathRoots, hermeticPaths } from "@/lib/paths";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import { registerSource, getSource, clearSources, listSources } from "../sources";
import { persistSources, restoreSources, type SourcePersistDeps } from "../source-persist";

const SCHEMA = { filename: "rev.csv", columns: [], row_count: 3 } as unknown as CSVSchema;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "source-persist-"));
  setPathRoots({ dataRoot: dir, scratchRoot: join(dir, "scratch"), userRoot: join(dir, "user") });
  clearSources();
});

afterEach(() => {
  clearSources();
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

const FILE = () => join(hermeticPaths.dataDir(), "mcp-sources.json");

function csvOnDisk(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "a,b\n1,2\n");
  return path;
}

function depsWith(stored: Record<string, unknown>): SourcePersistDeps {
  return {
    getStoredCSV: vi.fn(
      (csvId: string) => stored[csvId] as ReturnType<SourcePersistDeps["getStoredCSV"]>
    ),
    restoreStoredCSV: vi.fn(),
  };
}

describe("persistSources", () => {
  it("writes csv-family descriptors; never warehouse entries or credentials", async () => {
    const filePath = csvOnDisk("data.csv");
    const plain = registerSource({
      kind: "csv",
      label: "rev.csv",
      csvId: "csv-1",
      schema: SCHEMA,
      origin: { via: "path", path: "/home/x/rev.csv" },
    });
    const credentialed = registerSource({
      kind: "csv",
      label: "bucket",
      csvId: "csv-2",
      schema: SCHEMA,
      remote: true,
      origin: { via: "url", url: "s3://b/k.parquet" },
    });
    registerSource({
      kind: "warehouse",
      label: "prod",
      connectionId: "conn-1",
      warehouseType: "postgresql",
      connector: {} as never,
      tables: [],
      origin: { via: "connection_id", connection_id: "conn-1" },
    });

    await persistSources(
      depsWith({
        "csv-1": { schema: SCHEMA, filePath, createdAt: 1 },
        "csv-2": {
          schema: SCHEMA,
          filePath: "",
          createdAt: 1,
          remoteParquetUrl: "s3://b/k.parquet",
          remoteCreds: { keyId: "AKIA-SECRET", secret: "very-secret" },
        },
      })
    );

    const raw = readFileSync(FILE(), "utf-8");
    expect(raw).not.toContain("SECRET"); // the boundary that matters
    const records = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(records.map((r) => r.id).sort()).toEqual([plain.id, credentialed.id].sort());
    const cred = records.find((r) => r.id === credentialed.id)!;
    expect((cred.stored as { hadCreds?: boolean }).hadCreds).toBe(true);
  });

  it("merges with entries another process wrote instead of clobbering them", async () => {
    const other = {
      id: "other-process-id",
      label: "theirs.csv",
      csvId: "csv-other",
      schema: SCHEMA,
      stored: { filePath: "/nowhere" },
      savedAt: Date.now(),
    };
    writeFileSync(FILE(), JSON.stringify([other]));
    const filePath = csvOnDisk("mine.csv");
    registerSource({ kind: "csv", label: "mine.csv", csvId: "csv-mine", schema: SCHEMA });

    await persistSources(depsWith({ "csv-mine": { schema: SCHEMA, filePath, createdAt: 1 } }));

    const ids = (JSON.parse(readFileSync(FILE(), "utf-8")) as Array<{ id: string }>).map(
      (r) => r.id
    );
    expect(ids).toContain("other-process-id");
    expect(ids).toHaveLength(2);
  });
});

describe("restoreSources", () => {
  it("revives a source under its ORIGINAL id and re-seeds the store index", async () => {
    const filePath = csvOnDisk("data.csv");
    const source = registerSource({
      kind: "csv",
      label: "rev.csv",
      csvId: "csv-1",
      schema: SCHEMA,
      origin: { via: "path", path: "/home/x/rev.csv" },
    });
    await persistSources(depsWith({ "csv-1": { schema: SCHEMA, filePath, createdAt: 1 } }));

    // The restart: registry gone, store index gone, json + bytes survive.
    clearSources();
    const deps = depsWith({});
    const restored = await restoreSources(deps);

    expect(restored).toBe(1);
    const revived = getSource(source.id);
    expect(revived?.kind).toBe("csv");
    expect(revived?.label).toBe("rev.csv");
    expect(deps.restoreStoredCSV).toHaveBeenCalledWith(
      "csv-1",
      expect.objectContaining({ filePath })
    );
    expect(listSources().map((s) => s.id)).toEqual([source.id]);
  });

  it("skips entries whose bytes are gone, and credentialed remotes", async () => {
    const filePath = csvOnDisk("data.csv");
    registerSource({ kind: "csv", label: "a.csv", csvId: "csv-1", schema: SCHEMA });
    registerSource({
      kind: "csv",
      label: "bucket",
      csvId: "csv-2",
      schema: SCHEMA,
      remote: true,
    });
    await persistSources(
      depsWith({
        "csv-1": { schema: SCHEMA, filePath, createdAt: 1 },
        "csv-2": {
          schema: SCHEMA,
          filePath: "",
          createdAt: 1,
          remoteParquetUrl: "s3://b/k",
          remoteCreds: { secret: "x" },
        },
      })
    );

    clearSources();
    rmSync(filePath); // the scratch bytes did not survive this time
    const deps = depsWith({});
    const restored = await restoreSources(deps);

    expect(restored).toBe(0);
    expect(listSources()).toHaveLength(0);
    expect(deps.restoreStoredCSV).not.toHaveBeenCalled();
  });

  it("restores a credential-less remote ref with nothing on local disk", async () => {
    const source = registerSource({
      kind: "csv",
      label: "public bucket",
      csvId: "csv-3",
      schema: SCHEMA,
      remote: true,
      origin: { via: "url", url: "https://data.example/k.parquet" },
    });
    await persistSources(
      depsWith({
        "csv-3": {
          schema: SCHEMA,
          filePath: "",
          createdAt: 1,
          isParquet: true,
          remoteParquetUrl: "https://data.example/k.parquet",
        },
      })
    );

    clearSources();
    const deps = depsWith({});
    expect(await restoreSources(deps)).toBe(1);
    const revived = getSource(source.id);
    expect(revived?.kind === "csv" && revived.remote).toBe(true);
    expect(deps.restoreStoredCSV).toHaveBeenCalledWith(
      "csv-3",
      expect.objectContaining({ remoteParquetUrl: "https://data.example/k.parquet" })
    );
  });

  it("is a no-op without a registry file", async () => {
    expect(existsSync(FILE())).toBe(false);
    expect(await restoreSources(depsWith({}))).toBe(0);
  });
});
