// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { CSVUploadPanel } from "@/components/app/csv-upload-panel";

vi.mock("@/lib/api", () => ({
  uploadFile: vi.fn(),
}));

import { uploadFile } from "@/lib/api";
const mockUploadFile = uploadFile as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  mockUploadFile.mockReset();
});

describe("CSVUploadPanel", () => {
  it("renders upload prompt", () => {
    render(<CSVUploadPanel onUpload={vi.fn()} />);
    expect(screen.getByText(/Drop your CSV/)).toBeDefined();
    expect(screen.getByText("Max 100MB")).toBeDefined();
  });

  it("rejects files over 100MB without uploading", async () => {
    const user = userEvent.setup();
    const onUpload = vi.fn();
    render(<CSVUploadPanel onUpload={onUpload} />);

    // Create a file larger than 100MB
    const largeFile = new File(["x"], "big.csv", { type: "text/csv" });
    Object.defineProperty(largeFile, "size", { value: 150 * 1024 * 1024 });

    const input = screen.getByLabelText("Select CSV, Excel, or GeoJSON file");
    await user.upload(input, largeFile);

    expect(screen.getByText(/File is too large/)).toBeDefined();
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("accepts files under 100MB", async () => {
    const user = userEvent.setup();
    const onUpload = vi.fn();
    mockUploadFile.mockResolvedValue({ csv_id: "abc", schema: { columns: [] } });

    render(<CSVUploadPanel onUpload={onUpload} />);

    const smallFile = new File(["data"], "small.csv", { type: "text/csv" });
    Object.defineProperty(smallFile, "size", { value: 50 * 1024 * 1024 });

    const input = screen.getByLabelText("Select CSV, Excel, or GeoJSON file");
    await user.upload(input, smallFile);

    expect(mockUploadFile).toHaveBeenCalled();
    expect(onUpload).toHaveBeenCalledWith("abc", { columns: [] });
  });

  it("shows error from API failure", async () => {
    const user = userEvent.setup();
    mockUploadFile.mockRejectedValue(new Error("Server error"));

    render(<CSVUploadPanel onUpload={vi.fn()} />);

    const file = new File(["data"], "test.csv", { type: "text/csv" });
    const input = screen.getByLabelText("Select CSV, Excel, or GeoJSON file");
    await user.upload(input, file);

    expect(screen.getByText("Server error")).toBeDefined();
  });
});
