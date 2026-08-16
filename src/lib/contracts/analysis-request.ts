/**
 * The request contract for /api/query and /api/query/investigate
 * (modularization M1-1c).
 *
 * Before this module the client hand-built untyped object literals in two
 * places and the server cast against a QueryRequestContext missing 7 of the
 * fields actually sent — adding or renaming a field was a silent break in
 * both directions. Client body-builders and server parsing now share this
 * one type; the zod schema in lib/api-schemas.ts is declared as
 * z.ZodType<AnalysisRequest> so schema/type drift fails compilation.
 */

import type { SchemaMode } from "@/lib/contracts/data-schema";
import type { FilterValue } from "@/lib/contracts/spec-types";
import type { InvestigateScope } from "@/lib/contracts/investigation";

/** Drill-down context sent when the user clicks into a chart segment. */
export interface DrillDownContext {
  parent_question: string;
  filter_column: string;
  filter_value: FilterValue;
  segment_label: string;
  chart_title: string | null;
  /** Additional filters AND-combined with the primary filter (2D / multi-select). */
  additional_filters?: { column: string; value: FilterValue }[] | null;
}

export interface AnalysisRequestContext {
  csv_id?: string;
  warehouse_id?: string;
  /**
   * The analysis this run follows up on (the ?restore= id). Lets the query
   * path self-heal a cold csvId miss (e.g. after a server restart) by
   * rehydrating the source from the durable history record instead of failing
   * "CSV not found or expired" — see lib/history/rehydrate-source.ts.
   */
  history_id?: string;
  question?: string;
  schema_mode?: SchemaMode;
  /** Composer sight (composer-sight spec §1): "blind" (default — values
   *  never enter the composition prompt) or "sighted" (the composer sees
   *  the DERIVED Analysis Product values; raw datasets never). */
  composer_sight?: "blind" | "sighted";
  code_gen_model?: string;
  ui_compose_model?: string;
  sandbox_runtime?: string;
  purpose?: string;
  /** Edit-and-Rerun: use this Python instead of generating fresh code. */
  code?: string;
  /** Edit-and-Rerun (warehouse): use this SQL instead of generating it. */
  sql?: string;
  drill_down_context?: DrillDownContext;
  /** Scoped follow-up on a prior Investigate (investigate route only). */
  scope?: InvestigateScope;
  /** Eagerly compose notebook cells (investigate route only; default true). */
  compose_cells?: boolean;
}

export interface AnalysisRequest {
  prompt?: string;
  context?: AnalysisRequestContext;
}
