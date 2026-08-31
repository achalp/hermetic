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
    expect(result.current.manifest).toEqual(VIEW);
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
