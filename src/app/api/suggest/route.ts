import { generateText } from "ai";
import { getModel } from "@/lib/llm/client";
import { UI_COMPOSE_MODEL } from "@/lib/constants";

/**
 * Question-suggestion endpoint. Two modes:
 *
 * - `mode: "schema"` (default): pre-analysis. Generates 5 starter questions
 *   from the data schema before any analysis has run. This is the original
 *   behavior — surfaces on the home/ask screens.
 *
 * - `mode: "follow-up"`: post-analysis. Generates 3 NEW questions that take
 *   the most recent analysis result as a premise — "now that we've seen X,
 *   what should we ask next?" Uses Haiku for speed and cost.
 */

type Mode = "schema" | "follow-up";

interface FollowUpPayload {
  mode: "follow-up";
  schema?: unknown;
  warehouseSchema?: unknown;
  question: string;
  resultsSummary?: Record<string, unknown>;
  specSummary?: string[];
}

interface SchemaPayload {
  mode?: "schema";
  schema?: unknown;
  warehouseSchema?: unknown;
}

function buildSchemaDesc(body: SchemaPayload | FollowUpPayload): string {
  if (body.schema) {
    const schema = body.schema as {
      row_count: number;
      columns: {
        name: string;
        dtype: string;
        meta?: {
          type?: string;
          distinct_count?: number;
          top_values?: { value: string }[];
          min?: number;
          max?: number;
          min_date?: string;
          max_date?: string;
        };
      }[];
      detected_domain?: string;
      correlations?: { col_a: string; col_b: string; pearson: number }[];
    };
    const cols = schema.columns;
    const colSummaries = cols.slice(0, 30).map((c) => {
      let desc = `${c.name} (${c.dtype})`;
      if (c.meta?.type === "categorical" && c.meta.top_values) {
        desc += ` — values: ${c.meta.top_values
          .slice(0, 5)
          .map((v) => v.value)
          .join(", ")}`;
      }
      if (c.meta?.type === "numeric" && c.meta.min !== undefined) {
        desc += ` — range: ${c.meta.min} to ${c.meta.max}`;
      }
      if (c.meta?.type === "date" && c.meta.min_date) {
        desc += ` — range: ${c.meta.min_date} to ${c.meta.max_date}`;
      }
      return desc;
    });
    let desc = `CSV file with ${schema.row_count} rows and ${cols.length} columns:\n${colSummaries.join("\n")}`;
    if (schema.detected_domain) desc += `\nDetected domain: ${schema.detected_domain}`;
    if (schema.correlations?.length) {
      const topCorr = schema.correlations
        .slice(0, 3)
        .map((c) => `${c.col_a} ↔ ${c.col_b} (r=${c.pearson.toFixed(2)})`);
      desc += `\nNotable correlations: ${topCorr.join(", ")}`;
    }
    return desc;
  }

  const tables = body.warehouseSchema as {
    name: string;
    columns: { name: string; type: string }[];
    row_count_estimate: number;
  }[];
  const tableSummaries = tables.slice(0, 10).map((t) => {
    const cols = t.columns
      .slice(0, 10)
      .map((c) => `${c.name} (${c.type})`)
      .join(", ");
    return `${t.name} (${t.row_count_estimate.toLocaleString()} rows): ${cols}`;
  });
  return `Warehouse with ${tables.length} tables:\n${tableSummaries.join("\n")}`;
}

const SCHEMA_SYSTEM_PROMPT = `You generate insightful data analysis questions for non-technical users.
The user has uploaded a dataset and needs help knowing what to ask.
Generate exactly 5 questions that would reveal the most valuable insights from this specific data.

Rules:
- Questions should be specific to the actual column names and data types present
- Write in plain English — no SQL, no technical jargon
- Focus on actionable business insights, not surface-level summaries
- Include a mix: trends over time, comparisons between groups, anomaly detection, relationships between variables
- Each question should be 1 sentence, under 15 words when possible
- Do NOT ask generic questions like "summarize the data" or "show me everything"
- Output ONLY the 5 questions, one per line, no numbering, no bullets`;

