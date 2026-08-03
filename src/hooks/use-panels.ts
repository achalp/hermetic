"use client";

/**
 * Open/closed state for the page's chrome panels (extracted from page.tsx,
 * exit audit F1): settings drawer, data rail (+fullscreen), artifacts bottom
 * sheet. Owns the mutual-exclusion invariant — opening the drawer collapses
 * the rail and vice versa.
 */
import { useCallback, useState } from "react";

export function usePanels() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const [railFullscreen, setRailFullscreen] = useState(false);
  const [showArtifactsPanel, setShowArtifactsPanel] = useState(false);
  const [artifactsFullscreen, setArtifactsFullscreen] = useState(false);

  // Mutual exclusion: only one panel open at a time
  const openSettings = useCallback(() => {
    setRailExpanded(false);
    setRailFullscreen(false);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const expandRail = useCallback(() => {
    setSettingsOpen(false);
    setRailExpanded(true);
  }, []);
  const collapseRail = useCallback(() => {
    setRailExpanded(false);
    setRailFullscreen(false);
  }, []);
  const toggleRailFullscreen = useCallback(() => setRailFullscreen((f) => !f), []);
  const toggleArtifactsFullscreen = useCallback(() => setArtifactsFullscreen((f) => !f), []);

  return {
    settingsOpen,
    openSettings,
    closeSettings,
    railExpanded,
    railFullscreen,
    expandRail,
    collapseRail,
    toggleRailFullscreen,
    showArtifactsPanel,
    setShowArtifactsPanel,
    artifactsFullscreen,
    toggleArtifactsFullscreen,
    anyPanelOpen: settingsOpen || railExpanded,
  };
}
