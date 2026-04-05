import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { loadHistoryEntry, deleteHistoryEntry } from "@/lib/history/storage";
import { storeCSV, storeLocalFileRef } from "@/lib/csv/storage";
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { v4 as uuidv4 } from "uuid";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const entry = await loadHistoryEntry(id);

    const csvId = uuidv4();

    if (entry.csvContent) {
      // Uploaded source: re-create in-memory CSV entry
      const parsed = parseCSV(entry.csvContent);
      const schema = extractSchema(parsed, csvId, entry.meta.sourceFile);
      await storeCSV(csvId, entry.csvContent, schema);
    } else if (entry.meta.localPath) {
      // Local file: re-create the local file reference
      try {
        const info = await stat(entry.meta.localPath);
        const isFolder =
          entry.meta.localPath.includes("**") || !entry.meta.localPath.endsWith(".parquet");
        storeLocalFileRef(csvId, entry.schema, entry.meta.localPath, info.mtimeMs, isFolder);
      } catch {
        // File may no longer exist — still return the entry for static viewing
      }
    } else {
      // Warehouse or unknown: store schema only so handleUpload works
      await storeCSV(csvId, "", entry.schema);
    }

    return NextResponse.json({
      meta: entry.meta,
      spec: entry.spec,
      artifacts: entry.artifacts,
      schema: entry.schema,
      csvId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load history entry";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteHistoryEntry(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete history entry";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
