/**
 * The validated request's source union (Phase-2 review): step 2 must return a
 * DISCRIMINATED source — kind "csv" with a guaranteed csvId, or kind
 * "warehouse" with a guaranteed {warehouse, connector} — so consumers narrow
 * once instead of re-asserting the "either id" invariant with `!`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: vi.fn(() => ({ schema: {} })),
}));
vi.mock("@/lib/warehouse/storage", () => ({
  getStoredWarehouse: vi.fn(() => ({ config: { type: "postgresql" }, tableSchemas: [] })),
  getWarehouseConnector: vi.fn(() => ({ executeSQL: vi.fn() })),
}));
vi.mock("@/lib/runtime-config", () => ({
  getActiveSandboxRuntime: vi.fn(() => "docker"),
  getActiveModels: vi.fn(() => ({
    codeGen: "claude-sonnet-4-6",
    uiCompose: "claude-sonnet-4-6",
  })),
}));

import { validateQueryIds, resolveQuerySources } from "@/lib/pipeline/validate-request";
import { getStoredCSV } from "@/lib/csv/storage";
import { getStoredWarehouse } from "@/lib/warehouse/storage";

beforeEach(() => {
  vi.mocked(getStoredCSV).mockClear();
  vi.mocked(getStoredWarehouse).mockClear();
});

describe("validateQueryIds", () => {
  it("400s when neither id is present, and when the question is empty", () => {
    expect(validateQueryIds({}, "q")).toMatchObject({ ok: false, status: 400 });
    expect(validateQueryIds({ csv_id: "c1" }, "  ")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("resolveQuerySources — source discrimination", () => {
  it("a csv request resolves to kind 'csv' with the id non-optional", () => {
    const out = resolveQuerySources({ csvId: "c1", warehouseId: undefined }, {});
    if (!out.ok) throw new Error("expected ok");
    expect(out.source).toEqual({ kind: "csv", csvId: "c1" });
  });

  it("a warehouse request resolves to kind 'warehouse' with live state attached", () => {
    const out = resolveQuerySources({ csvId: undefined, warehouseId: "w1" }, {});
    if (!out.ok) throw new Error("expected ok");
    expect(out.source.kind).toBe("warehouse");
    if (out.source.kind !== "warehouse") throw new Error("expected warehouse");
    expect(out.source.warehouseId).toBe("w1");
    expect(out.source.warehouseState.warehouse).toBeTruthy();
    expect(out.source.warehouseState.connector).toBeTruthy();
  });

  it("preferCsvOverWarehouse routes a follow-up with BOTH ids to kind 'csv'", () => {
    const out = resolveQuerySources(
      { csvId: "c1", warehouseId: "w1" },
      {},
      { preferCsvOverWarehouse: true }
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.source).toEqual({ kind: "csv", csvId: "c1" });
    expect(getStoredWarehouse).not.toHaveBeenCalled();
  });

  it("without the preference, both ids resolve to the warehouse (Ask behavior)", () => {
    const out = resolveQuerySources({ csvId: "c1", warehouseId: "w1" }, {});
    if (!out.ok) throw new Error("expected ok");
    expect(out.source.kind).toBe("warehouse");
  });

  it("404s a missing warehouse before streaming", () => {
    vi.mocked(getStoredWarehouse).mockReturnValueOnce(undefined as never);
    const out = resolveQuerySources({ csvId: undefined, warehouseId: "gone" }, {});
    expect(out).toMatchObject({ ok: false, status: 404 });
  });

  it("404s a missing CSV only when requireStoredCsv is set", () => {
    vi.mocked(getStoredCSV).mockReturnValue(undefined as never);
    const lax = resolveQuerySources({ csvId: "gone", warehouseId: undefined }, {});
    if (!lax.ok) throw new Error("expected ok — Ask reports expiry in-stream");
    expect(lax.source).toEqual({ kind: "csv", csvId: "gone" });

    const strict = resolveQuerySources(
      { csvId: "gone", warehouseId: undefined },
      {},
      { requireStoredCsv: true }
    );
    expect(strict).toMatchObject({ ok: false, status: 404 });
  });

  it("400s (not crashes) if a caller skips step 1 and passes neither id", () => {
    const out = resolveQuerySources({ csvId: undefined, warehouseId: undefined }, {});
    expect(out).toMatchObject({ ok: false, status: 400 });
  });
});

describe("resolveQuerySources — golden-source model/runtime resolution", () => {
  it("ignores per-request model/runtime fields: runtime-config is the only source", () => {
    // Regression: honoring context overrides let a stale client copy
    // (browser localStorage) fork the web onto a different model than MCP.
    const out = resolveQuerySources(
      { csvId: "c1", warehouseId: undefined },
      {
        code_gen_model: "claude-opus-5",
        ui_compose_model: "claude-opus-5",
        sandbox_runtime: "e2b",
      }
    );
    expect(out).toMatchObject({
      ok: true,
      codeGenModel: "claude-sonnet-4-6",
      uiComposeModel: "claude-sonnet-4-6",
      sandboxRuntime: "docker",
    });
  });
});
