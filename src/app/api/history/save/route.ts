import { NextResponse } from "next/server";
import { persistHistoryEntry } from "@/lib/history/persist";
import { logger } from "@/lib/logger";

export async function POST(request: Request) {
  try {
    const { csvId, spec, question } = await request.json();
    if (!csvId || !spec || !question) {
      return NextResponse.json(
        { error: "csvId, spec, and question are required" },
        { status: 400 }
      );
    }

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
