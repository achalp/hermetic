"use client";

/**
 * The Settings drawer footer: the RUNNING app's version, live from
 * /api/health — replacing a hardcoded "v1.0" that had drifted from reality
 * since the first release. Health also reports `update_pending` (the desktop
 * shell writes a marker after installing an auto-update; cleared on boot), so
 * the silent "installed — restart to apply" state finally has a face: the
 * exact situation where a Dock-pinned mac app keeps launching the old binary
 * while the user believes they are on latest.
 */
import { useEffect, useState } from "react";

interface Health {
  version?: string;
  update_pending?: string | null;
}

export function VersionFooter() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Health | null) => {
        if (data && !controller.signal.aborted) setHealth(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <div
      style={{
        padding: 20,
        fontSize: 12,
        color: "var(--color-surface-dark-text4)",
        lineHeight: 1.7,
      }}
    >
      hermetic {health?.version ? `v${health.version}` : ""}
      {health?.update_pending && health.update_pending !== health.version && (
        <div
          data-testid="update-pending"
          style={{ color: "var(--color-amber-warn, #b45309)", marginTop: 4 }}
        >
          Update v{health.update_pending} installed — restart the app to apply.
        </div>
      )}
      <br />
      Data stays sealed. Always.
    </div>
  );
}
