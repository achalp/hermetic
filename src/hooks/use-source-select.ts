"use client";

/**
 * Data-source selection, extracted from page.tsx (ARCH-5): the local-file
 * browser flow (file/folder → schema extraction), remote Parquet URLs, the
 * shared upload path (hidden <input> + drag-drop, Excel routed to the sheet
 * picker), and the sample-data shortcut. Owns the browser-visibility and
 * extraction-in-progress state those flows share.
 */
import { useCallback, useState } from "react";
import type { CSVSchema, SheetInfo, SheetRelationship } from "@/lib/types";
import {
  extractLocalSchema,
  extractRemoteParquetSchema,
  uploadFile,
  type RemoteParquetCreds,
} from "@/lib/api";

export function useSourceSelect(args: {
  handleUpload: (csvId: string, schema: CSVSchema) => void;
  handleExcelSheets: (
    excelId: string,
    filename: string,
    sheets: SheetInfo[],
    relationships: SheetRelationship[]
  ) => void;
}) {
  const { handleUpload, handleExcelSheets } = args;

  const [showLocalBrowser, setShowLocalBrowser] = useState(false);
  const [isExtractingLocalSchema, setIsExtractingLocalSchema] = useState(false);

  const handleLocalFileSelect = useCallback(
    async (path: string, type: "file" | "folder") => {
      setIsExtractingLocalSchema(true);
      try {
        const data = await extractLocalSchema(path, type);
        if (data.csv_id && data.schema) {
          handleUpload(data.csv_id, data.schema);
          setShowLocalBrowser(false);
        } else if (data.excel_id && data.sheets) {
          handleExcelSheets(
            data.excel_id,
            data.filename ?? "local.xlsx",
            data.sheets!,
            data.relationships ?? []
          );
          setShowLocalBrowser(false);
        }
      } catch (err) {
        console.error("Local file schema extraction failed:", err);
      } finally {
        setIsExtractingLocalSchema(false);
      }
    },
    [handleUpload, handleExcelSheets]
  );

  const handleRemoteFileSelect = useCallback(
    async (url: string, creds?: RemoteParquetCreds) => {
      setIsExtractingLocalSchema(true);
      try {
        const data = await extractRemoteParquetSchema(url, creds);
        handleUpload(data.csv_id, data.schema);
        setShowLocalBrowser(false);
      } finally {
        setIsExtractingLocalSchema(false);
      }
    },
    [handleUpload]
  );

  // Shared upload path: used by both the hidden <input> and files dropped
  // directly onto the upload card. Routes Excel workbooks to the sheet picker.
  const processUploadFile = useCallback(
    async (file: File) => {
      try {
        const formData = new FormData();
        formData.append("csv", file);
        const data = await uploadFile(formData);
        if (data.excel_id && data.sheets) {
          handleExcelSheets(
            data.excel_id,
            data.filename ?? file.name,
            data.sheets,
            data.relationships ?? []
          );
        } else if (data.csv_id && data.schema) {
          handleUpload(data.csv_id, data.schema);
        }
      } catch (err) {
        console.error("Upload failed:", err);
      }
    },
    [handleExcelSheets, handleUpload]
  );

  const handleSampleData = useCallback(async () => {
    try {
      const response = await fetch("/sample-data/sales-data.csv");
      const blob = await response.blob();
      const file = new File([blob], "sales-data.csv", { type: "text/csv" });
      const formData = new FormData();
      formData.append("csv", file);
      const data = await uploadFile(formData);
      if (data.csv_id && data.schema) {
        handleUpload(data.csv_id, data.schema);
      }
    } catch (err) {
      console.error("Sample data load failed:", err);
    }
  }, [handleUpload]);

  /** Source-scoped UI state cleared by the page-level reset. */
  const resetSourceSelect = useCallback(() => {
    setShowLocalBrowser(false);
    setIsExtractingLocalSchema(false);
  }, []);

  return {
    showLocalBrowser,
    setShowLocalBrowser,
    isExtractingLocalSchema,
    handleLocalFileSelect,
    handleRemoteFileSelect,
    processUploadFile,
    handleSampleData,
    resetSourceSelect,
  };
}
