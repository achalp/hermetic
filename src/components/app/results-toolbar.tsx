"use client";

/**
 * Top-bar right-side toolbar (extracted from page.tsx, exit audit F1):
 * history/saved/settings icons always; style switch, Re-run, Save, Schedule,
 * Export, Artifacts when a result is on screen (State 4). Owns the export
 * dropdown's open/in-flight state and its outside-click dismissal.
 */
import { useEffect, useState } from "react";
import { TopBar } from "@/components/app/top-bar";
import { SourcePill } from "@/components/app/source-pill";
import { StyleDropdown } from "@/components/app/style-dropdown";
import type { NotebookExportApi } from "@/components/app/notebook-view";
import type { ScheduleState } from "@/hooks/use-schedule-popover";
import type { useSaveExport } from "@/hooks/use-save-export";

export interface ResultsToolbarProps {
  isState4: boolean;
  showSaved: boolean;
  onToggleSaved: () => void;
  purpose: string;
  onStyleChange: (id: string) => void;
  loadedVizId: string | null;
  rerunningViz: boolean;
  onRerun: () => void;
  saveExport: ReturnType<typeof useSaveExport>;
  scheduleKind: ScheduleState["kind"];
  onScheduleClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  notebookExportApi: NotebookExportApi | null;
  onExportSlides: () => Promise<void>;
  onToggleArtifacts: () => Promise<void>;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}

