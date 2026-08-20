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

import {
  extractLocalSchema,
  extractRemoteParquetSchema,
  fetchStaticAsset,
  uploadFile,
} from "@/app/lib/api";

const mLocal = extractLocalSchema as ReturnType<typeof vi.fn>;
const mRemote = extractRemoteParquetSchema as ReturnType<typeof vi.fn>;
const mStatic = fetchStaticAsset as ReturnType<typeof vi.fn>;
const mUpload = uploadFile as ReturnType<typeof vi.fn>;

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
