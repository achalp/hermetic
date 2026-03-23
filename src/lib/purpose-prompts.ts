/**
 * Output purpose definitions and LLM prompt blocks.
 *
 * Each purpose mode changes how the LLM composes the dashboard spec
 * from the same underlying data — different text density, chart
 * selection, layout structure, and narrative tone.
 */

export interface PurposeMode {
  id: string;
  label: string;
  description: string;
  /** Prompt block injected into the LLM system prompt to guide layout composition */
  prompt: string;
}

export const PURPOSE_MODES: Record<string, PurposeMode> = {
  infographic: {
    id: "infographic",
    label: "Infographic",
    description: "Visual-first dashboard with charts, stat cards, and minimal text",
    prompt:
      "Design the layout like a data infographic that flows top-to-bottom as a narrative. Lead with whatever is most impactful for the question — a chart, stat cards, or a key insight. TextBlock headings are optional, not required. Vary the opening by question type: comparisons can lead with a chart, trend questions with a line chart, summaries with stat cards. Interleave TextBlock (variant: insight) annotations between visualizations to narrate the story, rather than clustering all text at the end.",
  },
  narrative: {
    id: "narrative",
    label: "Narrative Analysis",
    description: "Written analysis with charts as supporting evidence",
    prompt:
      "Structure the output as a written data analysis. Lead with a TextBlock (variant: heading) stating the key finding as a clear sentence. The primary content should be TextBlock (variant: body) paragraphs that narrate the analysis — describe what was examined, what patterns emerged, and what it means. Embed charts and stat cards BETWEEN paragraphs as supporting evidence, not as the focus. Every chart must be preceded by a TextBlock explaining what to look for in it, and followed by a TextBlock interpreting the result. Use 2-4 charts maximum. Minimize stat cards — weave specific numbers into the prose instead. End with a TextBlock containing implications or recommendations. The tone should be analytical and journalistic, like a data brief.",
  },
  "executive-summary": {
    id: "executive-summary",
    label: "Executive Summary",
    description: "Concise bottom-line-up-front with key metrics only",
    prompt:
      "Structure the output as an executive summary. Lead with a TextBlock (variant: insight) containing a single-sentence bottom-line answer to the question. Follow with a LayoutGrid of 2-4 StatCards showing only the most critical metrics. Include at most ONE chart — the single most important visualization. End with a brief TextBlock (variant: body) of 1-2 sentences noting any critical caveats or next steps. Total component count should be under 8. No section headings, no detailed exploration. Every element must earn its place — if it does not directly answer the question, omit it.",
  },
  "deep-analysis": {
    id: "deep-analysis",
    label: "Deep Analysis",
    description: "Comprehensive multi-angle exploration with methodology and caveats",
    prompt:
      "Structure the output as a thorough analytical report. Start with a TextBlock (variant: heading) framing the question. Use multiple chart types (4-6) to examine the question from different angles — trends over time, distributions, comparisons, and breakdowns. Include a DataTable showing a relevant slice of the underlying data. Add TextBlock (variant: insight) annotations after each visualization explaining the finding. Include an Annotation (severity: info) noting methodology, data quality caveats, or sample size considerations. Surface unexpected patterns or outliers the user did not explicitly ask about but should know. End with a TextBlock summarizing all findings and open questions. Use SectionBreak components between major analytical sections.",
  },
  presentation: {
    id: "presentation",
    label: "Presentation",
    description: "Slide-like sections with one key point per section",
    prompt:
      "Structure the output as a presentation with distinct slide-like sections. Each section should contain one TextBlock (variant: heading) as the slide title, one key visualization or stat card group, and one TextBlock (variant: insight) as the takeaway. Separate sections with SectionBreak components. Use simple, bold chart types that read well at a glance — bar charts, pie charts, and stat cards over complex multi-series or small-multiple charts. Limit to 3-5 sections total. Headings should be short declarative statements (assertions, not questions). Keep text concise — bullet-point style, not paragraphs. Optimize for screen-sharing and PPTX export.",
  },
  report: {
    id: "report",
    label: "Report",
    description: "Formal document with structured sections and tables",
    prompt:
      'Structure the output as a formal written report. Use TextBlock (variant: heading) for numbered section titles (e.g., "1. Overview", "2. Key Findings"). Each section should contain TextBlock (variant: body) paragraphs written in complete, professional sentences. Prefer DataTable over charts where the data has few rows — tables are more precise for reports. When charts are used, include a TextBlock caption below explaining the visualization. Include 2-3 charts for visual support. Use SectionBreak (variant: line) between major sections. End with a summary section. The tone should be formal and suitable for attachment to an email to leadership or inclusion in a DOCX export.',
  },
};

export const DEFAULT_PURPOSE = "infographic";

export function getPurposePrompt(purposeId: string): string {
  return PURPOSE_MODES[purposeId]?.prompt ?? PURPOSE_MODES[DEFAULT_PURPOSE].prompt;
}
