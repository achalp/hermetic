import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { apiError } from "@/app/lib/api-error";
import { loadHistoryEntry, deleteHistoryEntry } from "@/lib/history/storage";
import { storeCSV, storeLocalFileRef } from "@/lib/csv/storage";
import { registerRemoteRefFromEntry } from "@/lib/history/rehydrate-source";
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { appendConversationTurn, buildTurnFromArtifacts } from "@/lib/pipeline/conversation-cache";
import { cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
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
    } else if (await registerRemoteRefFromEntry(csvId, entry)) {
      // Remote cloud Parquet (s3://, https://, gs://): the history record holds
      // the URL, so we rebuilt a LIVE remote ref (the shared rehydrator, also
      // used by the query path's cold-miss self-heal) — the restored analysis's
      // follow-up reads the bucket directly, instead of the dead header-only
      // placeholder that produced "CSV not found or expired. Please re-upload."
    } else if (entry.meta.sourceType === "warehouse") {
      // Warehouse: store a placeholder so the csvId exists for handleUpload,
      // but actual data will come from re-executing SQL via an active connection.
      // Use a header-only CSV so getCSVContent returns a truthy string.
      const headerLine = entry.schema.columns.map((c: { name: string }) => c.name).join(",") + "\n";
      const warehouseSchema = { ...entry.schema, source_type: "warehouse" as const };
      await storeCSV(csvId, headerLine, warehouseSchema);
    } else {
      // Unknown source: store schema with minimal CSV
      const headerLine = entry.schema.columns.map((c: { name: string }) => c.name).join(",") + "\n";
      await storeCSV(csvId, headerLine, entry.schema);
    }

    // Seed conversation cache so follow-up questions have context
    if (entry.artifacts) {
      appendConversationTurn(
        csvId,
        buildTurnFromArtifacts(entry.meta.question, entry.artifacts, entry.spec)
      );
      // Seed the ARTIFACTS cache under the fresh csvId too — every
      // csvId-keyed server capability (plan editing, artifacts fallback)
      // dead-ended after restore because the new id mapped to nothing
      // (the same seeding the conversation cache already gets).
      cacheArtifacts(csvId, entry.artifacts as CachedArtifacts);
    }

    return NextResponse.json({
      meta: entry.meta,
      spec: entry.spec,
      artifacts: entry.artifacts,
      schema: entry.schema,
      csvId,
    });
  } catch (err) {
    return apiError("/api/history/[id]", err, "Failed to load history entry", 404);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteHistoryEntry(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError("/api/history/[id]", err, "Failed to delete history entry");
  }
}
