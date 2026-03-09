import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeGeoJSON, storeWorkbookManifest } from "@/lib/csv/storage";
import { loadSavedVisualization, saveNewVersion } from "@/lib/saved/storage";
import { schemasCompatible, schemaFingerprint } from "@/lib/saved/schema-compat";
import { executeSandbox } from "@/lib/sandbox";
import { ensureWarmSandboxReady } from "@/lib/sandbox/warm-sandbox";
import { prepareWarmSandbox } from "@/lib/sandbox";
import type { AdditionalFile } from "@/lib/sandbox";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import { sanitizeSheetName } from "@/lib/llm/prompts";
import type { SandboxRuntimeId } from "@/lib/constants";
import { isValidRuntimeId, DEFAULT_SANDBOX_RUNTIME } from "@/lib/constants";
import type { CSVSchema, SandboxExecutionResult, WorkbookManifest } from "@/lib/types";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { ParsedCSV } from "@/lib/csv/parser";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: vizId } = await params;

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const runtimeRaw = formData.get("sandbox_runtime") as string | null;
    const runtime: SandboxRuntimeId =
      runtimeRaw && isValidRuntimeId(runtimeRaw) ? runtimeRaw : DEFAULT_SANDBOX_RUNTIME;

    // 1. Load saved viz
    const savedViz = await loadSavedVisualization(vizId);

    // 2. Detect if saved viz was a workbook (multi-sheet) viz
    const isWorkbookViz = !!savedViz.workbook;
    const isExcelUpload = file.name.toLowerCase().endsWith(".xlsx");

    // 3. Parse uploaded file and set up storage + sandbox
    let newCsvId: string;
    let newSchema: CSVSchema;
    let normalizedCsv: string;
    let geojsonText: string | undefined;

    if (isWorkbookViz && isExcelUpload) {
      // Workbook rerun: parse ALL sheets from uploaded XLSX
      const wbResult = await parseWorkbookForRerun(file, runtime);
      if ("error" in wbResult) {
        return NextResponse.json({ error: wbResult.error }, { status: 400 });
      }
      newCsvId = wbResult.primaryCsvId;
      newSchema = wbResult.primarySchema;
      normalizedCsv = wbResult.primaryCsv;
    } else {
      // Single-file rerun (CSV, GeoJSON, JSON, or non-workbook XLSX)
      const parseResult = await parseUploadedFile(file);
      if ("error" in parseResult) {
        return NextResponse.json({ error: parseResult.error }, { status: 400 });
      }
      normalizedCsv = parseResult.normalizedCsv;
      geojsonText = parseResult.geojsonText;
      newCsvId = uuidv4();
      newSchema = extractSchema(parseResult.parsed, newCsvId, file.name);
      if (geojsonText) newSchema.has_geojson = true;

      await storeCSV(newCsvId, normalizedCsv, newSchema);
      if (geojsonText) await storeGeoJSON(newCsvId, geojsonText);
      await ensureWarmSandboxReady(newCsvId, normalizedCsv, runtime, geojsonText);
    }

    // 4. Build an expected schema from saved viz's CSV to compare
    const savedParsed = parseCSV(savedViz.csvContent);
    const savedSchema = extractSchema(savedParsed, "saved", savedViz.meta.csvFilename);

    const isCompatible = schemasCompatible(savedSchema, newSchema);

    // 5. Incompatible path — return info for client to re-query
    if (!isCompatible) {
      return NextResponse.json({
        schemaMatch: false,
        csvId: newCsvId,
        schema: newSchema,
        question: savedViz.meta.question,
      });
    }

    // 6. Compatible path — re-execute saved code with new data
    const execResult = await executeSandbox(
      normalizedCsv,
      savedViz.generatedCode,
      runtime,
      geojsonText,
      undefined,
      newCsvId
    );

    if (!execResult.success) {
      // Code failed on new data — fall back to incompatible path
      return NextResponse.json({
        schemaMatch: false,
        csvId: newCsvId,
        schema: newSchema,
        question: savedViz.meta.question,
      });
    }

    const successResult = execResult as SandboxExecutionResult;

    // 7. Clone spec and inject new data
    const newSpec = rehydrateSpec(savedViz.spec, savedViz.artifacts, successResult);

    // 8. Build new artifacts
    const newArtifacts: CachedArtifacts = {
      code: savedViz.generatedCode,
      question: savedViz.meta.question,
      results: successResult.results,
      chart_data: successResult.chart_data,
      datasets: successResult.datasets ?? {},
      execution_ms: successResult.execution_ms,
    };

    const fingerprint = schemaFingerprint(newSchema);

    // 9. Auto-save as new version
    const meta = await saveNewVersion(vizId, {
      csvFilename: file.name,
      csvContent: normalizedCsv,
      generatedCode: savedViz.generatedCode,
      spec: newSpec,
      artifacts: newArtifacts,
      schemaFingerprint: fingerprint,
    });

    return NextResponse.json({
      schemaMatch: true,
      spec: newSpec,
      artifacts: newArtifacts,
      meta,
      csvId: newCsvId,
      schema: newSchema,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Rerun failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── Workbook rerun ───────────────────────────────────────────────────

interface WorkbookRerunOk {
  primaryCsvId: string;
  primarySchema: CSVSchema;
  primaryCsv: string;
}

/**
 * Parse all sheets from an uploaded XLSX, store each sheet's CSV,
 * create a workbook manifest, and prepare a warm sandbox with all sheets.
 */
async function parseWorkbookForRerun(
  file: File,
  runtime: SandboxRuntimeId
): Promise<WorkbookRerunOk | { error: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const { sheets, workbook } = await parseExcelMeta(buffer);
  if (sheets.length === 0) return { error: "Excel file has no sheets" };

  const manifestSheets: WorkbookManifest["sheets"] = [];
  const additionalFiles: AdditionalFile[] = [];
  let primaryCsvId = "";
  let primarySchema: CSVSchema | null = null;
  let primaryCsv = "";

  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const csvText = sheetToCSV(workbook, sheet.name);
    const parsed = parseCSV(csvText);
    const csvId = uuidv4();
    const displayName = `${file.name} (${sheet.name})`;
    const schema = extractSchema(parsed, csvId, displayName);
    const normalized = toCSVText(parsed);

    await storeCSV(csvId, normalized, schema);
    manifestSheets.push({ name: sheet.name, csvId, schema });

    if (i === 0) {
      primaryCsvId = csvId;
      primarySchema = schema;
      primaryCsv = normalized;
    } else {
      const safeName = sanitizeSheetName(sheet.name);
      additionalFiles.push({ path: `/data/sheets/${safeName}.csv`, content: normalized });
    }
  }

  if (!primarySchema) return { error: "Excel file has no sheets" };

  // Store workbook manifest
  const manifest: WorkbookManifest = {
    sheets: manifestSheets,
    relationships: [], // relationships not re-detected on rerun
  };
  storeWorkbookManifest(primaryCsvId, manifest);

  // Prepare warm sandbox with all sheets
  prepareWarmSandbox(
    primaryCsvId,
    primaryCsv,
    runtime,
    null,
    additionalFiles.length > 0 ? additionalFiles : undefined
  );

  // Wait for sandbox to be ready
  await ensureWarmSandboxReady(primaryCsvId, primaryCsv, runtime);

  return { primaryCsvId, primarySchema, primaryCsv };
}

// ── File parsing ──────────────────────────────────────────────────────

type ParseOk = { parsed: ParsedCSV; normalizedCsv: string; geojsonText?: string };
type ParseErr = { error: string };

async function parseUploadedFile(file: File): Promise<ParseOk | ParseErr> {
  const name = file.name.toLowerCase();
  const isCSV = name.endsWith(".csv");
  const isExcel = name.endsWith(".xlsx");
  const isGeoJSONExt = name.endsWith(".geojson");
  const isJSON = name.endsWith(".json");

  if (!isCSV && !isExcel && !isGeoJSONExt && !isJSON) {
    return { error: "Only .csv, .xlsx, .geojson, and .json files are accepted" };
  }

  // GeoJSON (.geojson or .json that looks like GeoJSON)
  if (isGeoJSONExt || isJSON) {
    const text = await file.text();
    let isGeoJSON = isGeoJSONExt;
    if (isJSON) {
      try {
        isGeoJSON = isGeoJSONObject(JSON.parse(text));
      } catch {
        isGeoJSON = false;
      }
    }
    if (!isGeoJSON) {
      return { error: "JSON file is not valid GeoJSON" };
    }
    const gParsed = parseGeoJSON(text);
    if (gParsed.headers.length === 0) {
      return { error: "GeoJSON file has no properties" };
    }
    return { parsed: gParsed, normalizedCsv: toCSVText(gParsed), geojsonText: text };
  }

  // Excel
  if (isExcel) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { sheets, workbook } = await parseExcelMeta(buffer);
    if (sheets.length === 0) return { error: "Excel file has no sheets" };
    // Use first sheet for rerun (multi-sheet selection isn't practical here)
    const csvText = sheetToCSV(workbook, sheets[0].name);
    const parsed = parseCSV(csvText);
    if (parsed.headers.length === 0 || parsed.rowCount === 0) {
      return { error: "Excel sheet has no data" };
    }
    return { parsed, normalizedCsv: toCSVText(parsed) };
  }

  // CSV
  const text = await file.text();
  try {
    const parsed = parseCSV(text);
    if (parsed.headers.length === 0 || parsed.rowCount === 0) {
      return { error: "CSV file has no data" };
    }
    return { parsed, normalizedCsv: toCSVText(parsed) };
  } catch (parseErr) {
    return { error: parseErr instanceof Error ? parseErr.message : "Invalid CSV" };
  }
}

