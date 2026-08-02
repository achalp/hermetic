"use client";

/**
 * Data-source selection, extracted from page.tsx (ARCH-5): the local-file
 * browser flow (file/folder → schema extraction), remote Parquet URLs, the
 * shared upload path (hidden <input> + drag-drop, Excel routed to the sheet
 * picker), and the sample-data shortcut. Owns the browser-visibility and
 * extraction-in-progress state those flows share.
 */
import { useCallback, useState, useRef } from "react";
import type { CSVSchema, SheetInfo, SheetRelationship } from "@/lib/contracts/data-schema";
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
  // True once a remote Parquet source is loaded — gates the sidebar refresh
  // control (an uploaded CSV has no source to re-read).
  const [hasRemoteSource, setHasRemoteSource] = useState(false);
  // User-facing error from a source load (schema extraction, upload). Surfaced as
  // a dismissable banner by the page — previously these threw uncaught (the remote
  // path) or were console-logged only (local/upload), so a failure either hit the
  // Next.js error overlay or vanished silently.
  const [sourceError, setSourceError] = useState<string | null>(null);
  const errText = (err: unknown, fallback: string) =>
    err instanceof Error && err.message ? err.message : fallback;

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
        console.warn("Local file schema extraction failed:", err);
        setSourceError(errText(err, "Couldn't read that file."));
      } finally {
        setIsExtractingLocalSchema(false);
      }
    },
    [handleUpload, handleExcelSheets]
  );

  // Last remote Parquet source loaded — lets the schema sidebar's "refresh"
  // re-read it (with force) without re-typing the URL.
  const lastRemoteRef = useRef<{ url: string; creds?: RemoteParquetCreds } | null>(null);

  const handleRemoteFileSelect = useCallback(
    async (url: string, creds?: RemoteParquetCreds, force?: boolean) => {
      lastRemoteRef.current = { url, creds };
      setHasRemoteSource(true);
      setIsExtractingLocalSchema(true);
      setSourceError(null);
      try {
        const data = await extractRemoteParquetSchema(url, creds, force);
        handleUpload(data.csv_id, data.schema);
        setShowLocalBrowser(false);
      } catch (err) {
        // Catch (don't rethrow) so the failure shows as an in-app banner instead
        // of the Next.js error overlay. err.message is already user-friendly
        // (see friendlyParquetError in the schema route). NOTE: use console.warn,
        // NOT console.error — Next 16's dev overlay surfaces console.error(Error)
        // as a "Console ApiError", which would re-cover the app on top of the banner.
        console.warn("Remote Parquet schema extraction failed:", err);
        setSourceError(errText(err, "Couldn't read that Parquet source."));
      } finally {
        setIsExtractingLocalSchema(false);
      }
    },
    [handleUpload]
  );

  /** Re-read the last remote Parquet source, bypassing the schema cache. */
  const refreshRemote = useCallback(async () => {
    const last = lastRemoteRef.current;
    if (last) await handleRemoteFileSelect(last.url, last.creds, true);
  }, [handleRemoteFileSelect]);

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
        console.warn("Upload failed:", err);
        setSourceError(errText(err, "Upload failed."));
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
      console.warn("Sample data load failed:", err);
      setSourceError(errText(err, "Couldn't load the sample dataset."));
    }
  }, [handleUpload]);

  /** Source-scoped UI state cleared by the page-level reset. */
  const resetSourceSelect = useCallback(() => {
    setShowLocalBrowser(false);
    setIsExtractingLocalSchema(false);
    setHasRemoteSource(false);
    setSourceError(null);
    lastRemoteRef.current = null;
  }, []);

  return {
    showLocalBrowser,
    setShowLocalBrowser,
    isExtractingLocalSchema,
    handleLocalFileSelect,
    handleRemoteFileSelect,
    refreshRemote,
    hasRemoteSource,
    processUploadFile,
    handleSampleData,
    resetSourceSelect,
    sourceError,
    clearSourceError: () => setSourceError(null),
  };
}
