// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSourceSelect } from "@/hooks/use-source-select";

vi.mock("@/app/lib/api", () => ({
  extractLocalSchema: vi.fn(),
  extractRemoteParquetSchema: vi.fn(),
  fetchStaticAsset: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@/app/lib/manifest-connect", () => ({
  connectManifest: vi.fn(),
  ensureManifestEntity: vi.fn(),
}));

import {
  extractLocalSchema,
  extractRemoteParquetSchema,
  fetchStaticAsset,
  uploadFile,
} from "@/app/lib/api";
import { connectManifest, ensureManifestEntity } from "@/app/lib/manifest-connect";

const mLocal = extractLocalSchema as ReturnType<typeof vi.fn>;
const mRemote = extractRemoteParquetSchema as ReturnType<typeof vi.fn>;
const mStatic = fetchStaticAsset as ReturnType<typeof vi.fn>;
const mUpload = uploadFile as ReturnType<typeof vi.fn>;
const mConnectManifest = connectManifest as ReturnType<typeof vi.fn>;
const mEnsureEntity = ensureManifestEntity as ReturnType<typeof vi.fn>;

const schema = { csv_id: "c", filename: "f.csv", row_count: 1, columns: [], sample_rows: [] };

function setup() {
  const handleUpload = vi.fn();
  const handleExcelSheets = vi.fn();
  const { result } = renderHook(() => useSourceSelect({ handleUpload, handleExcelSheets }));
  return { result, handleUpload, handleExcelSheets };
}

beforeEach(() => {
  mLocal.mockReset();
  mRemote.mockReset();
  mStatic.mockReset();
  mUpload.mockReset();
  mConnectManifest.mockReset();
  mEnsureEntity.mockReset();
});

afterEach(() => cleanup());

describe("useSourceSelect", () => {
  it("starts with default state", () => {
    const { result } = setup();
    expect(result.current.showLocalBrowser).toBe(false);
    expect(result.current.isExtractingLocalSchema).toBe(false);
    expect(result.current.hasRemoteSource).toBe(false);
    expect(result.current.sourceError).toBeNull();
  });

  it("handleLocalFileSelect uploads a CSV and closes the browser", async () => {
    mLocal.mockResolvedValue({ csv_id: "c1", schema });
    const { result, handleUpload } = setup();
    act(() => result.current.setShowLocalBrowser(true));
    await act(async () => {
      await result.current.handleLocalFileSelect("/p.csv", "file");
    });
    expect(handleUpload).toHaveBeenCalledWith("c1", schema);
    expect(result.current.showLocalBrowser).toBe(false);
    expect(result.current.isExtractingLocalSchema).toBe(false);
  });

  it("handleLocalFileSelect routes an Excel workbook to the sheet picker", async () => {
    mLocal.mockResolvedValue({ excel_id: "ex", sheets: [{ name: "S" }], filename: "b.xlsx" });
    const { result, handleExcelSheets } = setup();
    await act(async () => {
      await result.current.handleLocalFileSelect("/b.xlsx", "file");
    });
    expect(handleExcelSheets).toHaveBeenCalledWith("ex", "b.xlsx", [{ name: "S" }], []);
  });

  it("handleLocalFileSelect surfaces an error banner on failure", async () => {
    mLocal.mockRejectedValue(new Error("nope"));
    const { result } = setup();
    await act(async () => {
      await result.current.handleLocalFileSelect("/x", "file");
    });
    expect(result.current.sourceError).toBe("nope");
  });

  it("handleRemoteFileSelect loads a remote parquet source", async () => {
    mRemote.mockResolvedValue({ csv_id: "rc", schema });
    const { result, handleUpload } = setup();
    await act(async () => {
      await result.current.handleRemoteFileSelect("s3://bucket/f.parquet");
    });
    expect(result.current.hasRemoteSource).toBe(true);
    expect(handleUpload).toHaveBeenCalledWith("rc", schema);
  });

  it("refreshRemote re-reads the last remote source with force", async () => {
    mRemote.mockResolvedValue({ csv_id: "rc", schema });
    const { result } = setup();
    await act(async () => {
      await result.current.handleRemoteFileSelect("url", { key: "x" } as never);
    });
    mRemote.mockClear();
    await act(async () => {
      await result.current.refreshRemote();
    });
    expect(mRemote).toHaveBeenCalledWith("url", { key: "x" }, true);
  });

  it("processUploadFile uploads and routes a plain CSV", async () => {
    mUpload.mockResolvedValue({ csv_id: "up", schema });
    const { result, handleUpload } = setup();
    await act(async () => {
      await result.current.processUploadFile(new File(["a"], "a.csv"));
    });
    expect(handleUpload).toHaveBeenCalledWith("up", schema);
  });

  it("handleSampleData fetches the bundled asset and uploads it", async () => {
    mStatic.mockResolvedValue(new Blob(["x"]));
    mUpload.mockResolvedValue({ csv_id: "sample", schema });
    const { result, handleUpload } = setup();
    await act(async () => {
      await result.current.handleSampleData();
    });
    expect(mStatic).toHaveBeenCalled();
    expect(handleUpload).toHaveBeenCalledWith("sample", schema);
  });

  it("resetSourceSelect and clearSourceError reset state", async () => {
    mLocal.mockRejectedValue(new Error("boom"));
    const { result } = setup();
    await act(async () => {
      await result.current.handleLocalFileSelect("/x", "file");
    });
    expect(result.current.sourceError).toBe("boom");
    act(() => result.current.clearSourceError());
    expect(result.current.sourceError).toBeNull();

    act(() => result.current.setShowLocalBrowser(true));
    act(() => result.current.resetSourceSelect());
    expect(result.current.showLocalBrowser).toBe(false);
    expect(result.current.hasRemoteSource).toBe(false);
  });
});

