"use client";

import { useCallback, useRef, useState } from "react";
import type { CSVSchema, SheetInfo } from "@/lib/types";

interface CSVUploadPanelProps {
  onUpload: (csvId: string, schema: CSVSchema) => void;
  onExcelSheets?: (excelId: string, filename: string, sheets: SheetInfo[]) => void;
  disabled?: boolean;
}

export function CSVUploadPanel({ onUpload, onExcelSheets, disabled }: CSVUploadPanelProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      setError(null);
      setIsUploading(true);

      try {
        const formData = new FormData();
        formData.append("csv", file);

        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error ?? "Upload failed");
        }

        if (data.excel_id && onExcelSheets) {
          onExcelSheets(data.excel_id, data.filename, data.sheets);
          return;
        }

        onUpload(data.csv_id, data.schema);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setIsUploading(false);
      }
    },
    [onUpload, onExcelSheets]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  return (
    <div
      className={`relative flex flex-col items-center justify-center border-2 border-dashed p-8 transition-colors ${
        isDragOver ? "border-accent bg-accent-subtle" : "border-border-dropzone bg-surface-dropzone"
      } ${disabled ? "pointer-events-none opacity-50" : "cursor-pointer"}`}
      style={{
        borderRadius: "var(--radius-card)",
        transitionDuration: "var(--transition-speed)",
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
      role="button"
      tabIndex={0}
      aria-label="Upload CSV, Excel, or GeoJSON file — drag and drop or click to browse"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fileInputRef.current?.click();
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xlsx,.geojson,.json"
        className="hidden"
        onChange={handleFileSelect}
        aria-label="Select CSV, Excel, or GeoJSON file"
      />
      <svg
        className="mb-3 h-10 w-10 text-t-tertiary"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
        />
      </svg>
      {isUploading ? (
        <p className="text-sm text-t-secondary">Uploading...</p>
      ) : (
        <>
          <p className="text-sm font-medium text-t-secondary">
            Drop your CSV, Excel, or GeoJSON file here, or click to browse
          </p>
          <p className="mt-1 text-xs text-t-tertiary">Max 100MB</p>
        </>
      )}
      {error && <p className="mt-2 text-sm text-error-text">{error}</p>}
    </div>
  );
}
