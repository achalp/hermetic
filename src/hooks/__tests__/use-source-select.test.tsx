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
  getManifestEntityDetail: vi.fn(),
  selectManifestEntities: vi.fn(),
}));

import {
  extractLocalSchema,
  extractRemoteParquetSchema,
  fetchStaticAsset,
  uploadFile,
} from "@/app/lib/api";
import {
  connectManifest,
  ensureManifestEntity,
  getManifestEntityDetail,
  selectManifestEntities,
} from "@/app/lib/manifest-connect";

const mLocal = extractLocalSchema as ReturnType<typeof vi.fn>;
const mRemote = extractRemoteParquetSchema as ReturnType<typeof vi.fn>;
const mStatic = fetchStaticAsset as ReturnType<typeof vi.fn>;
const mUpload = uploadFile as ReturnType<typeof vi.fn>;
const mConnectManifest = connectManifest as ReturnType<typeof vi.fn>;
const mEnsureEntity = ensureManifestEntity as ReturnType<typeof vi.fn>;
const mGetDetail = getManifestEntityDetail as ReturnType<typeof vi.fn>;
const mSelectEntities = selectManifestEntities as ReturnType<typeof vi.fn>;

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
  mGetDetail.mockReset();
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

  /** Detail as the CHEAP endpoint returns it for an entity nobody profiled:
   *  no schema, no csvId — only what the catalog declares. */
  const declaredOnly = (name: string) => ({
    name,
    status: "pending",
    url: `https://h/data/${name}.parquet`,
    columnDocs: [{ name: "geometry", description: "WKB polygon" }],
  });

  it("connect never PROFILES — it adopts an already-profiled entity and leaves the rest alone", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mGetDetail.mockResolvedValue(detail("population", "c-pop"));
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    // The parquet path was never taken; the manifest one was.
    expect(mRemote).not.toHaveBeenCalled();
    expect(result.current.manifest).toMatchObject({ manifestId: "m1", title: "Housing hub" });
    // NOTHING was extracted: profiling a whole catalog at connect costs ~50s of
    // remote egress per entity, for entities nobody may ever ask about.
    expect(mEnsureEntity).not.toHaveBeenCalled();
    // The entity already profiled (cache hit at connect) becomes the active
    // source through the CHEAP detail read, so the explorer opens with real data.
    expect(mGetDetail).toHaveBeenCalledWith("m1", "population");
    expect(result.current.activeEntityName).toBe("population");
    expect(handleUpload).toHaveBeenCalledWith("c-pop", expect.objectContaining({ row_count: 7 }));
  });

  it("a catalog with NOTHING profiled connects instantly and touches no entity", async () => {
    mConnectManifest.mockResolvedValue({
      ...VIEW,
      entities: VIEW.entities.map((e) => ({
        name: e.name,
        url: e.url,
        status: "pending",
        rowCountIsExact: false,
      })),
    });
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    expect(result.current.manifest!.entities).toHaveLength(2);
    expect(mEnsureEntity).not.toHaveBeenCalled();
    expect(mGetDetail).not.toHaveBeenCalled();
    expect(handleUpload).not.toHaveBeenCalled();
    expect(result.current.activeEntityName).toBeNull();
  });

  it("selecting an UNPROFILED entity shows what the catalog declares — and profiles nothing", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mGetDetail.mockResolvedValueOnce(detail("population", "c-pop"));
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    handleUpload.mockClear();

    mGetDetail.mockResolvedValueOnce(declaredOnly("housing"));
    await act(() => result.current.selectManifestEntity("housing"));

    expect(mEnsureEntity).not.toHaveBeenCalled(); // a click is not a profile
    expect(result.current.activeEntityName).toBe("housing");
    expect(result.current.entityPreview).toEqual({
      name: "housing",
      columns: [{ name: "geometry", description: "WKB polygon" }],
    });
    // The previous entity's schema must not keep feeding the rail under the new
    // entity's name — the preview is what the rail renders instead.
    expect(handleUpload).not.toHaveBeenCalled();
    expect(result.current.manifest!.entities[0]!.status).toBe("pending");
  });

  it("profileManifestEntity is the EXPLICIT action: it extracts, swaps the source, updates the list", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mGetDetail.mockResolvedValueOnce(detail("population", "c-pop"));
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    mGetDetail.mockResolvedValueOnce(declaredOnly("housing"));
    await act(() => result.current.selectManifestEntity("housing"));
    mEnsureEntity.mockResolvedValueOnce(detail("housing", "c-house"));
    await act(() => result.current.profileManifestEntity("housing"));

    expect(mEnsureEntity).toHaveBeenCalledWith(VIEW, "housing", undefined);
    expect(result.current.entityPreview).toBeNull(); // declared view gives way to real data
    expect(result.current.activeEntityName).toBe("housing");
    expect(handleUpload).toHaveBeenLastCalledWith("c-house", expect.anything());
    const housing = result.current.manifest!.entities.find((e) => e.name === "housing")!;
    expect(housing).toMatchObject({ status: "ready", rowCount: 7, rowCountIsExact: true });
  });

  it("selecting an entity profiled EARLIER makes it active with no extraction", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mGetDetail.mockResolvedValueOnce(detail("population", "c-pop"));
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    mGetDetail.mockResolvedValueOnce(declaredOnly("housing"));
    await act(() => result.current.selectManifestEntity("housing"));
    handleUpload.mockClear();
    mGetDetail.mockResolvedValueOnce(detail("population", "c-pop"));
    await act(() => result.current.selectManifestEntity("population"));

    expect(mEnsureEntity).not.toHaveBeenCalled();
    expect(result.current.entityPreview).toBeNull();
    expect(handleUpload).toHaveBeenCalledWith("c-pop", expect.anything());
  });

  it("re-selecting the ACTIVE entity is a no-op (no spinner, no re-read)", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mGetDetail.mockResolvedValue(detail("population", "c-pop"));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    mGetDetail.mockClear();
    await act(() => result.current.selectManifestEntity("population"));
    expect(mGetDetail).not.toHaveBeenCalled();
    expect(mEnsureEntity).not.toHaveBeenCalled();
  });

  it("a failed PROFILE surfaces the error and keeps the previous source", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mGetDetail.mockResolvedValueOnce(detail("population", "c-pop"));
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    handleUpload.mockClear();

    mEnsureEntity.mockRejectedValueOnce(new Error("404 from the source"));
    await act(() => result.current.profileManifestEntity("housing"));

    expect(result.current.sourceError).toContain("404");
    expect(handleUpload).not.toHaveBeenCalled();
    expect(result.current.activeEntityName).toBe("population"); // unchanged
  });

  it("resetSourceSelect clears the manifest state", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mGetDetail.mockResolvedValue(detail("population", "c-pop"));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    act(() => result.current.resetSourceSelect());
    expect(result.current.manifest).toBeNull();
    expect(result.current.activeEntityName).toBeNull();
  });
});

