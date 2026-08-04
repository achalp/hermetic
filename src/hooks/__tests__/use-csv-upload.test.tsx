// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCSVUpload } from "@/hooks/use-csv-upload";
import type { CSVSchema, SheetInfo, SheetRelationship } from "@/lib/contracts/data-schema";

afterEach(() => {
  cleanup();
});

const makeSchema = (csvId: string): CSVSchema => ({
  csv_id: csvId,
  filename: `${csvId}.csv`,
  row_count: 100,
  columns: [],
  sample_rows: [],
});

const sheets: SheetInfo[] = [
  { name: "Sheet1", rowCount: 10, columnCount: 3 },
  { name: "Sheet2", rowCount: 20, columnCount: 4 },
];

const relationships: SheetRelationship[] = [
  {
    sourceSheet: "Sheet1",
    sourceColumn: "id",
    sourceColumnIndex: 0,
    targetSheet: "Sheet2",
    targetColumn: "sheet1_id",
    targetColumnIndex: 1,
    matchType: "exact_name",
    confidence: 0.95,
    isPrimaryKeyCandidate: true,
    isForeignKeyCandidate: true,
  },
];

describe("useCSVUpload", () => {
  it("starts with empty/unuploaded initial state", () => {
    const { result } = renderHook(() => useCSVUpload());
    expect(result.current.csvId).toBeNull();
    expect(result.current.schema).toBeNull();
    expect(result.current.isUploaded).toBe(false);
    expect(result.current.excelMeta).toBeNull();
    expect(result.current.showSheetPicker).toBe(false);
    expect(result.current.isWorkbookMode).toBe(false);
  });

  describe("handleUpload", () => {
    it("marks uploaded with single-CSV (non-workbook) mode", () => {
      const { result } = renderHook(() => useCSVUpload());
      const schema = makeSchema("csv-1");
      act(() => {
        result.current.handleUpload("csv-1", schema);
      });
      expect(result.current.csvId).toBe("csv-1");
      expect(result.current.schema).toBe(schema);
      expect(result.current.isUploaded).toBe(true);
      expect(result.current.isWorkbookMode).toBe(false);
      expect(result.current.showSheetPicker).toBe(false);
    });

    it("preserves any existing excelMeta", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.handleExcelSheets("ex-1", "book.xlsx", sheets, relationships);
      });
      const priorMeta = result.current.excelMeta;
      act(() => {
        result.current.handleUpload("csv-1", makeSchema("csv-1"));
      });
      expect(result.current.excelMeta).toBe(priorMeta);
      expect(result.current.showSheetPicker).toBe(false);
    });
  });

  describe("handleWorkbookUpload", () => {
    it("marks uploaded with workbook mode enabled", () => {
      const { result } = renderHook(() => useCSVUpload());
      const schema = makeSchema("wb-1");
      act(() => {
        result.current.handleWorkbookUpload("wb-1", schema);
      });
      expect(result.current.csvId).toBe("wb-1");
      expect(result.current.schema).toBe(schema);
      expect(result.current.isUploaded).toBe(true);
      expect(result.current.isWorkbookMode).toBe(true);
      expect(result.current.showSheetPicker).toBe(false);
    });

    it("preserves existing excelMeta", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.handleExcelSheets("ex-1", "book.xlsx", sheets, relationships);
      });
      const priorMeta = result.current.excelMeta;
      act(() => {
        result.current.handleWorkbookUpload("wb-1", makeSchema("wb-1"));
      });
      expect(result.current.excelMeta).toBe(priorMeta);
    });
  });

  describe("loadWorkbookUpload", () => {
    it("restores workbook mode with synthesized excelMeta (empty excelId)", () => {
      const { result } = renderHook(() => useCSVUpload());
      const schema = makeSchema("csv-9");
      act(() => {
        result.current.loadWorkbookUpload("csv-9", schema, "restored.xlsx", sheets, relationships);
      });
      expect(result.current.csvId).toBe("csv-9");
      expect(result.current.schema).toBe(schema);
      expect(result.current.isUploaded).toBe(true);
      expect(result.current.isWorkbookMode).toBe(true);
      expect(result.current.showSheetPicker).toBe(false);
      expect(result.current.excelMeta).toEqual({
        excelId: "",
        filename: "restored.xlsx",
        sheets,
        relationships,
      });
    });

    it("overwrites prior excelMeta entirely (does not merge)", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.handleExcelSheets("ex-prev", "old.xlsx", [], []);
      });
      act(() => {
        result.current.loadWorkbookUpload(
          "csv-9",
          makeSchema("csv-9"),
          "restored.xlsx",
          sheets,
          relationships
        );
      });
      expect(result.current.excelMeta?.excelId).toBe("");
      expect(result.current.excelMeta?.filename).toBe("restored.xlsx");
      expect(result.current.excelMeta?.sheets).toBe(sheets);
    });
  });

  describe("handleExcelSheets", () => {
    it("opens the sheet picker with excel meta and no uploaded csv", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.handleExcelSheets("ex-1", "book.xlsx", sheets, relationships);
      });
      expect(result.current.csvId).toBeNull();
      expect(result.current.schema).toBeNull();
      expect(result.current.isUploaded).toBe(false);
      expect(result.current.isWorkbookMode).toBe(false);
      expect(result.current.showSheetPicker).toBe(true);
      expect(result.current.excelMeta).toEqual({
        excelId: "ex-1",
        filename: "book.xlsx",
        sheets,
        relationships,
      });
    });

    it("clears a previously uploaded csv when re-detecting an excel workbook", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.handleUpload("csv-1", makeSchema("csv-1"));
      });
      act(() => {
        result.current.handleExcelSheets("ex-2", "next.xlsx", sheets, relationships);
      });
      expect(result.current.csvId).toBeNull();
      expect(result.current.schema).toBeNull();
      expect(result.current.isUploaded).toBe(false);
    });
  });

  describe("switchSheet", () => {
    it("re-opens the sheet picker while preserving other state", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.handleExcelSheets("ex-1", "book.xlsx", sheets, relationships);
      });
      // pick a sheet -> simulate uploaded csv with picker closed
      act(() => {
        result.current.handleUpload("csv-1", makeSchema("csv-1"));
      });
      expect(result.current.showSheetPicker).toBe(false);
      const metaBefore = result.current.excelMeta;
      act(() => {
        result.current.switchSheet();
      });
      expect(result.current.showSheetPicker).toBe(true);
      expect(result.current.csvId).toBe("csv-1");
      expect(result.current.excelMeta).toBe(metaBefore);
    });
  });

  describe("cancelSheetPicker", () => {
    it("closes the picker while preserving other state", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.handleExcelSheets("ex-1", "book.xlsx", sheets, relationships);
      });
      expect(result.current.showSheetPicker).toBe(true);
      const metaBefore = result.current.excelMeta;
      act(() => {
        result.current.cancelSheetPicker();
      });
      expect(result.current.showSheetPicker).toBe(false);
      expect(result.current.excelMeta).toBe(metaBefore);
    });
  });

  describe("reset", () => {
    it("clears all state back to the initial shape", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.loadWorkbookUpload(
          "csv-9",
          makeSchema("csv-9"),
          "restored.xlsx",
          sheets,
          relationships
        );
      });
      expect(result.current.isUploaded).toBe(true);
      act(() => {
        result.current.reset();
      });
      expect(result.current.csvId).toBeNull();
      expect(result.current.schema).toBeNull();
      expect(result.current.isUploaded).toBe(false);
      expect(result.current.excelMeta).toBeNull();
      expect(result.current.showSheetPicker).toBe(false);
      expect(result.current.isWorkbookMode).toBe(false);
    });
  });

  describe("multi-step flows", () => {
    it("excel detect -> pick sheet -> switch sheet -> cancel", () => {
      const { result } = renderHook(() => useCSVUpload());
      act(() => {
        result.current.handleExcelSheets("ex-1", "book.xlsx", sheets, relationships);
      });
      expect(result.current.showSheetPicker).toBe(true);
      act(() => {
        result.current.handleUpload("csv-from-sheet", makeSchema("csv-from-sheet"));
      });
      expect(result.current.isUploaded).toBe(true);
      expect(result.current.showSheetPicker).toBe(false);
      act(() => {
        result.current.switchSheet();
      });
      expect(result.current.showSheetPicker).toBe(true);
      act(() => {
        result.current.cancelSheetPicker();
      });
      expect(result.current.showSheetPicker).toBe(false);
      expect(result.current.csvId).toBe("csv-from-sheet");
    });
  });
});
