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
import { isValidModelId, isValidRuntimeId } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime, getActiveModels } from "@/lib/runtime-config";

import type { AnalysisRequestContext } from "@/lib/contracts/analysis-request";
/** @deprecated alias — use AnalysisRequestContext (modularization M1-1c). */
export type QueryRequestContext = AnalysisRequestContext;

export interface WarehouseState {
  warehouse: NonNullable<ReturnType<typeof getStoredWarehouse>>;
  connector: NonNullable<ReturnType<typeof getWarehouseConnector>>;
}

/**
 * Typed validation failure (modularization M3-3c) — this module previously
 * built HTTP Response objects, putting transport concerns in the library
 * layer (any non-HTTP harness got Responses it couldn't use). Callers map
 * {status, error} to their transport.
 */
export interface ValidationFailure {
  ok: false;
  status: number;
  error: string;
}

const fail = (error: string, status: number): ValidationFailure => ({ ok: false, status, error });

export type QueryIds =
  | { ok: true; csvId: string | undefined; warehouseId: string | undefined; question: string }
  | ValidationFailure;

/** Step 1 — the syntactic 400s: ids present, question present. */
export function validateQueryIds(context: QueryRequestContext, prompt?: string): QueryIds {
  const csvId = context.csv_id;
  const warehouseId = context.warehouse_id;
  const question = (context.question ?? prompt ?? "").trim();

  if (!csvId && !warehouseId) {
    return fail("csv_id or warehouse_id is required in context", 400);
  }
  if (!question) {
    return fail("question is required", 400);
  }
  return { ok: true, csvId, warehouseId, question };
}

/**
 * The validated request's data source, discriminated. Step 1 guarantees
 * "csv_id or warehouse_id present" but used to carry them as two independent
 * optionals, so every consumer re-asserted the invariant by hand (~25
 * `csvId!` / `warehouseState!` non-null assertions across run-ask-query,
 * run-investigate-query, and the orchestrator). The union makes the invariant
 * a type: narrow `kind` once and the fields each path needs are non-optional.
 */
export type ResolvedAnalysisSource =
  | { kind: "csv"; csvId: string }
  | { kind: "warehouse"; warehouseId: string; warehouseState: WarehouseState };

export type ResolvedQuerySources =
  | {
      ok: true;
      source: ResolvedAnalysisSource;
      codeGenModel: string;
      uiComposeModel: string;
      sandboxRuntime: SandboxRuntimeId;
    }
  | ValidationFailure;

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
  let source: ResolvedAnalysisSource;
  if (warehouseId && !(opts.preferCsvOverWarehouse && csvId)) {
    const warehouse = getStoredWarehouse(warehouseId);
    if (!warehouse) {
      return fail("Warehouse not found or expired. Please reconnect.", 404);
    }
    const connector = getWarehouseConnector(warehouseId);
    if (!connector) {
      return fail("Warehouse connector not found", 404);
    }
    source = { kind: "warehouse", warehouseId, warehouseState: { warehouse, connector } };
  } else if (csvId) {
    if (opts.requireStoredCsv && !getStoredCSV(csvId)) {
      return fail("CSV not found or expired", 404);
    }
    source = { kind: "csv", csvId };
  } else {
    // Unreachable when step 1 ran (it rejects "neither id"), but typed as a
    // 400 rather than asserted so a caller that skips validateQueryIds gets
    // the same clean failure instead of a crash on an assumed id.
    return fail("csv_id or warehouse_id is required in context", 400);
  }

  // Explicit per-request choice wins; otherwise the SERVER-side selection
  // (Settings UI via runtime-config) — so a request that sends no model
  // still honors the user's configured choice, same as MCP.
  const activeModels = getActiveModels();
  const codeGenModel =
    !opts.skipModelValidation && context.code_gen_model && isValidModelId(context.code_gen_model)
      ? context.code_gen_model
      : activeModels.codeGen;
  const uiComposeModel =
    !opts.skipModelValidation &&
    context.ui_compose_model &&
    isValidModelId(context.ui_compose_model)
      ? context.ui_compose_model
      : activeModels.uiCompose;
  const sandboxRuntime: SandboxRuntimeId =
    context.sandbox_runtime && isValidRuntimeId(context.sandbox_runtime)
      ? context.sandbox_runtime
      : getActiveSandboxRuntime();

  return { ok: true, source, codeGenModel, uiComposeModel, sandboxRuntime };
}
