/**
 * Spec summaries — with the ARCH-11 sync guarantee: the label extraction is
 * presence-driven, and the catalog-sweep test below fails the moment a
 * component declares a `title`/`label` prop that summarizeSpec would drop.
 * (The old type-switch listed 10 of ~60 catalog charts; the rest silently
 * vanished from history summaries and follow-up context.)
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { summarizeSpec, extractSpecComponentTypes, extractDescription } from "@/lib/spec-summary";
import { catalogComponents } from "@/lib/catalog";

const specOf = (type: string, props: Record<string, unknown>) => ({
  root: "r",
  elements: { r: { type, props } },
});

describe("summarizeSpec", () => {
  it("summarizes a nested tree with per-type labels", () => {
    const spec = {
      root: "col",
      elements: {
        col: { type: "LayoutColumn", props: {}, children: ["stat", "chart", "text"] },
        stat: { type: "StatCard", props: { label: "Total", value: 42 } },
        chart: { type: "BarChart", props: { title: "By Region" } },
        text: { type: "TextBlock", props: { content: "A note" } },
      },
    };
    expect(summarizeSpec(spec)).toBe(
      [
        "- LayoutColumn",
        "  - StatCard: Total: 42",
        "  - BarChart: By Region",
        "  - TextBlock: A note",
      ].join("\n")
    );
  });

  it("labels EVERY catalog component that declares a title or label prop (ARCH-11)", () => {
    // Catalog-derived sweep: a new chart added to the catalog is covered
    // automatically; a regression to a hand-synced type list fails here.
    let sweptTitle = 0;
    let sweptLabel = 0;
    for (const [name, def] of Object.entries(catalogComponents)) {
      const shape = (def.props as z.ZodObject<z.ZodRawShape>).shape;
      if ("title" in shape) {
        sweptTitle++;
        expect(summarizeSpec(specOf(name, { title: "T-9" })), name).toContain("T-9");
      } else if ("label" in shape && name !== "StatCard") {
        sweptLabel++;
        expect(summarizeSpec(specOf(name, { label: "L-9" })), name).toContain("L-9");
      }
    }
    // Guard the sweep itself: if the catalog shape access breaks, these
    // counters expose an empty (vacuously green) loop.
    expect(sweptTitle).toBeGreaterThan(50);
    expect(sweptLabel).toBeGreaterThan(0);
  });

  it("ignores non-string titles (a $state binding must not become noise)", () => {
    expect(summarizeSpec(specOf("BarChart", { title: { $state: "/x" } }))).toBe("- BarChart");
  });

  it("summarizes DataController by its filter/output counts", () => {
    expect(summarizeSpec(specOf("DataController", { filters: [{}, {}], outputs: [{}] }))).toContain(
      "2 filters, 1 outputs"
    );
  });
});

describe("extractSpecComponentTypes / extractDescription", () => {
  const spec = {
    root: "col",
    elements: {
      col: { type: "LayoutColumn", props: {}, children: ["a", "b"] },
      a: { type: "StatCard", props: { label: "x", value: 1 } },
      b: { type: "TextBlock", props: { variant: "body", content: "Methodology here." } },
    },
  };

  it("lists component types in document order", () => {
    expect(extractSpecComponentTypes(spec)).toEqual(["LayoutColumn", "StatCard", "TextBlock"]);
  });

  it("extracts the last body TextBlock as the description", () => {
    expect(extractDescription(spec)).toBe("Methodology here.");
  });
});