// ── Spec rehydration ──────────────────────────────────────────────────

/**
 * Clone the saved spec and inject new execution results.
 *
 * DataController specs: only replace state.datasets.main — the DataController
 * recomputes all chart data from the raw dataset on mount.
 *
 * Non-DataController specs: replace values in element props by matching
 * against old artifact values.
 */
function rehydrateSpec(
  savedSpec: Record<string, unknown>,
  oldArtifacts: CachedArtifacts | undefined,
  newResult: SandboxExecutionResult
): Record<string, unknown> {
  const spec = JSON.parse(JSON.stringify(savedSpec));

  const state = spec.state as Record<string, unknown> | undefined;
  if (!state) return spec;

  const datasets = state.datasets as Record<string, unknown> | undefined;
  const usesDataController = specUsesDataController(spec);

  if (usesDataController) {
    // DataController dashboards: replace the raw dataset only.
    // DataController reads from datasets.main and recomputes outputs on mount.
    if (datasets && newResult.datasets?.main) {
      datasets.main = newResult.datasets.main;
    }
  } else {
    // Non-DataController dashboards: replace the raw dataset if present,
    // then swap element props that match old artifact values with new ones.
    if (datasets && newResult.datasets?.main) {
      datasets.main = newResult.datasets.main;
    }
    if (oldArtifacts && spec.elements && typeof spec.elements === "object") {
      replaceElementProps(
        spec.elements as Record<string, Record<string, unknown>>,
        oldArtifacts,
        newResult
      );
    }
  }

  return spec;
}

