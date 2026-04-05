import { NextResponse } from "next/server";
import { loadHistoryEntry, deleteHistoryEntry } from "@/lib/history/storage";
import { storeCSV } from "@/lib/csv/storage";
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { v4 as uuidv4 } from "uuid";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const entry = await loadHistoryEntry(id);

    let csvId: string | undefined;

    // For uploaded sources with stored CSV, re-create the in-memory entry
    if (entry.csvContent) {
      csvId = uuidv4();
      const parsed = parseCSV(entry.csvContent);
      const schema = extractSchema(parsed, csvId, entry.meta.sourceFile);
      await storeCSV(csvId, entry.csvContent, schema);
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
