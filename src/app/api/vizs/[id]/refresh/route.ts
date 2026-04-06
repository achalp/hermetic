import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { stat } from "fs/promises";
import { dirname } from "path";
import { loadSavedVisualization } from "@/lib/saved/storage";
import { rehydrateSpec } from "@/lib/saved/rehydrate-spec";
import { executeSandbox } from "@/lib/sandbox";
import { ensureWarmSandboxReady } from "@/lib/sandbox/warm-sandbox";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { getWarehouseConnector } from "@/lib/warehouse/storage";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeLocalFileRef } from "@/lib/csv/storage";
import { saveHistoryEntry } from "@/lib/history/storage";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { SandboxExecutionResult } from "@/lib/types";
import { isValidRuntimeId } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";

/**
 * POST /api/vizs/[id]/refresh
 *
 * Re-run a saved visualization without LLM calls.
 * - Warehouse: re-execute SQL to get fresh data, then re-run the Python code
 * - Local file: re-run the Python code against the local file on disk
 * - Upload: re-run the Python code against the stored CSV
 *
 * Creates a new history entry with the refreshed results.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: vizId } = await params;
    const body = await request.json().catch(() => ({}));
    const warehouseId = body.warehouseId as string | undefined;
    const runtimeRaw = body.sandboxRuntime as string | undefined;
    const runtime: SandboxRuntimeId =
      runtimeRaw && isValidRuntimeId(runtimeRaw) ? runtimeRaw : getActiveSandboxRuntime();

    // 1. Load saved viz
    const savedViz = await loadSavedVisualization(vizId);
    const sourceType = savedViz.meta.sourceType ?? "upload";

    // 2. Get CSV content based on source type
    let csvContent: string;
    const csvFilename = savedViz.meta.csvFilename;
    let localMountPath: string | undefined;

    if (sourceType === "warehouse") {
      // Re-execute the SQL query against the warehouse
      const sql = savedViz.meta.sql ?? savedViz.artifacts?.sql;
      if (!sql) {
        return NextResponse.json(
          { error: "No SQL query saved for this visualization. Cannot refresh warehouse data." },
          { status: 400 }
        );
      }
      if (!warehouseId) {
        return NextResponse.json(
          { error: "Warehouse connection required. Please connect to the warehouse first." },
          { status: 400 }
        );
      }
      const connector = getWarehouseConnector(warehouseId);
      if (!connector) {
        return NextResponse.json(
          { error: "Warehouse connection expired or not found. Please reconnect." },
          { status: 404 }
        );
      }

      // Execute the saved SQL to get fresh data
      csvContent = await connector.executeSQL(sql);
    } else if (sourceType === "local") {
      const localPath = savedViz.meta.localPath;
      if (!localPath) {
        return NextResponse.json(
          { error: "No local file path saved for this visualization." },
          { status: 400 }
        );
      }

      // Determine if localPath is a file or directory to set the correct mount path
      const info = await stat(localPath);
      const isFolder = info.isDirectory();
      localMountPath = isFolder ? localPath : dirname(localPath);

      // Register a local file ref (no CSV content needed — code reads via bind-mount)
      const csvId = uuidv4();
      const savedParsed = parseCSV(savedViz.csvContent);
      const savedSchema = extractSchema(savedParsed, csvId, csvFilename);
      storeLocalFileRef(csvId, savedSchema, localPath, info.mtimeMs, isFolder);

      const execResult = await executeSandbox(
        "",
        savedViz.generatedCode,
        runtime,
        undefined,
        undefined,
        csvId,
        localMountPath
      );

      if (!execResult.success) {
        return NextResponse.json(
          { error: `Code execution failed: ${execResult.error ?? "Unknown error"}` },
          { status: 500 }
        );
      }

      const successResult = execResult as SandboxExecutionResult;
      const newSpec = rehydrateSpec(savedViz.spec, savedViz.artifacts, successResult);
      const newArtifacts: CachedArtifacts = {
        code: savedViz.generatedCode,
        question: savedViz.meta.question,
        results: successResult.results,
        chart_data: successResult.chart_data,
        datasets: successResult.datasets ?? {},
        execution_ms: successResult.execution_ms,
        sql: savedViz.meta.sql ?? savedViz.artifacts?.sql,
      };

      const historyMeta = await saveHistoryEntry({
        question: savedViz.meta.question,
        spec: newSpec,
        generatedCode: savedViz.generatedCode,
        schema: savedSchema,
        artifacts: newArtifacts,
        sourceFile: csvFilename,
        sourceType,
        localPath,
        executionMs: successResult.execution_ms,
      });

      return NextResponse.json({
        spec: newSpec,
        artifacts: newArtifacts,
        csvId,
        schema: savedSchema,
        historyId: historyMeta.id,
        executionMs: successResult.execution_ms,
      });
    } else {
      // Upload: use the stored CSV
      csvContent = savedViz.csvContent;
    }

    // 3. Store CSV in memory and prepare sandbox
    const csvId = uuidv4();
    const parsed = parseCSV(csvContent);
    const normalizedCsv = toCSVText(parsed);
    const schema = extractSchema(parsed, csvId, csvFilename);
    await storeCSV(csvId, normalizedCsv, schema);

    if (!localMountPath) {
      await ensureWarmSandboxReady(csvId, normalizedCsv, runtime);
    }

    // 4. Re-execute the saved code
    const execResult = await executeSandbox(
      normalizedCsv,
      savedViz.generatedCode,
      runtime,
      undefined, // geojson
      undefined, // additional files
      csvId,
      localMountPath
    );

    if (!execResult.success) {
      return NextResponse.json(
        {
          error: `Code execution failed: ${execResult.error ?? "Unknown error"}`,
        },
        { status: 500 }
      );
    }

    const successResult = execResult as SandboxExecutionResult;

    // 5. Rehydrate the spec with new execution results
    const newSpec = rehydrateSpec(savedViz.spec, savedViz.artifacts, successResult);

    // 6. Build new artifacts
    const newArtifacts: CachedArtifacts = {
      code: savedViz.generatedCode,
      question: savedViz.meta.question,
      results: successResult.results,
      chart_data: successResult.chart_data,
      datasets: successResult.datasets ?? {},
      execution_ms: successResult.execution_ms,
      sql: savedViz.meta.sql ?? savedViz.artifacts?.sql,
    };

    // 7. Save as a new history entry
    const historyMeta = await saveHistoryEntry({
      question: savedViz.meta.question,
      spec: newSpec,
      generatedCode: savedViz.generatedCode,
      schema,
      artifacts: newArtifacts,
      sourceFile: csvFilename,
      sourceType,
      localPath: savedViz.meta.localPath,
      executionMs: successResult.execution_ms,
      csvContent: sourceType === "upload" ? normalizedCsv : undefined,
    });

    return NextResponse.json({
      spec: newSpec,
      artifacts: newArtifacts,
      csvId,
      schema,
      historyId: historyMeta.id,
      executionMs: successResult.execution_ms,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refresh failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
