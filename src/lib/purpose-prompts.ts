/**
 * Output style definitions and LLM prompt blocks.
 *
 * A style governs the *form* of the answer — its reading mode / container,
 * narrative density, framing, tone, and depth of exploration — NOT its
 * content. How many visuals, which types, and how much to show remain the
 * model's call, driven by the question and the shape of the answer. Each
 * prompt below shapes the frame and explicitly leaves the count/type to the
 * model.
 *
 * Tightened taxonomy (4 consumption contexts):
 *   dashboard  — scan frame (grid of metrics + charts)
 *   brief      — one-screen bottom-line-up-front
 *   report     — formal sectioned document
 *   deep-dive  — exhaustive multi-angle exploration
 *
 * "Slides" is no longer a compose style — it's an export format (PPTX / a
 * Reveal.js deck). "Narrative" and "Infographic" folded into report and
 * dashboard respectively. Legacy ids still resolve via LEGACY_ALIASES so
 * saved defaults / vizs don't break.
 */

export interface PurposeMode {
  id: string;
  label: string;
  /** One-line description, shown on hover in the style selector. */
  description: string;
  /** Prompt block injected into the composer system prompt to shape the frame. */
  prompt: string;
  /**
   * Prompt block injected into the CODE-GEN system prompt so each analysis step
   * produces output matching the mode — rather than always generating an
   * exhaustive battery the composer then discards. Scales compute to intent.
   */
  codegenScope: string;
}

export const PURPOSE_MODES: Record<string, PurposeMode> = {
  dashboard: {
    id: "dashboard",
    label: "Dashboard",
    description: "At-a-glance grid of metrics and charts — for scanning.",
    prompt:
      "Compose for at-a-glance scanning, like a monitoring dashboard. Use a GRID-ORIENTED layout: lead with a LayoutGrid of the headline metrics as StatCards, then arrange visualizations in a LayoutGrid / LayoutRow so several read side by side rather than stacked in one tall column. Keep text minimal — short labels and at most one-line annotations, no paragraphs. The reader scans many things quickly, so prioritize visual density and parallel layout over narration. Let the question and the data decide WHICH metrics and charts appear and HOW MANY — never pad to fill the grid or force a fixed count.",
    codegenScope:
      "Output scope: produce a FOCUSED set for a scannable dashboard — the handful of headline metrics (results) and the 2-4 chart_data structures that best answer THIS question. Do not build an exhaustive battery of charts/breakdowns that won't be shown; compute what a focused dashboard needs.",
  },
  brief: {
    id: "brief",
    label: "Brief",
    description: "Bottom-line-up-front on one screen — for a 30-second read.",
    prompt:
      "Compose a bottom-line-up-front brief that fits roughly one screen. Lead with a single TextBlock (variant: insight) stating the direct answer in one or two sentences. Follow with only the few elements that most support that answer — the most decision-relevant metrics and the single clearest visualization. Keep it terse and scannable and end with at most one short caveat or next step. The reader has about 30 seconds. Choose the minimum that genuinely answers the question — let the data decide whether that is one chart or a couple of stat cards; do not exhaustively explore.",
    codegenScope:
      "Output scope: this feeds a one-screen brief — compute the MINIMUM that answers the question: the 1-2 most decision-relevant numbers (results) and AT MOST ONE clear chart_data. Do NOT explore multiple angles or build a battery of charts; anything extra is wasted.",
  },
  report: {
    id: "report",
    label: "Report",
    description: "Formal sectioned document with prose and tables — to share.",
    prompt:
      "Compose a formal, linear document meant to be read top to bottom and shared. Structure it into titled sections separated by SectionBreak (variant: line); use TextBlock (variant: heading) for section titles and TextBlock (variant: body) for complete, professional prose paragraphs that narrate the analysis. Introduce each visualization in prose before it and interpret it after, with a caption beneath. Prefer a DataTable where precise figures matter. Open with a brief overview section and close with a summary / recommendation. Tone: formal, suitable for emailing leadership or a DOCX export. The number and type of visuals are yours to choose from the data — the constraint is the document FORM, not a chart count.",
    codegenScope:
      "Output scope: this feeds a written report — compute the key figures (results) and the few chart_data / table structures the narrative needs to make its case (typically 2-4). Enough to support the prose, not an exhaustive battery.",
  },
  "deep-dive": {
    id: "deep-dive",
    label: "Deep dive",
    description: "Exhaustive multi-angle exploration with caveats — to investigate.",
    prompt:
      "Compose an exhaustive, multi-angle analysis for someone who wants to understand the question fully. Examine it from every useful angle the data supports — trends, distributions, comparisons, breakdowns, correlations — and interleave a short TextBlock (variant: insight) after each that states the finding. Surface unexpected patterns or outliers the user did not ask about but should know, and include an Annotation (severity: info) noting methodology, data-quality, or sample-size caveats. Use SectionBreak components between major angles and include a DataTable slice where row-level detail helps. End with findings plus open questions. Drive breadth by what the data genuinely supports — go as wide as is warranted, not to a fixed number.",
    codegenScope:
      "Output scope: this feeds an exhaustive deep-dive — explore the question from every useful angle the data supports (trends, distributions, comparisons, breakdowns, correlations), computing the multiple charts and result metrics that breadth needs. Go as wide as the data genuinely warrants.",
  },
};

/** Ordered list for the UI (selector renders in this order). */
export const PURPOSE_LIST: PurposeMode[] = [
  PURPOSE_MODES.dashboard,
  PURPOSE_MODES.brief,
  PURPOSE_MODES.report,
  PURPOSE_MODES["deep-dive"],
];

export const DEFAULT_PURPOSE = "dashboard";

/** Old ids → current ids, so persisted defaults and saved vizs keep working. */
const LEGACY_ALIASES: Record<string, string> = {
  infographic: "dashboard",
  "executive-summary": "brief",
  narrative: "report",
  "deep-analysis": "deep-dive",
  presentation: "dashboard", // "Slides" is now an export, not a style
};

/** Resolve any (possibly legacy) id to a current canonical purpose id. */
export function resolvePurpose(purposeId: string | null | undefined): string {
  if (purposeId && PURPOSE_MODES[purposeId]) return purposeId;
  if (purposeId && LEGACY_ALIASES[purposeId]) return LEGACY_ALIASES[purposeId];
  return DEFAULT_PURPOSE;
}

export function getPurposePrompt(purposeId: string): string {
  return PURPOSE_MODES[resolvePurpose(purposeId)].prompt;
}

/** Code-gen output-scope block for a mode (scales analysis volume to intent). */
export function getPurposeCodegenScope(purposeId: string): string {
  return PURPOSE_MODES[resolvePurpose(purposeId)].codegenScope;
}
