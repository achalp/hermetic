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
  /** 1-based step numbers the narrative explicitly referenced. */
  citedSteps: number[];
  /** Successful steps whose data was never referenced in the narrative. */
  uncitedSuccessfulSteps: number[];
}