export function ResultsToolbar({
  isState4,
  showSaved,
  onToggleSaved,
  purpose,
  onStyleChange,
  loadedVizId,
  rerunningViz,
  onRerun,
  saveExport,
  scheduleKind,
  onScheduleClick,
  notebookExportApi,
  onExportSlides,
  onToggleArtifacts,
  settingsOpen,
  onOpenSettings,
  onCloseSettings,
}: ResultsToolbarProps) {
  const [showExportDropdown, setShowExportDropdown] = useState(false);
  // `menuExporting` tracks the in-flight notebook format.
  const [menuExporting, setMenuExporting] = useState<string | null>(null);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!showExportDropdown) return;
    const handler = () => setTimeout(() => setShowExportDropdown(false), 0);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [showExportDropdown]);

  return (
    <div className="flex items-center gap-3">
      <a
        href="/history"
        className="p-1 transition-colors text-t-secondary hover:text-t-primary"
        title="Analysis history"
        aria-label="Analysis history"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </a>
      <button
        onClick={onToggleSaved}
        className={`p-1 transition-colors ${showSaved ? "text-accent" : "text-t-secondary hover:text-t-primary"}`}
        title="Saved visualizations"
        aria-label="Saved visualizations"
      >
        <svg
          className="h-5 w-5"
          fill={showSaved ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {/* State 4 actions: style switch, Re-run, Save, Export, Artifacts */}
      {isState4 && (
        <>
          {/* Switch the output style on an existing result — re-composes
              with the new form (and animates the transition). Compact
              dropdown so it doesn't crowd the toolbar. */}
          <div className="hidden sm:block">
            <StyleDropdown selected={purpose} onSelect={onStyleChange} />
          </div>
          {loadedVizId && (
            <button
              onClick={onRerun}
              disabled={rerunningViz}
              className="text-sm font-medium text-t-secondary hover:text-accent transition-colors disabled:opacity-50"
            >
              {rerunningViz ? "Re-running..." : "Re-run"}
            </button>
          )}
          <button
            onClick={saveExport.handleSave}
            disabled={saveExport.saving || !!saveExport.exporting}
            className="text-sm font-medium text-t-secondary hover:text-accent transition-colors disabled:opacity-50"
          >
            {saveExport.saving ? "✓" : "Save"}
          </button>
          {/* Save/export status — failures were previously silent from
              the toolbar (the only consumer of saveMessage was a dead
              hook instance in ResponsePanel). */}
          {saveExport.saveMessage && (
            <span
              role="status"
              className={`text-xs ${saveExport.saveMessage.includes("fail") ? "text-error-text" : "text-t-tertiary"}`}
            >
              {saveExport.saveMessage}
            </span>
          )}
          <button
            onClick={onScheduleClick}
            disabled={scheduleKind === "auto-saving" || saveExport.saving || !!saveExport.exporting}
            className="text-sm font-medium text-t-secondary hover:text-accent transition-colors disabled:opacity-50"
            title="Schedule re-runs of this analysis"
          >
            {scheduleKind === "auto-saving" ? "Saving…" : "Schedule"}
          </button>
          <div className="relative">
            <button
              onClick={() => setShowExportDropdown((v) => !v)}
              className="text-sm font-medium text-t-secondary hover:text-accent transition-colors"
            >
              Export ▾
            </button>
            {showExportDropdown && (
              <div
                className="absolute right-0 top-full mt-1 border border-border-default bg-surface-1 py-1"
                style={{
                  borderRadius: "var(--radius-button)",
                  boxShadow: "var(--shadow-elevated)",
                  zIndex: "var(--z-export-dropdown)",
                  minWidth: 160,
                }}
              >
                {/* Options adapt to the active view: notebook formats in
                    Notebook view, dashboard formats otherwise. */}
                {(notebookExportApi
                  ? [
                      { label: "Markdown", fn: notebookExportApi.markdown },
                      { label: "HTML", fn: notebookExportApi.html },
                      { label: "PDF", fn: notebookExportApi.pdf },
                      { label: "Slides", fn: notebookExportApi.slides },
                    ]
                  : [
                      { label: "PDF", fn: saveExport.handleExportPdf },
                      { label: "DOCX", fn: saveExport.handleExportDocx },
                      { label: "PPTX", fn: saveExport.handleExportPptx },
                      { label: "Slides", fn: onExportSlides },
                    ]
                ).map((item) => (
                  <button
                    key={item.label}
                    onClick={async () => {
                      setShowExportDropdown(false);
                      try {
                        setMenuExporting(item.label);
                        await item.fn();
                      } finally {
                        setMenuExporting(null);
                      }
                    }}
                    disabled={!!saveExport.exporting || !!menuExporting}
                    className="block w-full px-4 py-2 text-left text-sm text-t-primary hover:bg-accent-subtle transition-colors disabled:opacity-50"
                  >
                    {menuExporting === item.label ||
                    saveExport.exporting === item.label.toLowerCase()
                      ? `Exporting ${item.label}...`
                      : item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onToggleArtifacts}
            className="p-1 text-t-secondary hover:text-accent transition-colors"
            title="View artifacts (SQL, code, data)"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
            </svg>
          </button>
        </>
      )}
      {/* Settings drawer toggle */}
      <button
        onClick={settingsOpen ? onCloseSettings : onOpenSettings}
        className="p-1 transition-colors text-t-secondary hover:text-t-primary"
        aria-label="Settings"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>
    </div>
  );
}

/** The whole top bar: logo, center (question / source pill), toolbar. */
export function HomeTopBar({
  onLogoClick,
  hasData,
  isState1,
  currentQuestion,
  sourceLabel,
  toolbar,
}: {
  onLogoClick: () => void;
  hasData: boolean;
  isState1: boolean;
  currentQuestion: string | null;
  sourceLabel: string;
  toolbar: ResultsToolbarProps;
}) {
  return (
    <TopBar
      onLogoClick={onLogoClick}
      center={
        hasData && !isState1 ? (
          toolbar.isState4 ? (
            <span
              className="text-sm text-t-secondary"
              style={{
                maxWidth: 400,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "block",
              }}
            >
              {currentQuestion}
            </span>
          ) : (
            <SourcePill label={sourceLabel} />
          )
        ) : undefined
      }
      right={<ResultsToolbar {...toolbar} />}
    />
  );
}