describe("useSourceSelect — dataset manifests in the Data Explorer (spec §6 revised)", () => {
  const VIEW = {
    manifestId: "m1",
    manifestUrl: "https://h/data/manifest.json",
    format: "files-array",
    title: "Housing hub",
    excluded: [],
    entities: [
      {
        name: "housing",
        url: "https://h/data/housing.parquet",
        status: "pending",
        rowCountIsExact: false,
      },
      {
        name: "population",
        url: "https://h/data/population.parquet",
        status: "ready",
        csvId: "c-pop",
        rowCount: 5,
        rowCountIsExact: true,
      },
    ],
  };
  const detail = (name: string, csvId: string) => ({
    name,
    status: "ready",
    url: `https://h/data/${name}.parquet`,
    csvId,
    schema: {
      csv_id: csvId,
      filename: name,
      row_count: 7,
      columns: [{ name: "x" }],
      sample_rows: [],
    },
  });

  it("a .json URL connects as a MANIFEST and auto-selects the first READY entity", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockResolvedValue(detail("population", "c-pop"));
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    // The parquet path was never taken; the manifest one was.
    expect(mRemote).not.toHaveBeenCalled();
    // The auto-selected entity's row reflects its extraction (exact rows from
    // the detail); the untouched entity keeps its connect-view row verbatim.
    expect(result.current.manifest).toMatchObject({ manifestId: "m1", title: "Housing hub" });
    expect(result.current.manifest!.entities[0]).toEqual(VIEW.entities[0]);
    expect(result.current.manifest!.entities[1]).toMatchObject({
      name: "population",
      status: "ready",
      rowCount: 7,
      rowCountIsExact: true,
    });
    // First READY entity preferred over the first pending one (no extraction wait).
    expect(mEnsureEntity).toHaveBeenCalledWith(VIEW, "population", undefined);
    expect(result.current.activeEntityName).toBe("population");
    // ...and it became the ACTIVE SOURCE, which is what feeds the explorer panes.
    expect(handleUpload).toHaveBeenCalledWith("c-pop", expect.objectContaining({ row_count: 7 }));
  });

  it("selecting a pending entity lazily extracts it, updates the list, swaps the source", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockResolvedValueOnce(detail("population", "c-pop"));
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    mEnsureEntity.mockResolvedValueOnce(detail("housing", "c-house"));
    await act(() => result.current.selectManifestEntity("housing"));

    expect(result.current.activeEntityName).toBe("housing");
    expect(handleUpload).toHaveBeenLastCalledWith("c-house", expect.anything());
    // The list reflects the extraction without a refetch: exact rows, ready.
    const housing = result.current.manifest!.entities.find((e) => e.name === "housing")!;
    expect(housing).toMatchObject({ status: "ready", rowCount: 7, rowCountIsExact: true });
  });

  it("re-selecting the ACTIVE entity is a no-op (no spinner, no re-extract)", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockResolvedValue(detail("population", "c-pop"));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    mEnsureEntity.mockClear();
    await act(() => result.current.selectManifestEntity("population"));
    expect(mEnsureEntity).not.toHaveBeenCalled();
  });

  it("a failed entity selection surfaces the error and keeps the previous source", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockResolvedValueOnce(detail("population", "c-pop"));
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    handleUpload.mockClear();

    mEnsureEntity.mockRejectedValueOnce(new Error("404 from the source"));
    await act(() => result.current.selectManifestEntity("housing"));

    expect(result.current.sourceError).toContain("404");
    expect(handleUpload).not.toHaveBeenCalled();
    expect(result.current.activeEntityName).toBe("population"); // unchanged
  });

  it("resetSourceSelect clears the manifest state", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockResolvedValue(detail("population", "c-pop"));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    act(() => result.current.resetSourceSelect());
    expect(result.current.manifest).toBeNull();
    expect(result.current.activeEntityName).toBeNull();
  });
});

