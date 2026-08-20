// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { SchedulePopover, SchedulePill } from "@/app/components/schedule-popover";

const { listSchedules, setSchedule, deleteSchedule, runScheduleNow } = vi.hoisted(() => ({
  listSchedules: vi.fn(async () => [] as unknown[]),
  setSchedule: vi.fn(async () => ({ vizId: "v1", cadence: "daily-9am", autoExport: ["xlsx"] })),
  deleteSchedule: vi.fn(async () => undefined),
  runScheduleNow: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/app/lib/api", () => ({
  listSchedules,
  setSchedule,
  deleteSchedule,
  runScheduleNow,
  ApiError: class ApiError extends Error {},
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const EXISTING = {
  vizId: "v1",
  createdAt: Date.now(),
  cadence: "hourly" as const,
  autoExport: ["xlsx", "csv"] as ("xlsx" | "csv")[],
  lastStatus: "success" as const,
  lastRunAt: Date.now() - 60_000,
  nextRunAt: Date.now() + 60_000,
  lastError: null,
};

describe("SchedulePopover", () => {
  it("loads and renders the new-schedule form when none exists", async () => {
    render(<SchedulePopover vizId="v1" anchorRect={null} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Schedule re-run")).toBeInTheDocument());
    expect(screen.getByText("Cadence")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
    // No existing schedule → no Run now / Delete
    expect(screen.queryByText("Run now")).not.toBeInTheDocument();
  });

  it("renders edit form + saves when an existing schedule is found", async () => {
    listSchedules.mockResolvedValueOnce([EXISTING]);
    const onChanged = vi.fn();
    render(
      <SchedulePopover vizId="v1" anchorRect={null} onClose={() => {}} onChanged={onChanged} />
    );
    await waitFor(() => expect(screen.getByText("Edit schedule")).toBeInTheDocument());
    expect(screen.getByText("Run now")).toBeInTheDocument();
    expect(screen.getByText("Delete schedule")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Update"));
    await waitFor(() => expect(setSchedule).toHaveBeenCalled());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("deletes an existing schedule", async () => {
    listSchedules.mockResolvedValueOnce([EXISTING]);
    render(<SchedulePopover vizId="v1" anchorRect={null} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Delete schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Delete schedule"));
    await waitFor(() => expect(deleteSchedule).toHaveBeenCalledWith("v1"));
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<SchedulePopover vizId="v1" anchorRect={null} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Schedule re-run")).toBeInTheDocument());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("SchedulePill", () => {
  it("returns nothing without a schedule", () => {
    const { container } = render(<SchedulePill schedule={null} onClick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a cadence label and fires onClick", () => {
    const onClick = vi.fn();
    render(<SchedulePill schedule={EXISTING} onClick={onClick} />);
    const btn = screen.getByText(/Hourly/);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it("shows a failing state", () => {
    render(
      <SchedulePill
        schedule={{ ...EXISTING, lastStatus: "error", lastError: "boom" }}
        onClick={() => {}}
      />
    );
    expect(screen.getByText(/Hourly/)).toBeInTheDocument();
  });
});
