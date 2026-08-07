/**
 * Result shape of narrative grounding verification (pipeline/grounding.ts).
 * Lives in contracts because stream-state and investigation persistence carry
 * it across the API boundary — contracts must not import from pipeline
 * (exit audit F4).
 */
export interface GroundingReport {
  /** True when every data-like narrative number traced to a computed value. */
  ok: boolean;
  /** Count of data-like numbers we checked. */
  checkedCount: number;
  /** Raw tokens that could not be traced to any computed value. */
  ungrounded: string[];
  /**
   * Directional claims that CONTRADICT a computed trend verdict (narrative
   * says rising, *_trend_rising says false). Optional: absent on reports
   * persisted before 2026-08-06 and on runs without trend keys.
   */
  contradictions?: string[];
  /**
   * Declared findings the narrative never bound (declared-findings spec
   * §3.4) — the "computed August step, never mentioned" class. Optional:
   * absent pre-findings and when findings.mode is not "on".
   */
  unnarratedFindings?: string[];
  /**
   * §3.5: the question-primary finding exists but is bound in no headline
   * StatCard. Optional, same absence semantics as above.
   */
  questionPrimaryMiss?: string;
  /**
   * Findings coherence issues surfaced to the user (derivation
   * contradictions etc. — FindingIssue.detail strings). Optional.
   */
  findingIssues?: string[];
  /** 1-based step numbers the narrative explicitly referenced. */
  citedSteps: number[];
  /** Successful steps whose data was never referenced in the narrative. */
  uncitedSuccessfulSteps: number[];
}
