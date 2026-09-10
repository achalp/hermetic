// @vitest-environment jsdom
/**
 * VersionFooter: the Settings drawer shows the RUNNING app's version from
 * /api/health (a hardcoded "v1.0" drifted from reality for six releases) and
 * surfaces the desktop shell's "update installed — restart to apply" marker,
 * which previously existed only as an invisible stderr line.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import type { HealthInfo } from "@/app/lib/api";

vi.mock("@/app/lib/api", () => ({ getHealth: vi.fn() }));

import { getHealth } from "@/app/lib/api";
import { VersionFooter } from "@/app/components/settings/version-footer";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const health = (body: Partial<HealthInfo>) =>
  vi.mocked(getHealth).mockResolvedValue(body as HealthInfo);

describe("VersionFooter", () => {
  it("shows the live version from /api/health", async () => {
    health({ version: "0.5.5", update_pending: null });
    render(<VersionFooter />);
    await waitFor(() => expect(screen.getByText(/hermetic v0\.5\.5/)).toBeTruthy());
    expect(screen.queryByTestId("update-pending")).toBeNull();
  });

  it("shows the restart-to-apply banner when an update is pending", async () => {
    health({ version: "0.5.5", update_pending: "0.5.6" });
    render(<VersionFooter />);
    await waitFor(() =>
      expect(screen.getByTestId("update-pending").textContent).toContain("0.5.6")
    );
    expect(screen.getByTestId("update-pending").textContent).toContain("restart");
  });

  it("no banner when pending equals running (stale marker)", async () => {
    health({ version: "0.5.5", update_pending: "0.5.5" });
    render(<VersionFooter />);
    await waitFor(() => expect(screen.getByText(/v0\.5\.5/)).toBeTruthy());
    expect(screen.queryByTestId("update-pending")).toBeNull();
  });

  it("degrades to no version (never a wrong one) when health is unreachable", async () => {
    vi.mocked(getHealth).mockRejectedValue(new Error("offline"));
    render(<VersionFooter />);
    // The tagline still renders; no hardcoded version can reappear.
    await waitFor(() => expect(screen.getByText(/Data stays sealed/)).toBeTruthy());
    expect(screen.queryByText(/v\d/)).toBeNull();
  });
});
