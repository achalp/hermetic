import { NextResponse } from "next/server";
import { persistHistoryEntry } from "@/lib/history/persist";
import { logger } from "@/lib/logger";
import { readJsonBody, parseBody, HistorySaveSchema } from "@/lib/api-schemas";

export async function POST(request: Request) {
  try {
    const read = await readJsonBody(request);
    if (!read.ok) return read.response;
    const parsed = parseBody(HistorySaveSchema, read.body);
    if (!parsed.ok) return parsed.response;
    const { csvId, spec, question } = parsed.data;

    const result = await persistHistoryEntry(csvId, spec, question);
    if (!result.saved) return NextResponse.json({ skipped: true, reason: result.reason });
    return NextResponse.json({ meta: result.meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "History save failed";
    logger.error("History auto-save error", { error: message });
    // Don't fail the client — auto-save is best-effort.
    return NextResponse.json({ skipped: true, error: message });
  }
}
