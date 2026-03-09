"use client";

import { useState, useCallback } from "react";
import type { CSVSchema, SheetInfo, SheetRelationship } from "@/lib/types";

interface ExcelMeta {
  excelId: string;
  filename: string;
  sheets: SheetInfo[];
  relationships: SheetRelationship[];
}

interface UploadState {
  csvId: string | null;
  schema: CSVSchema | null;
  isUploaded: boolean;
  excelMeta: ExcelMeta | null;
  showSheetPicker: boolean;
  isWorkbookMode: boolean;
}

export function useCSVUpload() {
  const [state, setState] = useState<UploadState>({
    csvId: null,
    schema: null,
    isUploaded: false,
    excelMeta: null,
    showSheetPicker: false,
    isWorkbookMode: false,
  });

  const handleUpload = useCallback((csvId: string, schema: CSVSchema) => {
    setState((prev) => ({
      csvId,
      schema,
      isUploaded: true,
      excelMeta: prev.excelMeta,
      showSheetPicker: false,
      isWorkbookMode: false,
    }));
  }, []);

  const handleWorkbookUpload = useCallback((csvId: string, schema: CSVSchema) => {
    setState((prev) => ({
      csvId,
      schema,
      isUploaded: true,
      excelMeta: prev.excelMeta,
      showSheetPicker: false,
      isWorkbookMode: true,
    }));
  }, []);

  /** Restore workbook mode from a saved viz — sets excelMeta and workbook mode together. */
  const loadWorkbookUpload = useCallback(
    (
      csvId: string,
      schema: CSVSchema,
      filename: string,
      sheets: SheetInfo[],
      relationships: SheetRelationship[]
    ) => {
      setState({
        csvId,
        schema,
        isUploaded: true,
        excelMeta: { excelId: "", filename, sheets, relationships },
        showSheetPicker: false,
        isWorkbookMode: true,
      });
    },
    []
  );

  const handleExcelSheets = useCallback(
    (
      excelId: string,
      filename: string,
      sheets: SheetInfo[],
      relationships: SheetRelationship[]
    ) => {
      setState({
        csvId: null,
        schema: null,
        isUploaded: false,
        excelMeta: { excelId, filename, sheets, relationships },
        showSheetPicker: true,
        isWorkbookMode: false,
      });
    },
    []
  );

  const switchSheet = useCallback(() => {
    setState((prev) => ({
      ...prev,
      showSheetPicker: true,
    }));
  }, []);

  const cancelSheetPicker = useCallback(() => {
    setState((prev) => ({
      ...prev,
      showSheetPicker: false,
    }));
  }, []);

  const reset = useCallback(() => {
    setState({
      csvId: null,
      schema: null,
      isUploaded: false,
      excelMeta: null,
      showSheetPicker: false,
      isWorkbookMode: false,
    });
  }, []);

  return {
    ...state,
    handleUpload,
    handleWorkbookUpload,
    loadWorkbookUpload,
    handleExcelSheets,
    switchSheet,
    cancelSheetPicker,
    reset,
  };
}
