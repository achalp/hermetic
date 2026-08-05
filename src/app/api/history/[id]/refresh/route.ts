import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { apiError } from "@/app/lib/api-error";
import { stat } from "fs/promises";
import { dirname } from "path";
import { loadHistoryEntry, saveHistoryEntry } from "@/lib/history/storage";
import { rehydrateSpec } from "@/lib/saved/rehydrate-spec";
import { executeSandbox } from "@/lib/sandbox";
import { getRunId } from "@/lib/run-context";
import { ensureWarmSandboxReady } from "@/lib/sandbox/warm-sandbox";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { getWarehouseConnector } from "@/lib/warehouse/storage";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeLocalFileRef } from "@/lib/csv/storage";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import type { SandboxExecutionResult } from "@/lib/contracts/execution";
import { isValidRuntimeId } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";

/**
 * POST /api/history/[id]/refresh
 *
 * Re-run a history entry without LLM calls.
 * Same logic as viz refresh but loads from history storage.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: historyId } = await params;
    const body = await request.json().catch(() => ({}));
    const warehouseId = body.warehouseId as string | undefined;
    const runtimeRaw = body.sandboxRuntime as string | undefined;
    const runtime: SandboxRuntimeId =
      runtimeRaw && isValidRuntimeId(runtimeRaw) ? runtimeRaw : getActiveSandboxRuntime();

    // 1. Load history entry
    const entry = await loadHistoryEntry(historyId);
    const sourceType = entry.meta.sourceType ?? "upload";

    // 2. Get CSV content based on source type
    let csvContent: string;
    let localMountPath: string | undefined;

    if (sourceType === "warehouse") {
      const sql = entry.artifacts?.sql;
      if (!sql) {
        return NextResponse.json(
          { error: "No SQL query saved for this analysis. Cannot refresh warehouse data." },
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
      csvContent = await connector.executeSQL(sql);
    } else if (sourceType === "local") {
      const localPath = entry.meta.localPath;
      if (!localPath) {
        return NextResponse.json(
          { error: "No local file path saved for this analysis." },
          { status: 400 }
        );
      }

      // Determine if localPath is a file or directory to set the correct mount path
      const info = await stat(localPath);
      const isFolder = info.isDirectory();
      localMountPath = isFolder ? localPath : dirname(localPath);

      // Local files use bind-mount; register a ref instead of storing CSV content
      const csvId = uuidv4();
      storeLocalFileRef(csvId, entry.schema, localPath, info.mtimeMs, isFolder);

      // Execute saved code with bind-mount
      const execResult = await executeSandbox(
        "", // no CSV content needed — code reads from bind-mount
        entry.generatedCode,
        // runId: container attribution label (WS-D) — injected here because
        // the sandbox layer never reads run-context itself.
        { runtime, csvId, localMountPath, runId: getRunId() }
      );

      if (!execResult.success) {
        return NextResponse.json(
          { error: `Code execution failed: ${execResult.error ?? "Unknown error"}` },
          { status: 500 }
        );
      }

      const successResult = execResult as SandboxExecutionResult;
      const newSpec = rehydrateSpec(entry.spec, entry.artifacts, successResult);
      const newArtifacts: CachedArtifacts = {
        code: entry.generatedCode,
        question: entry.meta.question,
        results: successResult.results,
        chart_data: successResult.chart_data,
        datasets: successResult.datasets ?? {},
        execution_ms: successResult.execution_ms,
        sql: entry.artifacts?.sql,
        // Preserve the investigation audit trail across refreshes — the
        // refresh re-executes the top-level code, it does not re-investigate.
        investigation: entry.artifacts?.investigation,
      };

      const newMeta = await saveHistoryEntry({
        question: entry.meta.question,
        spec: newSpec,
        generatedCode: entry.generatedCode,
        schema: entry.schema,
        artifacts: newArtifacts,
        sourceFile: entry.meta.sourceFile,
        sourceType,
        localPath,
        executionMs: successResult.execution_ms,
      });

      return NextResponse.json({
        spec: newSpec,
        artifacts: newArtifacts,
        csvId,
        schema: entry.schema,
        historyId: newMeta.id,
        executionMs: successResult.execution_ms,
      });
    } else {
      // Upload: use stored CSV
      if (!entry.csvContent) {
        return NextResponse.json(
          { error: "No CSV content stored for this analysis." },
          { status: 400 }
        );
      }
      csvContent = entry.csvContent;
    }

    // 3. Store CSV and prepare sandbox
    const csvId = uuidv4();
    const parsed = parseCSV(csvContent);
    const normalizedCsv = toCSVText(parsed);
    const schema = extractSchema(parsed, csvId, entry.meta.sourceFile);
    await storeCSV(csvId, normalizedCsv, schema);

    if (!localMountPath) {
      await ensureWarmSandboxReady(csvId, normalizedCsv, runtime);
    }

    // 4. Re-execute the saved code
    const execResult = await executeSandbox(normalizedCsv, entry.generatedCode, {
      runtime,
      csvId,
      localMountPath,
      // Container attribution label (WS-D) — see above.
      runId: getRunId(),
    });

    if (!execResult.success) {
      return NextResponse.json(
        { error: `Code execution failed: ${execResult.error ?? "Unknown error"}` },
        { status: 500 }
      );
    }

    const successResult = execResult as SandboxExecutionResult;

    // 5. Rehydrate spec with new results
    const newSpec = rehydrateSpec(entry.spec, entry.artifacts, successResult);

    // 6. Build new artifacts
    const newArtifacts: CachedArtifacts = {
      code: entry.generatedCode,
      question: entry.meta.question,
      results: successResult.results,
      chart_data: successResult.chart_data,
      datasets: successResult.datasets ?? {},
      execution_ms: successResult.execution_ms,
      sql: entry.artifacts?.sql,
      investigation: entry.artifacts?.investigation,
    };

    // 7. Save as new history entry
    const newMeta = await saveHistoryEntry({
      question: entry.meta.question,
      spec: newSpec,
      generatedCode: entry.generatedCode,
      schema,
      artifacts: newArtifacts,
      sourceFile: entry.meta.sourceFile,
      sourceType,
      localPath: entry.meta.localPath,
      executionMs: successResult.execution_ms,
      csvContent: sourceType === "upload" ? normalizedCsv : undefined,
    });

    return NextResponse.json({
      spec: newSpec,
      artifacts: newArtifacts,
      csvId,
      schema,
      historyId: newMeta.id,
      executionMs: successResult.execution_ms,
    });
  } catch (err) {
    return apiError("/api/history/[id]/refresh", err, "Refresh failed");
  }
}
