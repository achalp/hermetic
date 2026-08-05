/**
 * Schedule CRUD for saved visualizations.
 *
 *   GET    /api/vizs/schedule              → list all schedules
 *   POST   /api/vizs/schedule              → create or replace a schedule
 *   DELETE /api/vizs/schedule              → remove a schedule
 *   POST   /api/vizs/schedule/run-now      → run a schedule once, immediately
 */

import {
  setSchedule,
  deleteSchedule,
  listSchedules,
  type ScheduleCadence,
} from "@/lib/saved/schedule-storage";
import { ensureSchedulerStarted } from "@/lib/saved/scheduler";
import { apiError } from "@/app/lib/api-error";

const VALID_CADENCES: ScheduleCadence[] = [
  "hourly",
  "daily-9am",
  "daily-eod",
  "weekly-monday",
  "on-file-change",
];

const VALID_EXPORTS = ["xlsx", "csv"] as const;

export async function GET() {
  // Spin up the scheduler the first time anyone reads schedules so that
  // background runs are active even if the user never POSTs after restart.
  await ensureSchedulerStarted();
  const schedules = await listSchedules();
  return Response.json({ schedules });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      vizId?: string;
      cadence?: string;
      autoExport?: string[];
    };

    if (!body.vizId) return Response.json({ error: "vizId required" }, { status: 400 });
    if (!body.cadence || !VALID_CADENCES.includes(body.cadence as ScheduleCadence)) {
      return Response.json(
        { error: `cadence must be one of: ${VALID_CADENCES.join(", ")}` },
        { status: 400 }
      );
    }
    const autoExport = (body.autoExport ?? []).filter((f): f is "xlsx" | "csv" =>
      (VALID_EXPORTS as readonly string[]).includes(f)
    );

    const entry = await setSchedule({
      vizId: body.vizId,
      cadence: body.cadence as ScheduleCadence,
      autoExport,
    });

    await ensureSchedulerStarted();
    return Response.json({ ok: true, schedule: entry });
  } catch (err) {
    return apiError("/api/vizs/schedule", err, "Failed to set schedule");
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { vizId?: string };
    if (!body.vizId) return Response.json({ error: "vizId required" }, { status: 400 });
    const removed = await deleteSchedule(body.vizId);
    return Response.json({ ok: true, removed });
  } catch (err) {
    return apiError("/api/vizs/schedule", err, "Failed to delete schedule");
  }
}
