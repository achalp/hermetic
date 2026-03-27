import { generateText } from "ai";
import { getModel } from "@/lib/llm/client";
import { UI_COMPOSE_MODEL } from "@/lib/constants";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { schema, warehouseSchema } = body;

    if (!schema && !warehouseSchema) {
      return Response.json({ error: "schema or warehouseSchema required" }, { status: 400 });
    }

    // Build a concise schema description for the LLM
    let schemaDesc: string;

    if (schema) {
      const cols = schema.columns as {
        name: string;
        dtype: string;
        meta?: {
          type: string;
          distinct_count?: number;
          top_values?: { value: string }[];
          min?: number;
          max?: number;
          min_date?: string;
          max_date?: string;
        };
      }[];
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
      schemaDesc = `CSV file with ${schema.row_count} rows and ${cols.length} columns:\n${colSummaries.join("\n")}`;
      if (schema.detected_domain) {
        schemaDesc += `\nDetected domain: ${schema.detected_domain}`;
      }
      if (schema.correlations?.length) {
        const topCorr = schema.correlations
          .slice(0, 3)
          .map(
            (c: { col_a: string; col_b: string; pearson: number }) =>
              `${c.col_a} ↔ ${c.col_b} (r=${c.pearson.toFixed(2)})`
          );
        schemaDesc += `\nNotable correlations: ${topCorr.join(", ")}`;
      }
    } else {
      const tables = warehouseSchema as {
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
      schemaDesc = `Warehouse with ${tables.length} tables:\n${tableSummaries.join("\n")}`;
    }

    const model = getModel(UI_COMPOSE_MODEL);

    const result = await generateText({
      model,
      system: `You generate insightful data analysis questions for non-technical users.
The user has uploaded a dataset and needs help knowing what to ask.
Generate exactly 5 questions that would reveal the most valuable insights from this specific data.

Rules:
- Questions should be specific to the actual column names and data types present
- Write in plain English — no SQL, no technical jargon
- Focus on actionable business insights, not surface-level summaries
- Include a mix: trends over time, comparisons between groups, anomaly detection, relationships between variables
- Each question should be 1 sentence, under 15 words when possible
- Do NOT ask generic questions like "summarize the data" or "show me everything"
- Output ONLY the 5 questions, one per line, no numbering, no bullets`,
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
