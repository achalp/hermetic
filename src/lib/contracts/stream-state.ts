/**
 * The typed wire protocol between the orchestration layer and the app UI
 * (modularization M1-1b; spec §3.2).
 *
 * The patch stream writes `__`-prefixed keys into `spec.state`. Before this
 * module they were an implicit sub-protocol: 13 keys typed nowhere, every
 * read an unchecked cast, and `__plan` had three incompatible client-side
 * shape declarations. This module is the single source of truth:
 *
 *   - producers (patch-stream, investigate route, compose, cost epilogue)
 *     emit values of these types under RESERVED_STATE_KEYS;
 *   - consumers read them ONLY via readStreamState() — the ratchet metric
 *     `untyped-stream-state-reads` enforces this;
 *   - composer-authored specs must not bind reserved keys —
 *     findReservedStateKeyViolations() checks that.
 *
 * LEAF MODULE: type-only imports and pure functions. Client components import
 * it freely; it must never grow a dependency on server code.
 */

import type { Spec } from "@/lib/contracts/spec";
// Type-only re-export — erased at runtime; grounding.ts is a zero-import
// pure module, so this adds no server dependency to client bundles.
import type { GroundingReport } from "./grounding";

export type { GroundingReport };

/** `/state/__progress` — coarse pipeline phase (Ask) or wave counter (Investigate). */
export interface ProgressMeta {
  stage?: string;
  step?: number;
  total?: number;
}

/** `/state/__exec` — live sandbox execution progress (see run-control SandboxProgress). */
export interface ExecState {
  phase?: string;
  detail?: string;
  fraction?: number;
  rows?: number;
  total_rows?: number;
  elapsed_ms?: number;
}

/** `/state/__estimate` — up-front duration caption shown in the progress card. */
export interface EstimateState {
  detail?: string;
}

/** `/state/__cost` — end-of-analysis cost summary (subset of CostSummary). */
export interface CostInfo {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  llmCalls: number;
}

export type PlanStepStatus =
  | "pending"
  | "running"
  | "done"
  | "success"
  | "degraded"
  | "failed"
  | "removed";

/**
 * One investigate sub-question. Superset of the shapes the plan panel and the
 * notebook independently declared before M1-1b.
 */
export interface PlanStep {
  index: number;
  question: string;
  rationale?: string;
  status?: PlanStepStatus | string;
  degradedReason?: string;
  error?: string;
  addedByReplanner?: boolean;
  addedByComposer?: boolean;
}

/** `/state/__plan` — the investigation plan, statuses updated in place. */
export interface PlanState {
  approach?: string;
  steps?: PlanStep[];
}

/** `/state/__cells/<n>` — per-step notebook cell state. */
export interface CellState {
  status?: string;
  cellSpec?: Spec;
}

/** `/state/__dataQuality` — degraded / failed / dropped sub-questions. */
export interface DataQualityState {
  degraded?: { stepNo: number; question: string; reason?: string }[];
  failed?: { stepNo: number; question: string; error?: string }[];
  removed?: { stepNo: number; question: string }[];
}

/** `/state/__synthesis` — investigate narrative summary. */
export interface SynthesisState {
  summary?: string;
  conclusion?: string;
}

/** Everything the orchestration layer writes into `spec.state`. */
export interface StreamState {
  __progress?: ProgressMeta;
  /** Present on the first state patch only; enables the Stop button. */
  __runId?: string;
  __exec?: ExecState;
  __estimate?: EstimateState;
  __cost?: CostInfo;
  /** Set when a warehouse result was materialized as a CSV for the sandbox. */
  __warehouse_csv_id?: string;
  __plan?: PlanState;
  __cells?: Record<string, CellState>;
  /** Raw per-step results — consumed by spec bindings, not read directly. */
  __results?: Record<string, unknown>;
  /** Chart-ready per-step data — consumed by spec bindings only. */
  __chart_data?: Record<string, unknown>;
  __dataQuality?: DataQualityState;
  __grounding?: GroundingReport;
  __synthesis?: SynthesisState;
  __error?: string;
}

/** Every reserved key, exactly as written to the wire. */
export const RESERVED_STATE_KEYS = [
  "__progress",
  "__runId",
  "__exec",
  "__estimate",
  "__cost",
  "__warehouse_csv_id",
  "__plan",
  "__cells",
  "__results",
  "__chart_data",
  "__dataQuality",
  "__grounding",
  "__synthesis",
  "__error",
] as const satisfies readonly (keyof StreamState)[];

/**
 * The one sanctioned way to read protocol state off a spec (or a bare state
 * record). Raw `state.__foo as ...` casts are ratchet-counted violations.
 */
export function readStreamState(
  source: Spec | { state?: unknown } | Record<string, unknown> | null | undefined
): StreamState {
  if (!source || typeof source !== "object") return {};
  const maybeSpec = source as { state?: unknown };
  const state = maybeSpec.state && typeof maybeSpec.state === "object" ? maybeSpec.state : source;
  return (state ?? {}) as StreamState;
}

/**
 * Guard for composer-authored specs: the `__` prefix belongs to the protocol.
 * Returns the offending keys — a composer writing `__plan` (or inventing
 * `__anything`) would silently collide with or squat on protocol state.
 */
export function findReservedStateKeyViolations(state: unknown): string[] {
  if (!state || typeof state !== "object") return [];
  return Object.keys(state).filter((k) => k.startsWith("__"));
}
