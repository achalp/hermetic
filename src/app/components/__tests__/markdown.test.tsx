// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Markdown } from "@/app/components/markdown";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders headings, inline emphasis, and code", () => {
    render(<Markdown content={"# Title\nSome **bold** and *italic* and `code` text."} />);
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("renders unordered and ordered lists", () => {
    const { container } = render(<Markdown content={"- one\n- two\n\n1. first\n2. second"} />);
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelector("ol")).not.toBeNull();
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("renders plain paragraphs joining wrapped lines", () => {
    render(<Markdown content={"line one\nline two"} />);
    expect(screen.getByText("line one line two")).toBeInTheDocument();
  });

  it("renders ## and ### headings", () => {
    render(<Markdown content={"## H2\n### H3"} />);
    expect(screen.getByText("H2")).toBeInTheDocument();
    expect(screen.getByText("H3")).toBeInTheDocument();
  });
});
