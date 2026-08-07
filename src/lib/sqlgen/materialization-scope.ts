/**
 * Picks the PRIMARY fact table + its main time column for a question, so the
 * materialization can bound its scan to a metadata-sized recent window
 * (connector.getScanSafeWindow) instead of the LLM guessing a window and failing
 * with "rows to read exceeded". Cheap (Haiku) and strictly best-effort: returns
 * null when no single time-partitioned table cleanly fits, in which case the
 * caller proceeds with the normal LLM-chosen window.
 */
import { generateText } from "ai";
import { withPhase } from "@/lib/cost/accumulator";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { getActiveModels } from "@/lib/runtime-config";
import type { WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";

export interface MaterializationScope {
  /** Bare table name (as the connector's metadata expects). */
  table: string;
  /** The time column to bound. */
  dateColumn: string;
}

const SYSTEM_PROMPT = `You pick the PRIMARY fact table and its main time/date column for a data question, so the system can bound the scan to a recent window. Choose the single table that most directly answers the question and that has a time column to filter on. Output ONLY JSON: {"table":"<name>","dateColumn":"<col>"} — or {"table":null} if no single table with a time column fits (e.g. the question needs a join). No prose, no markdown.`;

export async function pickMaterializationScope(
  question: string,
  tables: WarehouseTableSchema[],
  model: string = getActiveModels().codeGen
): Promise<MaterializationScope | null> {
  const catalog = tables
    .map((t) => {
      const timeCols = t.columns
        .filter((c) => /date|time|timestamp/i.test(c.type))
        .map((c) => c.name);
      return `- ${t.schema}.${t.name} — time columns: ${timeCols.join(", ") || "(none)"}`;
    })
    .join("\n");

  try {
    const result = await withPhase("assess", () =>
      generateText({
        model: getModel(model),
        system: cachedSystem(SYSTEM_PROMPT),
        prompt: `## Tables\n${catalog}\n\n## Question\n${question}\n\nWhich single table + time column? JSON only.`,
        temperature: 0,
        maxOutputTokens: 200,
      })
    );
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { table?: unknown; dateColumn?: unknown };
    if (typeof parsed.table !== "string" || typeof parsed.dateColumn !== "string") return null;

    // Validate against the real schema (don't trust a hallucinated table/column).
    const t = tables.find(
      (x) => `${x.schema}.${x.name}` === parsed.table || x.name === parsed.table
    );
    if (!t || !t.columns.some((c) => c.name === parsed.dateColumn)) return null;
    return { table: t.name, dateColumn: parsed.dateColumn };
  } catch {
    return null;
  }
}