describe("background eager introspection (D40 item 3)", () => {
  const PENDING_VIEW = {
    manifestId: "m1",
    manifestUrl: "https://h/data/manifest.json",
    format: "files-array",
    excluded: [],
    entities: [
      { name: "a", url: "https://h/data/a.parquet", status: "pending", rowCountIsExact: false },
      { name: "b", url: "https://h/data/b.parquet", status: "pending", rowCountIsExact: false },
      { name: "c", url: "https://h/data/c.parquet", status: "pending", rowCountIsExact: false },
    ],
  };
  const det = (name: string) => ({
    name,
    status: "ready",
    url: `https://h/data/${name}.parquet`,
    csvId: `c-${name}`,
    schema: {
      csv_id: `c-${name}`,
      filename: name,
      row_count: 5,
      columns: [{ name: "x" }],
      sample_rows: [],
    },
  });
  const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

  it("keeps extracting the REMAINING entities after connect when the server was not eager", async () => {
    mConnectManifest.mockResolvedValue(PENDING_VIEW);
    mEnsureEntity.mockImplementation(async (_v, name: string) => det(name));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    await flush();
    await flush();
    // First entity via auto-select, b and c via the background loop.
    const names = mEnsureEntity.mock.calls.map((c) => c[1]);
    expect(names).toEqual(["a", "b", "c"]);
    const st = Object.fromEntries(result.current.manifest!.entities.map((e) => [e.name, e.status]));
    expect(st).toEqual({ a: "ready", b: "ready", c: "ready" });
  });

  it("does NOT run when the server already did eager work (docker connect)", async () => {
    mConnectManifest.mockResolvedValue({
      ...PENDING_VIEW,
      entities: [
        {
          ...PENDING_VIEW.entities[0],
          status: "ready",
          csvId: "c-a",
          rowCount: 5,
          rowCountIsExact: true,
        },
        ...PENDING_VIEW.entities.slice(1),
      ],
    });
    mEnsureEntity.mockImplementation(async (_v, name: string) => det(name));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    await flush();
    // Only the auto-select ran — pending b/c stay lazy (the docker budget was
    // already spent server-side; a second client budget would double it).
    expect(mEnsureEntity.mock.calls.map((c) => c[1])).toEqual(["a"]);
    expect(result.current.manifest!.entities[1]!.status).toBe("pending");
  });

  it("YIELDS the worker the moment the user selects an entity", async () => {
    mConnectManifest.mockResolvedValue(PENDING_VIEW);
    // Make the background ensure slow so the user click lands mid-loop.
    let resolveB!: (v: unknown) => void;
    mEnsureEntity.mockImplementation(async (_v, name: string) => {
      if (name === "b") return new Promise((r) => (resolveB = r));
      return det(name);
    });
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    await flush(); // background loop is now awaiting "b"
    // User clicks c — generation bumps; when b finally resolves, the loop must
    // NOT continue on to c a second time.
    const clicked = act(() => result.current.selectManifestEntity("c"));
    resolveB(det("b"));
    await clicked;
    await flush();
    const calls = mEnsureEntity.mock.calls.map((c) => c[1]);
    // a (auto), b (background, in flight), c (user) — and NOTHING after c from
    // the abandoned loop.
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("a failing entity is skipped silently — warm-up, not a gate", async () => {
    mConnectManifest.mockResolvedValue(PENDING_VIEW);
    mEnsureEntity.mockImplementation(async (_v, name: string) => {
      if (name === "b") throw new Error("404");
      return det(name);
    });
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    await flush();
    await flush();
    const st = Object.fromEntries(result.current.manifest!.entities.map((e) => [e.name, e.status]));
    expect(st).toEqual({ a: "ready", b: "pending", c: "ready" });
    expect(result.current.sourceError).toBeNull(); // no user-facing error for a warm-up miss
  });
});
