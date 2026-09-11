// @vitest-environment jsdom
/**
 * VersionFooter: the RUNNING app's version from /api/update, plus the
 * desktop-only update controls (Check for updates / Restart now) — replacing
 * both the hardcoded "v1.0" that drifted for six releases AND the silent
 * launch-twice update dance.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import type { UpdateStatus } from "@/app/lib/update-api";

vi.mock("@/app/lib/update-api", () => ({ getUpdateStatus: vi.fn(), postUpdateAction: vi.fn() }));

import { getUpdateStatus, postUpdateAction } from "@/app/lib/update-api";
import { VersionFooter } from "@/app/components/settings/version-footer";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const status = (over: Partial<UpdateStatus>): UpdateStatus => ({
  version: "0.5.7",
  desktop: true,
  phase: "idle",
  detail: null,
  update_pending: null,
  ...over,
});

describe("VersionFooter", () => {
  it("shows the live version; browser (non-desktop) gets NO update controls", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(status({ desktop: false }));
    render(<VersionFooter />);
    await waitFor(() => expect(screen.getByText(/hermetic v0\.5\.7/)).toBeTruthy());
    expect(screen.queryByTestId("check-updates")).toBeNull();
    expect(screen.queryByTestId("restart-now")).toBeNull();
  });

  it("desktop: Check for updates posts the command and reports up-to-date", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(status({}));
    vi.mocked(postUpdateAction).mockResolvedValue();
    render(<VersionFooter />);
    await waitFor(() => expect(screen.getByTestId("check-updates")).toBeTruthy());

    vi.mocked(getUpdateStatus).mockResolvedValue(status({ phase: "none" }));
    await userEvent.click(screen.getByTestId("check-updates"));
    expect(postUpdateAction).toHaveBeenCalledWith("check");
    await waitFor(() => expect(screen.getByTestId("up-to-date")).toBeTruthy(), { timeout: 4000 });
  });

  it("an installed update shows Restart now, which posts restart", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(
      status({ phase: "installed", detail: "0.5.8", update_pending: "0.5.8" })
    );
    vi.mocked(postUpdateAction).mockResolvedValue();
    render(<VersionFooter />);
    await waitFor(() =>
      expect(screen.getByTestId("update-pending").textContent).toContain("0.5.8")
    );
    await userEvent.click(screen.getByTestId("restart-now"));
    expect(postUpdateAction).toHaveBeenCalledWith("restart");
  });

  it("the boot-time pending marker alone (no live check) also offers restart", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(status({ update_pending: "0.5.9" }));
    render(<VersionFooter />);
    await waitFor(() =>
      expect(screen.getByTestId("update-pending").textContent).toContain("0.5.9")
    );
    expect(screen.getByTestId("restart-now")).toBeTruthy();
  });

  it("a shell-reported error surfaces", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(
      status({ phase: "error", detail: "check failed: offline" })
    );
    render(<VersionFooter />);
    await waitFor(() =>
      expect(screen.getByTestId("update-error").textContent).toContain("offline")
    );
  });

  it("degrades to no version (never a wrong one) when the api is unreachable", async () => {
    vi.mocked(getUpdateStatus).mockRejectedValue(new Error("offline"));
    render(<VersionFooter />);
    await waitFor(() => expect(screen.getByText(/Data stays sealed/)).toBeTruthy());
    expect(screen.queryByText(/v\d/)).toBeNull();
  });
});
