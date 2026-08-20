// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { usePanels } from "@/hooks/use-panels";

afterEach(() => {
  cleanup();
});

describe("usePanels", () => {
  it("starts with all panels closed", () => {
    const { result } = renderHook(() => usePanels());
    expect(result.current.settingsOpen).toBe(false);
    expect(result.current.railExpanded).toBe(false);
    expect(result.current.railFullscreen).toBe(false);
    expect(result.current.showArtifactsPanel).toBe(false);
    expect(result.current.artifactsFullscreen).toBe(false);
    expect(result.current.anyPanelOpen).toBe(false);
  });

  it("openSettings collapses the rail (mutual exclusion)", () => {
    const { result } = renderHook(() => usePanels());
    act(() => result.current.expandRail());
    expect(result.current.railExpanded).toBe(true);
    act(() => result.current.openSettings());
    expect(result.current.settingsOpen).toBe(true);
    expect(result.current.railExpanded).toBe(false);
    expect(result.current.railFullscreen).toBe(false);
    expect(result.current.anyPanelOpen).toBe(true);
  });

  it("expandRail closes settings (mutual exclusion)", () => {
    const { result } = renderHook(() => usePanels());
    act(() => result.current.openSettings());
    expect(result.current.settingsOpen).toBe(true);
    act(() => result.current.expandRail());
    expect(result.current.railExpanded).toBe(true);
    expect(result.current.settingsOpen).toBe(false);
  });

  it("closeSettings and collapseRail reset their state", () => {
    const { result } = renderHook(() => usePanels());
    act(() => result.current.openSettings());
    act(() => result.current.closeSettings());
    expect(result.current.settingsOpen).toBe(false);

    act(() => result.current.expandRail());
    act(() => result.current.toggleRailFullscreen());
    expect(result.current.railFullscreen).toBe(true);
    act(() => result.current.collapseRail());
    expect(result.current.railExpanded).toBe(false);
    expect(result.current.railFullscreen).toBe(false);
  });

  it("toggleRailFullscreen and toggleArtifactsFullscreen flip", () => {
    const { result } = renderHook(() => usePanels());
    act(() => result.current.toggleRailFullscreen());
    expect(result.current.railFullscreen).toBe(true);
    act(() => result.current.toggleRailFullscreen());
    expect(result.current.railFullscreen).toBe(false);

    act(() => result.current.toggleArtifactsFullscreen());
    expect(result.current.artifactsFullscreen).toBe(true);
  });

  it("setShowArtifactsPanel updates the artifacts sheet flag", () => {
    const { result } = renderHook(() => usePanels());
    act(() => result.current.setShowArtifactsPanel(true));
    expect(result.current.showArtifactsPanel).toBe(true);
  });
});
