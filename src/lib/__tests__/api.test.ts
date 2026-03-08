import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getProviders,
  getRuntimes,
  listVizs,
  deleteViz,
  saveViz,
  getArtifacts,
  selectSheet,
  selectWorkbook,
  ApiError,
} from "@/lib/api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

function mockErr(status: number, error: string) {
  return { ok: false, status, json: () => Promise.resolve({ error }) };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("api module", () => {
  describe("getProviders", () => {
    it("returns provider info on success", async () => {
      const data = { active: "anthropic", activeLabel: "Anthropic", configured: ["anthropic"] };
      mockFetch.mockResolvedValue(mockOk(data));
      const result = await getProviders();
      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledWith("/api/providers", { signal: undefined });
    });

    it("passes abort signal when provided", async () => {
      const data = { active: "anthropic", activeLabel: "Anthropic", configured: ["anthropic"] };
      mockFetch.mockResolvedValue(mockOk(data));
      const controller = new AbortController();
      await getProviders(controller.signal);
      expect(mockFetch).toHaveBeenCalledWith("/api/providers", { signal: controller.signal });
    });

    it("throws ApiError on failure", async () => {
      mockFetch.mockResolvedValue(mockErr(500, "Server error"));
      await expect(getProviders()).rejects.toThrow(ApiError);
      await expect(getProviders()).rejects.toThrow("Server error");
    });
  });

  describe("getRuntimes", () => {
    it("returns runtime list", async () => {
      const data = [{ id: "docker", label: "Docker", available: true }];
      mockFetch.mockResolvedValue(mockOk(data));
      const result = await getRuntimes();
      expect(result).toEqual(data);
    });
  });

  describe("selectSheet", () => {
    it("posts excel_id and sheet_name", async () => {
      const data = { csv_id: "abc", schema: {} };
      mockFetch.mockResolvedValue(mockOk(data));
      await selectSheet("excel-1", "Sheet1");
      expect(mockFetch).toHaveBeenCalledWith("/api/upload/select-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excel_id: "excel-1", sheet_name: "Sheet1" }),
      });
    });
  });

  describe("selectWorkbook", () => {
    it("posts excel_id", async () => {
      const data = { csv_id: "abc", schema: {} };
      mockFetch.mockResolvedValue(mockOk(data));
      await selectWorkbook("excel-1");
      expect(mockFetch).toHaveBeenCalledWith("/api/upload/select-workbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excel_id: "excel-1" }),
      });
    });
  });

  describe("listVizs", () => {
    it("unwraps vizs array from response", async () => {
      const vizs = [{ vizId: "v1", question: "Q", csvFilename: "f.csv", createdAt: 1 }];
      mockFetch.mockResolvedValue(mockOk({ vizs }));
      const result = await listVizs();
      expect(result).toEqual(vizs);
    });
  });

  describe("deleteViz", () => {
    it("sends DELETE request", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      await deleteViz("v1");
      expect(mockFetch).toHaveBeenCalledWith("/api/vizs/v1", { method: "DELETE" });
    });

    it("throws ApiError on failure", async () => {
      mockFetch.mockResolvedValue(mockErr(404, "Not found"));
      await expect(deleteViz("v1")).rejects.toThrow(ApiError);
    });
  });

  describe("saveViz", () => {
    it("posts csvId, spec, question", async () => {
      const meta = { vizId: "v1", question: "Q", csvFilename: "f.csv", createdAt: 1 };
      mockFetch.mockResolvedValue(mockOk({ meta }));
      const result = await saveViz("csv-1", { type: "chart" }, "What is X?");
      expect(result.meta).toEqual(meta);
      expect(mockFetch).toHaveBeenCalledWith("/api/vizs/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvId: "csv-1", spec: { type: "chart" }, question: "What is X?" }),
      });
    });
  });

  describe("getArtifacts", () => {
    it("fetches artifacts by csvId", async () => {
      const data = { code: "x=1", question: "Q", results: {}, execution_ms: 100 };
      mockFetch.mockResolvedValue(mockOk(data));
      const result = await getArtifacts("csv-1");
      expect(result.code).toBe("x=1");
    });

    it("throws ApiError when expired", async () => {
      mockFetch.mockResolvedValue(mockErr(404, "Artifacts expired"));
      await expect(getArtifacts("csv-1")).rejects.toThrow("Artifacts expired");
    });
  });

  describe("ApiError", () => {
    it("has status property", () => {
      const err = new ApiError("test", 404);
      expect(err.status).toBe(404);
      expect(err.message).toBe("test");
      expect(err.name).toBe("ApiError");
    });
  });
});
