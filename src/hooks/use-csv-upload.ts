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
}

export function useCSVUpload() {
  const [state, setState] = useState<UploadState>({
    csvId: null,
    schema: null,
    isUploaded: false,
    excelMeta: null,
    showSheetPicker: false,
  });

  const handleUpload = useCallback((csvId: string, schema: CSVSchema) => {
    setState((prev) => ({
      csvId,
      schema,
      isUploaded: true,
      excelMeta: prev.excelMeta,
      showSheetPicker: false,
    }));
  }, []);

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
    });
  }, []);

  return {
    ...state,
    handleUpload,
    handleExcelSheets,
    switchSheet,
    cancelSheetPicker,
    reset,
  };
}
