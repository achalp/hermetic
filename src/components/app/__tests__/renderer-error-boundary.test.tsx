// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { RendererErrorBoundary } from "../renderer-error-boundary";

function ThrowingChild(): React.ReactNode {
  throw new Error("render explosion");
}

function SafeChild() {
  return <div>Child rendered</div>;
}

describe("RendererErrorBoundary", () => {
  const originalError = console.error;
  beforeAll(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    cleanup();
  });
  afterAll(() => {
    console.error = originalError;
  });

  it("renders children when no error", () => {
    render(
      <RendererErrorBoundary>
        <SafeChild />
      </RendererErrorBoundary>
    );
    expect(screen.getByText("Child rendered")).toBeInTheDocument();
  });

  it("renders error UI when child throws", () => {
    render(
      <RendererErrorBoundary>
        <ThrowingChild />
      </RendererErrorBoundary>
    );
    expect(screen.getByText("Visualization render error")).toBeInTheDocument();
    expect(screen.getByText("render explosion")).toBeInTheDocument();
  });

  it("renders custom fallback when provided", () => {
    render(
      <RendererErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingChild />
      </RendererErrorBoundary>
    );
    expect(screen.getByText("Custom fallback")).toBeInTheDocument();
    expect(screen.queryByText("Visualization render error")).not.toBeInTheDocument();
  });

  it("shows Try again button in default fallback", () => {
    render(
      <RendererErrorBoundary>
        <ThrowingChild />
      </RendererErrorBoundary>
    );
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });
});
