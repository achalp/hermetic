/**
 * Client for /api/update — the Settings update controls' channel to the
 * desktop shell (see the route + src-tauri watcher). Its own module, not
 * api.ts: that file sits at the oversized-module ratchet's ceiling, and the
 * update surface is a self-contained feature.
 */
import { ApiError } from "./api";

export interface UpdateStatus {
  version: string;
  /** True only in the desktop app — the shell is watching for commands. */
  desktop: boolean;
  phase: "idle" | "checking" | "downloading" | "none" | "installed" | "error" | string;
  detail: string | null;
  update_pending: string | null;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string }).error ?? `Request failed (${res.status})`,
      res.status
    );
  }
  return data as T;
}

export async function getUpdateStatus(signal?: AbortSignal): Promise<UpdateStatus> {
  const res = await fetch("/api/update", { signal });
  return json<UpdateStatus>(res);
}

export async function postUpdateAction(action: "check" | "restart"): Promise<void> {
  const res = await fetch("/api/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  await json<{ ok: boolean }>(res);
}
