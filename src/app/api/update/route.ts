import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { hermeticPaths } from "@/lib/paths";
import { version } from "../../../../package.json";

/**
 * The Settings update controls' channel to the DESKTOP SHELL (§7-safe: the
 * shell exposes zero webview-reachable commands, so the page talks to this
 * trusted sidecar route, the route writes a command FILE into the data dir,
 * and the shell's watcher consumes it).
 *
 *   GET  → running version + the shell's live check state + restart-pending
 *   POST → {action: "check" | "restart"} written to update-command.json
 *
 * Off the desktop (no shell watching), POST refuses: a command nobody reads
 * would leave the UI spinning forever.
 */

interface UpdateState {
  phase?: string;
  detail?: string | null;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const isDesktop = () => process.env.HERMETIC_DESKTOP === "1";

export async function GET(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  const state = readJson<UpdateState>(hermeticPaths.updateStateFile());
  const pending = readJson<{ version?: string }>(hermeticPaths.updatePendingFile());
  return NextResponse.json({
    version,
    desktop: isDesktop(),
    phase: state?.phase ?? "idle",
    detail: state?.detail ?? null,
    update_pending: typeof pending?.version === "string" ? pending.version : null,
  });
}

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  if (!isDesktop()) {
    return NextResponse.json(
      { error: "update commands need the desktop app (no shell is listening here)" },
      { status: 400 }
    );
  }
  let action: unknown;
  try {
    action = ((await request.json()) as { action?: unknown }).action;
  } catch {
    action = undefined;
  }
  if (action !== "check" && action !== "restart") {
    return NextResponse.json({ error: "action must be 'check' or 'restart'" }, { status: 400 });
  }
  const file = hermeticPaths.updateCommandFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ action, ts: Date.now() }));
  return NextResponse.json({ ok: true });
}
