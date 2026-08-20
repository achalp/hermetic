// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { LocalFileBrowser } from "@/app/components/local-file-browser";

const browseLocalFiles = vi.fn(async () => ({
  path: "/home/user/data",
  entries: [
    { name: "sub", path: "/home/user/data/sub", isDirectory: true, isParquetFolder: false },
    {
      name: "parts",
      path: "/home/user/data/parts",
      isDirectory: true,
      isParquetFolder: true,
      isHivePartitioned: true,
    },
    {
      name: "sales.csv",
      path: "/home/user/data/sales.csv",
      isDirectory: false,
      extension: ".csv",
      size: 2048,
    },
    {
      name: "big.parquet",
      path: "/home/user/data/big.parquet",
      isDirectory: false,
      extension: ".parquet",
      size: 3 * 1024 * 1024 * 1024,
    },
  ],
}));

vi.mock("@/app/lib/api", () => ({
  browseLocalFiles: (...a: unknown[]) => browseLocalFiles(...(a as [])),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseProps = {
  onClose: vi.fn(),
  onSelect: vi.fn(),
  onSelectRemote: vi.fn(async () => {}),
};

describe("LocalFileBrowser", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<LocalFileBrowser open={false} {...baseProps} />);
    expect(container.firstChild).toBeNull();
  });

  it("browses local files on open and lists entries", async () => {
    render(<LocalFileBrowser open {...baseProps} />);
    await waitFor(() => expect(browseLocalFiles).toHaveBeenCalled());
    expect(await screen.findByText("sales.csv")).toBeInTheDocument();
    expect(screen.getByText("big.parquet")).toBeInTheDocument();
    expect(screen.getByText("HIVE PARQUET")).toBeInTheDocument();
    expect(screen.getByText("Use local or cloud files")).toBeInTheDocument();
  });

  it("selects a file and calls onSelect", async () => {
    const onSelect = vi.fn();
    render(<LocalFileBrowser open {...baseProps} onSelect={onSelect} />);
    const file = await screen.findByText("sales.csv");
    fireEvent.click(file);
    // Large-file (>1GB) hint appears once a big parquet is selected
    fireEvent.click(screen.getByText("big.parquet"));
    expect(screen.getByText(/DuckDB will stream it/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Select"));
    expect(onSelect).toHaveBeenCalledWith("/home/user/data/big.parquet", "file");
  });

  it("switches to the cloud tab and loads a remote URL", async () => {
    const onSelectRemote = vi.fn(async () => {});
    render(<LocalFileBrowser open {...baseProps} onSelectRemote={onSelectRemote} />);
    await screen.findByText("sales.csv");
    fireEvent.click(screen.getByText("Cloud URL"));
    const input = screen.getByPlaceholderText(/s3:\/\/bucket/);
    fireEvent.change(input, { target: { value: "s3://bucket/data.parquet" } });
    fireEvent.click(screen.getByText("Load"));
    await waitFor(() =>
      expect(onSelectRemote).toHaveBeenCalledWith("s3://bucket/data.parquet", undefined, false)
    );
  });
});
