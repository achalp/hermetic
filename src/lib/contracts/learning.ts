/**
 * Learning-loop contracts (specs/learning-loops-2026-08-05.md, opportunities
 * #1–#3): the candidate ledger, graduated proposals, and the verified-exemplar
 * bank. Shared by lib/learning, the API routes, and the /learning page.
 */

/**
 * Where a lesson belongs. Routing is the loop's key discrimination
 * (assessment of run a47b45ba): some failures teach the MODEL (skill
 * guidance), some teach the PRODUCT (engine defects) — a loop that can't
 * tell them apart bloats prompts with workarounds for its own bugs.
 */
export type LessonKind =
  | "domain-guidance" // dataset/domain fact → complement-skill guidance line
  | "dialect-fact" // engine/library fact (function names, syntax) → guidance line
  | "engine-defect" // contract/shape failures → hermetic fix candidate, never a prompt
  | "dataset-convention"; // recurring clean interpretive CHECK (what held, not what broke)

export interface LessonEvidence {
  runId: string;
  ts: string;
  question?: string;
  /** First lines of the error that taught this lesson. */
  errorHead: string;
}

export type LedgerStatus = "candidate" | "proposed" | "accepted" | "rejected";

export interface LedgerEntry {
  id: string;
  /** Dedup key: hash of (kind, parentSkill, normalized error signature). */
  fingerprint: string;
  kind: LessonKind;
  /** The complement target — the active skill the failure is attributed to. */
  parentSkill?: string;
  /** Failure taxonomy class (lib/diagnostics/failure-log). */
  failureClass: string;
  /** The drafted lesson, phrased for skill guidance (one bullet). */
  lessonText: string;
  /**
   * The retry "fixed" the failure by REMOVING functionality rather than
   * repairing it (e.g. dropping percentile stats instead of renaming the
   * function). Retreat lessons never auto-graduate — learning capitulations
   * degrades the product; a human must see the discrepancy.
   */
  retreat: boolean;
  /** The engine's own suggestion when the error carried one ("Did you mean…"). */
  engineSuggestion?: string;
  evidence: LessonEvidence[];
  status: LedgerStatus;
  createdAt: string;
  updatedAt: string;
  /** Set when graduated. */
  proposalId?: string;
}

export interface LearnedProposal {
  id: string;
  ledgerId: string;
  /** Complement skill this lesson would land in (`<parent>-learned`). */
  parentSkill: string;
  skillName: string;
  /** The guidance bullet to append (or found the skill with). */
  guidanceLine: string;
  retreat: boolean;
  evidenceCount: number;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt?: string;
}

/** A verified success: executed, passed semantic validation, grounded. */
/**
 * Contract generation: bump when the codegen/runtime contracts change
 * materially (an exemplar banked under retired contracts re-seeds retired
 * behavior — e.g. pre-parallel-columns screen semantics). Gen 2 =
 * declared-checks + parallel screened columns era (2026-08-07).
 */
export const CONTRACT_GENERATION = 2;

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

/** GET /api/learning response shape. */
export interface LearningState {
  ledger: LedgerEntry[];
  proposals: LearnedProposal[];
  exemplarCount: number;
  /** Engine-defect entries surfaced separately (never become proposals). */
  engineDefects: LedgerEntry[];
}
