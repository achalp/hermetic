// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ConnectedSourcesSection } from "@/app/components/settings/connected-sources-section";
import type { SavedConnectionInfo } from "@/app/lib/api";

const { bindDbtManifest, unbindDbtManifest } = vi.hoisted(() => ({
  bindDbtManifest: vi.fn(async () => ({
    enrichedTableCount: 3,
    totalTableCount: 5,
    manifestPath: "/x/manifest.json",
  })),
  unbindDbtManifest: vi.fn(async () => undefined),
}));

vi.mock("@/app/lib/api", () => ({
  bindDbtManifest,
  unbindDbtManifest,
  ApiError: class ApiError extends Error {},
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SAVED: SavedConnectionInfo[] = [
  {
    id: "c1",
    name: "Prod",
    label: "BigQuery prod",
    config: { type: "bigquery", projectId: "proj-1", password: "secret" },
  } as unknown as SavedConnectionInfo,
];

const baseProps = {
  warehouseType: "bigquery",
  connectionLabel: "BigQuery prod",
  savedConnections: [] as SavedConnectionInfo[],
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
  onDeleteSaved: vi.fn(),
  onRenameSaved: vi.fn(),
};

describe("ConnectedSourcesSection", () => {
  it("shows a not-connected state", () => {
    render(<ConnectedSourcesSection {...baseProps} isConnected={false} />);
    expect(screen.getByText("No warehouse connected")).toBeInTheDocument();
    expect(screen.getByText("Add connection")).toBeInTheDocument();
  });

  it("shows the connected state with a dbt binding panel and can bind", async () => {
    render(<ConnectedSourcesSection {...baseProps} isConnected warehouseId="wh-1" />);
    expect(screen.getByText("BigQuery prod")).toBeInTheDocument();
    expect(screen.getByText("dbt project")).toBeInTheDocument();
    const input = screen.getByPlaceholderText("/path/to/dbt/target/manifest.json");
    fireEvent.change(input, { target: { value: "/x/manifest.json" } });
    fireEvent.click(screen.getByText("Link manifest"));
    await waitFor(() => expect(bindDbtManifest).toHaveBeenCalledWith("wh-1", "/x/manifest.json"));
    expect(await screen.findByText(/linked: 3 \/ 5 tables/)).toBeInTheDocument();
  });

  it("renders saved connections and can expand details", () => {
    const onDeleteSaved = vi.fn();
    render(
      <ConnectedSourcesSection
        {...baseProps}
        isConnected={false}
        savedConnections={SAVED}
        onDeleteSaved={onDeleteSaved}
      />
    );
    expect(screen.getByText("Saved connections")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Details"));
    // Sensitive password value is masked, project id shown humanized
    expect(screen.getByText("Project ID")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Forget"));
    expect(onDeleteSaved).toHaveBeenCalledWith("c1");
  });
});
