// @vitest-environment jsdom
/**
 * Actually RENDER a spec through the Renderer (the existing renderer.test only
 * calls createElement, so the renderer body ran ~50%). Covers root resolution,
 * nested children, unknown-type fallback, and visible:false suppression.
 */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { Renderer, type ComponentRegistry } from "./renderer";
import { StateProvider } from "./contexts/state";
import { VisibilityProvider } from "./contexts/visibility";
import { ActionProvider } from "./contexts/actions";
import { ValidationProvider } from "./contexts/validation";

const wrap = (ui: React.ReactNode) =>
  render(
    <StateProvider>
      <VisibilityProvider>
        <ActionProvider>
          <ValidationProvider>{ui}</ValidationProvider>
        </ActionProvider>
      </VisibilityProvider>
    </StateProvider>
  );

afterEach(cleanup);

const registry: ComponentRegistry = {
  // The renderer passes the full `element`; components read element.props.
  Box: ({ element, children }) => (
    <div data-testid="box">
      {String((element.props as { label?: string })?.label ?? "")}
      {children}
    </div>
  ),
  Text: ({ element }) => <span>{String((element.props as { text?: string })?.text ?? "")}</span>,
};

describe("Renderer — rendering through the registry", () => {
  it("renders a root element's props through its registry component", () => {
    wrap(
      <Renderer
        spec={{
          root: "t",
          elements: { t: { type: "Text", props: { text: "hello" }, children: [] } },
        }}
        registry={registry}
      />
    );
    expect(screen.getByText("hello")).toBeDefined();
  });

  it("renders a parent and resolves its child element", () => {
    wrap(
      <Renderer
        spec={{
          root: "r",
          elements: {
            r: { type: "Box", props: {}, children: ["t"] },
            t: { type: "Text", props: { text: "child" }, children: [] },
          },
        }}
        registry={registry}
      />
    );
    expect(screen.getByTestId("box")).toBeDefined();
    expect(screen.getByText("child")).toBeDefined();
  });

  it("uses the fallback for an unknown component type", () => {
    const Fallback = () => <div>UNKNOWN</div>;
    wrap(
      <Renderer
        spec={{ root: "r", elements: { r: { type: "Nope", props: {}, children: [] } } }}
        registry={registry}
        fallback={Fallback as never}
      />
    );
    expect(screen.getByText("UNKNOWN")).toBeDefined();
  });

  it("does not render an element marked visible:false", () => {
    wrap(
      <Renderer
        spec={{
          root: "r",
          elements: {
            r: { type: "Box", props: {}, children: ["t"] },
            t: { type: "Text", props: { text: "secret" }, children: [], visible: false },
          },
        }}
        registry={registry}
      />
    );
    expect(screen.queryByText("secret")).toBeNull();
  });
});
