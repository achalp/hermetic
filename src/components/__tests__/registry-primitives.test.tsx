// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

vi.mock("@/components/theme/theme-config", () => ({
  useStatCardTheme: () => ({
    align: "center",
    valueClass: "text-xl",
    labelTransform: "none",
    labelTracking: "0",
    labelWeight: 500,
  }),
  useInsightTheme: () => ({ borderSide: "left", bgTint: false }),
  useAnnotationTheme: () => ({ bgFill: true, borderWidth: "1px" }),
}));

// Mock useBoundProp to act like useState
vi.mock("@/spec/react", () => ({
  useBoundProp: <T,>(initial: T) => {
    const [val, setVal] = React.useState(initial);
    return [val, setVal] as const;
  },
}));

import {
  StatCardComponent,
  TextBlockComponent,
  AnnotationComponent,
  TrendIndicatorComponent,
  SelectControlComponent,
  NumberInputComponent,
  ToggleSwitchComponent,
  formatStatNumber,
  formatStatValue,
  CitationsContext,
  CitationNavigateContext,
} from "@/components/registry-primitives";

afterEach(() => cleanup());

// ── formatStatNumber ───────────────────────────────────────
describe("formatStatNumber", () => {
  it("formats billions", () => {
    expect(formatStatNumber(2_500_000_000)).toBe("2.5B");
  });

  it("formats millions", () => {
    expect(formatStatNumber(1_200_000)).toBe("1.2M");
  });

  it("formats integers with commas", () => {
    expect(formatStatNumber(42_000)).toBe("42,000");
  });

  it("formats decimals to 2 places", () => {
    expect(formatStatNumber(3.14159)).toBe("3.14");
  });

  it("applies prefix", () => {
    expect(formatStatNumber(5_000_000, "$")).toBe("$5.0M");
  });
});

// ── formatStatValue ────────────────────────────────────────
describe("formatStatValue", () => {
  it("formats numbers", () => {
    expect(formatStatValue(1234)).toBe("1,234");
  });

  it("parses currency strings", () => {
    expect(formatStatValue("$1,500,000")).toBe("$1.5M");
  });

  it("parses percentage strings", () => {
    expect(formatStatValue("42.5%")).toBe("42.50%");
  });

  it("returns non-numeric strings as-is", () => {
    expect(formatStatValue("hello")).toBe("hello");
  });

  it("handles null/undefined", () => {
    expect(formatStatValue(null)).toBe("");
    expect(formatStatValue(undefined)).toBe("");
  });
});

// ── StatCard ───────────────────────────────────────────────
describe("StatCardComponent", () => {
  it("renders label and formatted value", () => {
    render(<StatCardComponent props={{ label: "Revenue", value: 5000000 }} />);
    expect(screen.getByText("Revenue")).toBeDefined();
    expect(screen.getByText("5.0M")).toBeDefined();
  });

  it("renders trend indicator when provided", () => {
    render(
      <StatCardComponent props={{ label: "Users", value: 100, trend: "up", change: "+10%" }} />
    );
    expect(screen.getByText(/\+10%/)).toBeDefined();
  });

  it("renders description when provided", () => {
    render(<StatCardComponent props={{ label: "Score", value: 95, description: "Out of 100" }} />);
    expect(screen.getByText("Out of 100")).toBeDefined();
  });
});