/** Check if any element in the spec uses DataController. */
function specUsesDataController(spec: Record<string, unknown>): boolean {
  const elements = spec.elements as Record<string, Record<string, unknown>> | undefined;
  if (!elements || typeof elements !== "object") return false;
  return Object.values(elements).some((el) => el.type === "DataController");
}

/**
 * Walk spec elements (keyed by ID) and replace prop values that match
 * old artifact values with new ones.
 */
function replaceElementProps(
  elements: Record<string, Record<string, unknown>>,
  oldArtifacts: CachedArtifacts,
  newResult: SandboxExecutionResult
): void {
  for (const el of Object.values(elements)) {
    const props = el.props as Record<string, unknown> | undefined;
    if (!props) continue;

    // Replace scalar results (StatCard values, TrendIndicator, etc.)
    for (const [key, oldVal] of Object.entries(oldArtifacts.results)) {
      for (const [propKey, propVal] of Object.entries(props)) {
        if (propVal === oldVal && key in newResult.results) {
          props[propKey] = newResult.results[key];
        }
      }
    }

    // Replace chart_data arrays
    for (const [key, oldData] of Object.entries(oldArtifacts.chart_data)) {
      for (const [propKey, propVal] of Object.entries(props)) {
        if (deepEqual(propVal, oldData) && key in newResult.chart_data) {
          props[propKey] = newResult.chart_data[key];
        }
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}
