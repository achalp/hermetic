import { describe, it, expect } from "vitest";
import { buildRevealDeck } from "@/lib/slides-export";

describe("buildRevealDeck", () => {
  const slides = [
    { title: "Revenue by region", img: "data:image/png;base64,AAA" },
    { title: undefined, img: "data:image/png;base64,BBB" },
  ];

  it("produces a Reveal.js deck with a title slide and one section per slide", () => {
    const html = buildRevealDeck("Q4 review", slides);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Reveal-based
    expect(html).toContain("reveal.js");
    expect(html).toContain("reveal.css");
    expect(html).toContain("Reveal.initialize");
    // title slide + 2 content slides = 3 sections
    expect((html.match(/<section/g) || []).length).toBe(3);
    // images inlined as data URLs
    expect(html).toContain("data:image/png;base64,AAA");
    expect(html).toContain("data:image/png;base64,BBB");
    // section heading shown when present, omitted when not
    expect(html).toContain("<h2>Revenue by region</h2>");
  });

  it("escapes HTML in the deck title and slide titles", () => {
    const html = buildRevealDeck("A < B & C", [{ title: "x > y", img: "data:," }]);
    expect(html).toContain("A &lt; B &amp; C");
    expect(html).toContain("x &gt; y");
    expect(html).not.toContain("<h2>x > y</h2>");
  });
});
