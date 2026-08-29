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
import type { AdditionalFile } from "@/lib/contracts/execution";
// Type-only re-export — erased at runtime; grounding.ts is a zero-import
// pure module, so this adds no server dependency to client bundles.
import type { GroundingReport } from "./grounding";

export type { GroundingReport };

/**
 * One parsed NDJSON line of the patch stream — the unit every harness-side
 * consumer (CLI, MCP analyze, disconnect history-save) reads back. Fields
 * are optional because a parsed line is only *probably* a patch (the stream
 * also carries keepalives and progress noise): consumers narrow with
 * `typeof`/`===` checks rather than assert. The strict producer-side shape
 * is spec/core's SpecStreamLine; this is the tolerant consumer-side read.
 * Owned here so patch-lines / assemble-spec / the MCP tools share ONE
 * definition instead of three drifting locals bridged with `as never`.
 */
export interface PatchLine {
  op?: string;
  path?: string;
  value?: unknown;
}

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
  "pending" | "running" | "done" | "success" | "degraded" | "failed" | "removed";

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

/**
 * `/state/__wasm_exec` — a live webview execute-request (the sidecar↔webview
 * handoff; build log D6). The Node run emits this into the stream; the browser
 * worker runs {code, csvContent, files} under the locked exec-CSP and POSTs the
 * result envelope to `/api/wasm-result?id=…`. Shared here (not in the server
 * handoff module) so the browser consumer imports it without any server code.
 */
export interface WasmExecuteRequest {
  type: "wasm-execute";
  id: string;
  csvContent: string;
  code: string;
  files: AdditionalFile[];
  /** Optional GeoJSON written to /data/input.geojson (choropleth analyses). */
  geojsonContent?: string | null;
  /**
   * Host-materialized inputs the worker FETCHES into its FS before running (build
   * log D11, delivery option B): a remote source is materialized host-side through
   * the Rust egress core, then delivered here as a same-origin `/api/wasm-input/
   * <token>` URL (allowed by connect-src 'self'). The worker never sees the remote
   * URL — only the local `path` to write and the token URL to GET.
   */
  fetchInputs?: { path: string; url: string }[];
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
  __wasm_exec?: WasmExecuteRequest;
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
  "__wasm_exec",
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

/**
 * Return a spec copy with the transient `__wasm_exec` handoff removed (build log
 * D6). That request carries the run's code + CSV bytes purely to drive the webview
 * worker — it is a control message, never dashboard content. Stripping it before
 * persistence keeps it out of history (no code/CSV bloat) and stops a RESTORE from
 * firing a spurious worker boot + 404 POST for a run that is long over. Non-mutating
 * (the caller's live spec is untouched); a no-op when the key is absent.
 */
export function withoutHandoffState<T extends { state?: unknown }>(spec: T): T {
  const state = spec?.state;
  if (!state || typeof state !== "object" || !("__wasm_exec" in state)) return spec;
  const rest = { ...(state as Record<string, unknown>) };
  delete rest.__wasm_exec;
  return { ...spec, state: rest };
}
