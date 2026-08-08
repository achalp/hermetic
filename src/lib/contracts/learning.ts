/**
 * Learning contracts — EXEMPLARS ONLY (learning retirement, 2026-08-07).
 *
 * The lesson pipeline (extraction, ledger, proposals) is retired: zero
 * lifetime throughput, trivia-yield input channel, miscalibrated retreat
 * gate. What remains is the one memory that paid rent — runs that worked,
 * banked as working artifacts and reused as starting points — now a
 * user-visible, user-curated surface instead of a shadow mechanism.
 */

/**
 * Contract generation: bump when the codegen/runtime contracts change
 * materially (an exemplar banked under retired contracts re-seeds retired
 * behavior). Gen 2 = declared-checks + parallel screened columns era.
 * Gen 3 = analysis product (declare_series roles / declare_value context;
 * chart_data authoring retired for tidy series) — gen-2 exemplars hand-build
 * the views the runtime now synthesizes.
 */
export const CONTRACT_GENERATION = 3;

export interface Exemplar {
  id: string;
  runId: string;
  question: string;
  /** Structure-only (privacy floor): column names+dtypes hash, domain, skills. */
  schemaFingerprint: string;
  detectedDomain: string | null;
  columnNames: string[];
  activeSkills: string[];
  /** The final successful code — hermetic-generated, no data values. */
  code: string;
  /** Attempts before success (1 = first try) — retrieval prefers hard-won. */
  attempts: number;
  /** CONTRACT_GENERATION at bank time; stale generations are not retrieved. */
  contractGen?: number;
  rowCount: number;
  createdAt: string;
}