describe("useSourceSelect — per-question table scope visibility (manifestPick)", () => {
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

  it("a successful pre-step exposes the pick (names) and the multi-entity request", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockImplementation((_v: unknown, name: string) =>
      Promise.resolve(detail(name, `c-${name}`))
    );
    mSelectEntities.mockResolvedValue({ entities: ["housing", "population"] });
    mGetDetail.mockResolvedValue(detail("population", "c-pop"));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    await act(() => result.current.prepareManifestForQuestion("compare housing to population"));
    expect(result.current.manifestPick).toEqual({
      kind: "picked",
      names: ["housing", "population"],
    });
    expect(result.current.manifestQuestion).toEqual({
      manifest_id: "m1",
      entities: [
        { name: "housing", csv_id: "c-housing" },
        { name: "population", csv_id: "c-population" },
      ],
    });
  });

  it("run-a897dbcc regression: escorts alone NEVER satisfy a pick — subject failure means fallback", async () => {
    // The model picked "housing" (the subject); the boundary escort was
    // auto-included. If the SUBJECT fails to load (transient network error),
    // running on the escort alone would answer a different question — the
    // pre-step must fall back to the active entity instead.
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockImplementation((_v: unknown, name: string) =>
      name === "housing"
        ? Promise.reject(new Error("NetworkError"))
        : Promise.resolve(detail(name, `c-${name}`))
    );
    mSelectEntities.mockResolvedValue({
      entities: ["housing", "population"],
      autoIncluded: ["population"],
    });
    mGetDetail.mockResolvedValue(detail("population", "c-pop"));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    await act(() => result.current.prepareManifestForQuestion("analyze housing"));
    expect(result.current.manifestQuestion).toBeNull(); // escorts alone = no pick
    expect(result.current.manifestPick).toEqual({ kind: "fallback", active: "population" });
    // The failed subject was retried once before giving up.
    expect(mEnsureEntity.mock.calls.filter((c) => c[1] === "housing")).toHaveLength(2);
  });

  it("a PARTIAL drop proceeds but names the casualty in the pick", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockImplementation((_v: unknown, name: string) =>
      name === "population"
        ? Promise.reject(new Error("NetworkError"))
        : Promise.resolve(detail(name, `c-${name}`))
    );
    mSelectEntities.mockResolvedValue({
      entities: ["housing", "population"],
      autoIncluded: [],
    });
    mGetDetail.mockResolvedValue(detail("population", "c-pop"));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    await act(() => result.current.prepareManifestForQuestion("compare things"));
    expect(result.current.manifestPick).toEqual({
      kind: "picked",
      names: ["housing"],
      dropped: ["population"],
    });
    expect(result.current.manifestQuestion?.entities).toEqual([
      { name: "housing", csv_id: "c-housing" },
    ]);
  });

  it("the fallback PROFILES an entity when nothing is profiled yet — a question must have data", async () => {
    // Profile-on-demand means a fresh catalog has no ready entity at all. If the
    // selection pre-step also fails, the fallback has to MAKE a source rather
    // than assume one, or the question dispatches against nothing.
    mConnectManifest.mockResolvedValue({
      ...VIEW,
      entities: VIEW.entities.map((e) => ({
        name: e.name,
        url: e.url,
        status: "pending",
        rowCountIsExact: false,
      })),
    });
    const { result, handleUpload } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));
    expect(handleUpload).not.toHaveBeenCalled();

    mSelectEntities.mockRejectedValue(new Error("selection unavailable"));
    mEnsureEntity.mockResolvedValue(detail("housing", "c-housing"));
    await act(() => result.current.prepareManifestForQuestion("anything"));

    expect(mEnsureEntity).toHaveBeenCalledWith(expect.anything(), "housing", undefined);
    expect(handleUpload).toHaveBeenCalledWith("c-housing", expect.anything());
    expect(result.current.manifestPick).toEqual({ kind: "fallback", active: "housing" });
    expect(result.current.entityPreview).toBeNull();
  });

  it("a FAILED pre-step surfaces the single-entity fallback instead of narrowing silently", async () => {
    mConnectManifest.mockResolvedValue(VIEW);
    mEnsureEntity.mockImplementation((_v: unknown, name: string) =>
      Promise.resolve(detail(name, `c-${name}`))
    );
    mGetDetail.mockResolvedValue(detail("population", "c-pop"));
    const { result } = setup();
    await act(() => result.current.handleRemoteFileSelect("https://h/data/manifest.json"));

    mSelectEntities.mockRejectedValue(new Error("selection unavailable"));
    await act(() => result.current.prepareManifestForQuestion("anything"));
    expect(result.current.manifestPick).toEqual({ kind: "fallback", active: "population" });
    expect(result.current.manifestQuestion).toBeNull();
  });
});
