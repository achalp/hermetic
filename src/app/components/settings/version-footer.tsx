"use client";

/**
 * The Settings drawer footer: the RUNNING app's version plus, on the desktop,
 * explicit update controls — "Check for updates" and "Restart now" — so the
 * updater's silent launch-twice dance is no longer the only path. State flows
 * page → /api/update → command file → shell watcher → state file → here
 * (the §7 empty-IPC posture: the shell exposes no webview-reachable command).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getUpdateStatus, postUpdateAction, type UpdateStatus } from "@/app/lib/update-api";

const POLL_MS = 1200;
const CHECK_TIMEOUT_MS = 3 * 60 * 1000; // download of a full bundle can be slow

export function VersionFooter() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollUntil = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const s = await getUpdateStatus(signal);
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // While a check is running, poll the shell's progress until it settles.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(async () => {
      const s = await refresh();
      const settled = s && ["none", "installed", "error", "idle"].includes(s.phase);
      if ((settled && s.phase !== "idle") || Date.now() > pollUntil.current) {
        setBusy(false);
        if (Date.now() > pollUntil.current) setError("update check timed out");
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const check = useCallback(async () => {
    setError(null);
    try {
      await postUpdateAction("check");
      pollUntil.current = Date.now() + CHECK_TIMEOUT_MS;
      setBusy(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start the update check");
    }
  }, []);

  const restart = useCallback(async () => {
    setError(null);
    try {
      await postUpdateAction("restart");
      // The app is about to relaunch — nothing more to render.
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not restart");
    }
  }, []);

  const pendingRestart =
    status?.phase === "installed" ||
    (status?.update_pending && status.update_pending !== status.version);
  const pendingVersion =
    status?.phase === "installed" ? status.detail : (status?.update_pending ?? null);

  return (
    <div
      style={{
        padding: 20,
        fontSize: 12,
        color: "var(--color-surface-dark-text4)",
        lineHeight: 1.7,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>hermetic {status?.version ? `v${status.version}` : ""}</span>
        {status?.desktop && !pendingRestart && (
          <button
            onClick={check}
            disabled={busy}
            data-testid="check-updates"
            style={{
              fontSize: 11,
              padding: "2px 8px",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy
              ? status?.phase === "downloading"
                ? "Downloading…"
                : "Checking…"
              : "Check for updates"}
          </button>
        )}
      </div>
      {status?.desktop && !busy && status.phase === "none" && !pendingRestart && (
        <div data-testid="up-to-date" style={{ marginTop: 4 }}>
          You&apos;re on the latest version.
        </div>
      )}
      {pendingRestart && (
        <div
          data-testid="update-pending"
          style={{
            color: "var(--color-amber-warn, #b45309)",
            marginTop: 4,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>Update {pendingVersion ? `v${pendingVersion} ` : ""}installed.</span>
          {status?.desktop && (
            <button
              onClick={restart}
              data-testid="restart-now"
              style={{ fontSize: 11, padding: "2px 8px", cursor: "pointer" }}
            >
              Restart now
            </button>
          )}
        </div>
      )}
      {(error || status?.phase === "error") && (
        <div
          data-testid="update-error"
          style={{ color: "var(--color-error, #b91c1c)", marginTop: 4 }}
        >
          {error ?? status?.detail ?? "update check failed"}
        </div>
      )}
      <br />
      Data stays sealed. Always.
    </div>
  );
}
