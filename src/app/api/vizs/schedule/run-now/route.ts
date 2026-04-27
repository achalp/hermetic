/**
 * Trigger an immediate run of a scheduled visualization. Useful for:
 *  - Testing the schedule end-to-end
 *  - Manual "refresh now" button in the Settings UI
 *
 * The vizId must already have a schedule registered.
 */

import { getSchedule } from "@/lib/saved/schedule-storage";
import { runScheduleNow } from "@/lib/saved/scheduler";
import { logger } from "@/lib/logger";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { vizId?: string };
    if (!body.vizId) return Response.json({ error: "vizId required" }, { status: 400 });

    const entry = await getSchedule(body.vizId);
    if (!entry) {
      return Response.json({ error: "no schedule registered for this vizId" }, { status: 404 });
    }

    const result = await runScheduleNow(entry);
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Run-now failed";
    logger.error("run-now failed", { error: msg });
    return Response.json({ error: msg }, { status: 500 });
  }
}
