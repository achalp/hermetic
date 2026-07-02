// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DefinitionListComponent } from "@/components/definition-list";

afterEach(cleanup);

describe("DefinitionListComponent", () => {
  it("renders each term/definition pair as dt/dd (a real definition list, not a table)", () => {
    const { container } = render(
      <DefinitionListComponent
        props={{
          title: "Definitions",
          items: [
            { term: "QCR", definition: "Quote conversion rate" },
            { term: "QTB", definition: "Quote to booking" },
          ],
        }}
      />
    );
    expect(screen.getByText("Definitions")).toBeInTheDocument();
    expect(container.querySelectorAll("dt")).toHaveLength(2);
    expect(container.querySelectorAll("dd")).toHaveLength(2);
    expect(screen.getByText("QCR").tagName.toLowerCase()).toBe("dt");
    expect(screen.getByText("Quote conversion rate").tagName.toLowerCase()).toBe("dd");
    // No table chrome.
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });

  it("omits the title when not provided and tolerates empty items", () => {
    const { container } = render(<DefinitionListComponent props={{ items: [] }} />);
    expect(container.querySelector("h3")).toBeNull();
    expect(container.querySelectorAll("dt")).toHaveLength(0);
  });
});