const FOLLOW_UP_SYSTEM_PROMPT = `You generate follow-up data-analysis questions that go DEEPER than the question just answered.
Treat the prior result as a premise — your job is to ask what the user should explore NEXT.

Rules:
- Output exactly 3 follow-up questions, one per line, no numbering, no bullets
- Each question must be NEW — do NOT rephrase the original question
- Take the prior result as established fact and probe causes, segments, time-shifts, comparisons, or anomalies
- Reference specific columns and values from the schema when natural
- Each question is 1 sentence, under 18 words
- Plain English — no SQL, no jargon
- Do NOT ask "summarize" or "show everything" — be specific and investigative

Examples (illustrative — do not reuse verbatim):
Original: "What were total sales by region in 2024?"
Good follow-ups:
  Which product categories drove the strongest growth in the top region?
  Did any regions decline year-over-year, and when did the drop start?
  How did sales distribute across customer segments within each region?

Original: "What's the relationship between price and rating?"
Good follow-ups:
  Where does the price/rating correlation break down most?
  Are there outlier products that achieve high ratings at low prices?
  How has the price/rating relationship shifted over time?`;

function buildFollowUpUserPrompt(payload: FollowUpPayload, schemaDesc: string): string {
  const parts: string[] = [];
  parts.push(`PRIOR QUESTION:\n${payload.question}`);

  if (payload.resultsSummary && Object.keys(payload.resultsSummary).length > 0) {
    // Cap the summary at ~2KB to avoid prompt bloat
    const summaryStr = JSON.stringify(payload.resultsSummary, null, 2).slice(0, 2000);
    parts.push(`PRIOR RESULT (key metrics from the analysis):\n${summaryStr}`);
  }

  if (payload.specSummary && payload.specSummary.length > 0) {
    parts.push(`RENDERED COMPONENTS (what the user just saw):\n${payload.specSummary.join(", ")}`);
  }

  parts.push(`DATA SCHEMA (for grounding follow-ups in real columns):\n${schemaDesc}`);

  return parts.join("\n\n");
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SchemaPayload | FollowUpPayload;
    const mode: Mode = body.mode === "follow-up" ? "follow-up" : "schema";

    if (!body.schema && !body.warehouseSchema) {
      return Response.json({ error: "schema or warehouseSchema required" }, { status: 400 });
    }

    const schemaDesc = buildSchemaDesc(body);

    if (mode === "follow-up") {
      const followUp = body as FollowUpPayload;
      if (!followUp.question) {
        return Response.json({ error: "question required for follow-up mode" }, { status: 400 });
      }

      // Use Haiku for follow-ups — cheap + fast, this is a side-channel call
      const model = getModel("claude-haiku-4-5-20251001");
      const result = await generateText({
        model,
        system: FOLLOW_UP_SYSTEM_PROMPT,
        prompt: buildFollowUpUserPrompt(followUp, schemaDesc),
        temperature: 0.5,
      });

      const original = followUp.question.trim().toLowerCase();
      const questions = result.text
        .split("\n")
        .map((q) => q.trim())
        // Strip leading list markers ("1.", "1)", "-", "*", "•") so the LLM's
        // numbered output still passes the question-shape check below
        .map((q) => q.replace(/^(?:\d+[.)]|[-*•])\s+/, "").trim())
        // Real questions are a single sentence under ~140 chars and end in "?"
        // (or otherwise look interrogative). This naturally drops preamble like
        // "Here are three follow-up questions:" while keeping all valid items.
        .filter((q) => q.length > 10 && q.length < 200)
        .filter(
          (q) =>
            q.endsWith("?") ||
            /^(why|how|what|which|when|where|who|did|does|is|are|can|could|should|would|will)\b/i.test(
              q
            )
        )
        // Drop near-duplicates of the original question
        .filter((q) => q.toLowerCase() !== original)
        .slice(0, 3);

      return Response.json({ questions });
    }

    // Schema mode (original behavior)
    const model = getModel(UI_COMPOSE_MODEL);
    const result = await generateText({
      model,
      system: SCHEMA_SYSTEM_PROMPT,
      prompt: schemaDesc,
      temperature: 0.7,
    });

    const questions = result.text
      .split("\n")
      .map((q) => q.trim())
      .filter((q) => q.length > 10 && q.length < 120)
      .slice(0, 5);

    return Response.json({ questions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate suggestions";
    return Response.json({ error: msg }, { status: 500 });
  }
}