// ── TextBlock ──────────────────────────────────────────────
describe("TextBlockComponent", () => {
  it("renders body variant by default", () => {
    render(<TextBlockComponent props={{ content: "Hello world" }} />);
    expect(screen.getByText("Hello world")).toBeDefined();
  });

  it("renders heading variant", () => {
    const { container } = render(
      <TextBlockComponent props={{ content: "Title", variant: "heading" }} />
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("text-xl");
  });

  it("renders warning variant", () => {
    const { container } = render(
      <TextBlockComponent props={{ content: "Caution!", variant: "warning" }} />
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("text-warning-text");
  });

  it("renders insight variant with left border", () => {
    const { container } = render(
      <TextBlockComponent props={{ content: "Key insight", variant: "insight" }} />
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("border-l-4");
  });

  it("renders a step citation as a superscript reference (Investigate spec)", () => {
    const { container } = render(
      <CitationsContext.Provider value={true}>
        <TextBlockComponent props={{ content: "Revenue grew sharply (Step 2)." }} />
      </CitationsContext.Provider>
    );
    const sup = container.querySelector("sup");
    expect(sup).not.toBeNull();
    expect(sup?.textContent).toBe("2");
    expect(sup?.getAttribute("title")).toBe("Step 2");
    // The parenthetical is replaced, not left inline.
    expect(container.textContent).not.toContain("(Step 2)");
    expect(container.textContent).toContain("Revenue grew sharply");
  });

  it("collapses a multi-step citation into one superscript", () => {
    const { container } = render(
      <CitationsContext.Provider value={true}>
        <TextBlockComponent props={{ content: "Both regions slipped (Steps 1, 4)." }} />
      </CitationsContext.Provider>
    );
    const sup = container.querySelector("sup");
    expect(sup?.textContent).toBe("1,4");
    expect(sup?.getAttribute("title")).toBe("Steps 1, 4");
  });

  it("leaves ordinary parenthetical text untouched", () => {
    const { container } = render(
      <CitationsContext.Provider value={true}>
        <TextBlockComponent props={{ content: "Sales rose (mostly in Q4)." }} />
      </CitationsContext.Provider>
    );
    expect(container.querySelector("sup")).toBeNull();
    expect(container.textContent).toContain("(mostly in Q4)");
  });

  it("makes citations clickable when a navigate handler is provided", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { container } = render(
      <CitationNavigateContext.Provider value={navigate}>
        <CitationsContext.Provider value={true}>
          <TextBlockComponent props={{ content: "Churn rose sharply (Step 4)." }} />
        </CitationsContext.Provider>
      </CitationNavigateContext.Provider>
    );
    const sup = container.querySelector("sup");
    expect(sup?.getAttribute("role")).toBe("link");
    await user.click(sup!);
    expect(navigate).toHaveBeenCalledWith(4);
  });

  it("renders '(Step N)' prose verbatim outside an Investigate spec", () => {
    // Ask-mode dashboards have no investigation steps — a literal "(Step 3)"
    // in the data's own vocabulary must not become a citation mark.
    const { container } = render(
      <TextBlockComponent props={{ content: "Biggest drop-off at Checkout (Step 3)." }} />
    );
    expect(container.querySelector("sup")).toBeNull();
    expect(container.textContent).toContain("(Step 3)");
  });
});

// ── Annotation ─────────────────────────────────────────────
describe("AnnotationComponent", () => {
  it("renders title and content", () => {
    render(<AnnotationComponent props={{ title: "Note", content: "Details here" }} />);
    expect(screen.getByText("Note")).toBeDefined();
    expect(screen.getByText("Details here")).toBeDefined();
  });

  it("applies severity styles", () => {
    const { container } = render(
      <AnnotationComponent
        props={{ title: "Warning", content: "Be careful", severity: "warning" }}
      />
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("border-warning-border");
  });

  it("renders a 'what does this mean?' disclosure when details are given", () => {
    const { container } = render(
      <AnnotationComponent
        props={{
          title: "Amount Outliers",
          content: "An outlier screen flagged some values.",
          details: "A data check is an automatic test…",
          detailsLabel: "What does this check mean?",
        }}
      />
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(screen.getByText("What does this check mean?")).toBeDefined();
    expect(screen.getByText("A data check is an automatic test…")).toBeDefined();
  });

  it("omits the disclosure when no details are given", () => {
    const { container } = render(
      <AnnotationComponent props={{ title: "Note", content: "Plain callout" }} />
    );
    expect(container.querySelector("details")).toBeNull();
  });
});

// ── TrendIndicator ─────────────────────────────────────────
describe("TrendIndicatorComponent", () => {
  it("renders label and formatted current value", () => {
    render(<TrendIndicatorComponent props={{ label: "Sales", current: 150, previous: 100 }} />);
    expect(screen.getByText("Sales")).toBeDefined();
  });

  it("shows percentage change", () => {
    render(<TrendIndicatorComponent props={{ label: "Growth", current: 200, previous: 100 }} />);
    expect(screen.getByText(/\+100\.0%/)).toBeDefined();
  });

  it("formats currency values", () => {
    render(
      <TrendIndicatorComponent
        props={{ label: "Revenue", current: 1500, previous: 1000, format: "currency" }}
      />
    );
    expect(screen.getByText(/\$1,500/)).toBeDefined();
  });
});

// ── SelectControl ──────────────────────────────────────────
describe("SelectControlComponent", () => {
  it("renders label and options", () => {
    render(
      <SelectControlComponent
        props={{
          label: "Color",
          value: "red",
          options: [
            { value: "red", label: "Red" },
            { value: "blue", label: "Blue" },
          ],
        }}
        bindings={undefined}
      />
    );
    expect(screen.getByText("Color")).toBeDefined();
    expect(screen.getByText("Red")).toBeDefined();
    expect(screen.getByText("Blue")).toBeDefined();
  });

  it("renders placeholder option", () => {
    render(
      <SelectControlComponent
        props={{
          label: "Size",
          value: "",
          options: [{ value: "s", label: "Small" }],
          placeholder: "Choose...",
        }}
        bindings={undefined}
      />
    );
    expect(screen.getByText("Choose...")).toBeDefined();
  });
});

// ── NumberInput ─────────────────────────────────────────────
describe("NumberInputComponent", () => {
  it("renders label and input with value", () => {
    render(<NumberInputComponent props={{ label: "Quantity", value: 5 }} bindings={undefined} />);
    expect(screen.getByText("Quantity")).toBeDefined();
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("5");
  });

  it("applies min/max/step attributes", () => {
    render(
      <NumberInputComponent
        props={{ label: "Count", value: 10, min: 0, max: 100, step: 5 }}
        bindings={undefined}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.min).toBe("0");
    expect(input.max).toBe("100");
    expect(input.step).toBe("5");
  });
});

// ── ToggleSwitch ───────────────────────────────────────────
describe("ToggleSwitchComponent", () => {
  it("renders label and switch", () => {
    render(
      <ToggleSwitchComponent props={{ label: "Dark mode", checked: false }} bindings={undefined} />
    );
    expect(screen.getByText("Dark mode")).toBeDefined();
    const btn = screen.getByRole("switch");
    expect(btn.getAttribute("aria-checked")).toBe("false");
  });

  it("toggles on click", async () => {
    const user = userEvent.setup();
    render(
      <ToggleSwitchComponent props={{ label: "Enable", checked: false }} bindings={undefined} />
    );
    const btn = screen.getByRole("switch");
    expect(btn.getAttribute("aria-checked")).toBe("false");
    await user.click(btn);
    expect(btn.getAttribute("aria-checked")).toBe("true");
  });
});
