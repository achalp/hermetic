// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { InlineConnectionForm } from "@/app/components/inline-connection-form";
import { ENGINES } from "@/lib/warehouse/engine-descriptor";

afterEach(cleanup);

describe("InlineConnectionForm", () => {
  it("renders nothing when not visible", () => {
    const { container } = render(<InlineConnectionForm visible={false} onConnect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows engine type buttons and reveals fields on selection", () => {
    render(<InlineConnectionForm visible onConnect={() => {}} />);
    // The postgresql engine button (first in dbTypes) shows its display name
    const pgLabel = ENGINES.postgresql.displayName;
    const btn = screen.getByText(new RegExp(pgLabel));
    fireEvent.click(btn);
    // Fields + Connect now visible
    expect(screen.getByText("Connect")).toBeInTheDocument();
    expect(screen.getByText(/Ignore cached schema/)).toBeInTheDocument();
  });

  it("builds a config and calls onConnect", () => {
    const onConnect = vi.fn();
    render(<InlineConnectionForm visible onConnect={onConnect} />);
    fireEvent.click(screen.getByText(new RegExp(ENGINES.bigquery.displayName)));
    fireEvent.click(screen.getByText("Connect"));
    expect(onConnect).toHaveBeenCalled();
    const [config] = onConnect.mock.calls[0];
    expect(config.type).toBe("bigquery");
  });

  it("passes the ignore-cache flag through", () => {
    const onConnect = vi.fn();
    render(<InlineConnectionForm visible onConnect={onConnect} />);
    fireEvent.click(screen.getByText(new RegExp(ENGINES.postgresql.displayName)));
    fireEvent.click(screen.getByLabelText(/Ignore cached schema/, { selector: "input" }));
    fireEvent.click(screen.getByText("Connect"));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ type: "postgresql" }), true);
  });
});
