/**
 * Server-side history persistence for a client that disconnected mid-analysis.
 *
 * When the client is still connected it saves history itself after rendering
 * (via /api/history/save) — so this only acts when the stream is closed. The
 * final spec is assembled from the accumulated emitted patch lines, exactly
 * as the client would have assembled it. The analysis already ran; this stops
 * it being wasted.
 *
 * Shared by BOTH query routes (wired as the patch-stream `onSettled` hook).
 * It previously existed only in Ask, so a dropped Investigate run — longer,
 * and therefore more likely to hit a disconnect — lost its entire result.
 */
import { assembleSpecFromPatches } from "@/lib/pipeline/assemble-spec";
import { parsePatchLines } from "@/lib/pipeline/patch-lines";
import { persistHistoryEntry } from "@/lib/history/persist";
import type { PatchStream } from "@/lib/pipeline/patch-stream";
import { logger } from "@/lib/logger";

export async function persistHistoryOnDisconnect(
  stream: PatchStream,
  csvId: string | undefined,
  question: string
): Promise<void> {
  // Connected client saves after render; guarding on isClosed avoids a
  // double save.
  if (!stream.isClosed() || !csvId) return;
  try {
    const spec = assembleSpecFromPatches(parsePatchLines(stream.emittedLines));
    if (spec) {
      await persistHistoryEntry(csvId, spec as unknown as Record<string, unknown>, question);
      logger.info("History saved server-side after client disconnect", { csvId });
    }
  } catch (persistErr) {
    logger.warn("Server-side history save failed", {
      error: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
  }
}
