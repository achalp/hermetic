/**
 * Shared request-validation preamble for the Ask and Investigate routes.
 *
 * Both routes accept the same core context (csv_id/warehouse_id/question +
 * model/runtime overrides) and performed the same checks with hand-copied
 * code that had already drifted (the model-validation provider lists differed
 * between the two — see ARCH-6). The preamble is split in two so each route
 * can keep its check ordering (Investigate's provider gate sits between the
 * syntactic 400s and the resource 404s):
 *
 *   1. validateQueryIds()    — csv_id/warehouse_id/question 400s
 *   2. resolveQuerySources() — warehouse/CSV 404s + model/runtime resolution
 *
 * Behaviors that genuinely differ stay options:
 * - Ask resolves the warehouse whenever warehouse_id is present; Investigate
 *   skips the lookup when a csv_id exists (a follow-up over an already-
 *   materialized pull) → `preferCsvOverWarehouse`.
 * - Investigate 404s a missing/expired CSV before streaming; Ask reports it
 *   in-stream → `requireStoredCsv`.
 * - Local providers skip Claude model-ID validation in Ask (getModel() uses
 *   the local model directly); Investigate refuses local providers outright
 *   between the two steps → `skipModelValidation`.
 */
import { getStoredCSV } from "@/lib/csv/storage";
import { getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";
import {
  CODE_GEN_MODEL,
  UI_COMPOSE_MODEL,
  isValidModelId,
  isValidRuntimeId,
} from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";

import type { AnalysisRequestContext } from "@/lib/contracts/analysis-request";
/** @deprecated alias — use AnalysisRequestContext (modularization M1-1c). */
export type QueryRequestContext = AnalysisRequestContext;

export interface WarehouseState {
  warehouse: NonNullable<ReturnType<typeof getStoredWarehouse>>;
  connector: NonNullable<ReturnType<typeof getWarehouseConnector>>;
}

function errorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type QueryIds =
  | { ok: true; csvId: string | undefined; warehouseId: string | undefined; question: string }
  | { ok: false; response: Response };

/** Step 1 — the syntactic 400s: ids present, question present. */
export function validateQueryIds(context: QueryRequestContext, prompt?: string): QueryIds {
  const csvId = context.csv_id;
  const warehouseId = context.warehouse_id;
  const question = (context.question ?? prompt ?? "").trim();

  if (!csvId && !warehouseId) {
    return {
      ok: false,
      response: errorResponse("csv_id or warehouse_id is required in context", 400),
    };
  }
  if (!question) {
    return { ok: false, response: errorResponse("question is required", 400) };
  }
  return { ok: true, csvId, warehouseId, question };
}

export type ResolvedQuerySources =
  | {
      ok: true;
      warehouseState: WarehouseState | null;
      codeGenModel: string;
      uiComposeModel: string;
      sandboxRuntime: SandboxRuntimeId;
    }
  | { ok: false; response: Response };

/** Step 2 — resource 404s (warehouse/CSV) + model/runtime resolution. */
export function resolveQuerySources(
  ids: { csvId: string | undefined; warehouseId: string | undefined },
  context: QueryRequestContext,
  opts: {
    /** Skip Claude model-ID validation (local providers use their own IDs). */
    skipModelValidation?: boolean;
    /** Skip the warehouse lookup when a csv_id is present (Investigate). */
    preferCsvOverWarehouse?: boolean;
    /** 404 a missing/expired CSV before streaming (Investigate). */
    requireStoredCsv?: boolean;
  } = {}
): ResolvedQuerySources {
  const { csvId, warehouseId } = ids;

  // Warehouse: validate the connection before streaming so failures are clean 404s.
  let warehouseState: WarehouseState | null = null;
  const lookupWarehouse = warehouseId && !(opts.preferCsvOverWarehouse && csvId);
  if (lookupWarehouse) {
    const warehouse = getStoredWarehouse(warehouseId);
    if (!warehouse) {
      return {
        ok: false,
        response: errorResponse("Warehouse not found or expired. Please reconnect.", 404),
      };
    }
    const connector = getWarehouseConnector(warehouseId);
    if (!connector) {
      return { ok: false, response: errorResponse("Warehouse connector not found", 404) };
    }
    warehouseState = { warehouse, connector };
  } else if (opts.requireStoredCsv && !getStoredCSV(csvId!)) {
    return { ok: false, response: errorResponse("CSV not found or expired", 404) };
  }

  const codeGenModel =
    !opts.skipModelValidation && context.code_gen_model && isValidModelId(context.code_gen_model)
      ? context.code_gen_model
      : CODE_GEN_MODEL;
  const uiComposeModel =
    !opts.skipModelValidation &&
    context.ui_compose_model &&
    isValidModelId(context.ui_compose_model)
      ? context.ui_compose_model
      : UI_COMPOSE_MODEL;
  const sandboxRuntime: SandboxRuntimeId =
    context.sandbox_runtime && isValidRuntimeId(context.sandbox_runtime)
      ? context.sandbox_runtime
      : getActiveSandboxRuntime();

  return { ok: true, warehouseState, codeGenModel, uiComposeModel, sandboxRuntime };
}
