"use client";

import { useCallback, useRef, useState } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { ModeToggle } from "./mode-toggle";
import type { QueryMode } from "@/app/components/query-input";

interface AskComposerProps {
  question: string;
  onQuestionChange: (question: string) => void;
  mode: QueryMode;
  onModeChange: (mode: QueryMode) => void;
  /** Name of the attached dataset/connection; null while no data is loaded. */
  attachedLabel?: string | null;
  /** Run the analysis. Only called when both question and data are present. */
  onSubmit: (question: string, mode: QueryMode) => void;
  /**
   * Popover content for the "Add data" button. Render-prop so menu items can
   * close the popover after a pick.
   */
  renderMenu: (close: () => void) => React.ReactNode;
  isLoading?: boolean;
}

/**
 * The home page's single primary action: the question, with data attached to
 * it. The submit button opens the Add-data menu when no data is attached yet
 * (guides instead of dead-ends); ⌘/Ctrl+Enter submits.
 */
export function AskComposer({
  question,
  onQuestionChange,
  mode,
  onModeChange,
  attachedLabel,
  onSubmit,
  renderMenu,
  isLoading,
}: AskComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useClickOutside(menuRef, closeMenu, menuOpen);

  const trimmed = question.trim();
  const hasQuestion = trimmed.length > 0;
  const canSubmit = hasQuestion && !!attachedLabel && !isLoading;
  const submitLabel = isLoading
    ? mode === "investigate"
      ? "Investigating..."
      : "Analyzing..."
    : mode === "investigate"
      ? "Investigate"
      : "Analyze";

  const trySubmit = useCallback(() => {
    if (isLoading) return;
    if (canSubmit) {
      onSubmit(trimmed, mode);
    } else if (hasQuestion) {
      // Question but no data: the button guides to the missing half.
      setMenuOpen(true);
    }
  }, [canSubmit, hasQuestion, isLoading, onSubmit, trimmed, mode]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        trySubmit();
      }
    },
    [trySubmit]
  );

  return (
    <div className="w-full" style={{ maxWidth: 720 }}>
      <div
        className="theme-input w-full border bg-surface-1 transition-colors focus-within:border-accent"
        style={{
          borderWidth: 1.5,
          borderColor: "var(--color-border-default)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-card, 0 1px 2px rgb(0 0 0 / 0.05))",
        }}
      >
        <label htmlFor="home-question" className="sr-only">
          Ask a question about your data
        </label>
        <textarea
          id="home-question"
          rows={2}
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="What changed last quarter, and why?"
          disabled={isLoading}
          className="w-full resize-none border-none bg-transparent text-t-primary placeholder-t-tertiary outline-none disabled:opacity-50"
          style={{ padding: "16px 18px 4px", fontSize: 16.5, lineHeight: 1.45, minHeight: 56 }}
        />
        <div className="flex flex-wrap items-center gap-2" style={{ padding: "10px 12px 12px" }}>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex cursor-pointer items-center gap-1.5 bg-transparent text-sm font-semibold text-t-secondary transition-colors hover:border-accent hover:bg-accent-subtle hover:text-accent-text"
              style={{
                minHeight: 40,
                padding: "0 13px",
                border: "1.5px dashed var(--color-border-strong, var(--color-border-default))",
                borderRadius: "var(--radius-button)",
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                aria-hidden
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              {attachedLabel ? "Change data" : "Add data"}
            </button>
            {menuOpen && (
              <div
                className="absolute left-0 z-20 border border-border-default bg-surface-1"
                style={{
                  top: "calc(100% + 8px)",
                  borderRadius: "var(--radius-card)",
                  boxShadow: "var(--shadow-dropdown, 0 8px 24px rgb(0 0 0 / 0.12))",
                }}
              >
                {renderMenu(closeMenu)}
              </div>
            )}
          </div>

          {attachedLabel && (
            <span
              className="flex items-center gap-1.5 text-sm font-semibold"
              style={{
                minHeight: 40,
                padding: "0 13px",
                maxWidth: 280,
                borderRadius: "var(--radius-button)",
                background: "var(--color-accent-subtle)",
                color: "var(--color-accent-text)",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                aria-hidden
              >
                <path d="M4 12l5 5L20 6" />
              </svg>
              <span className="truncate">{attachedLabel}</span>
            </span>
          )}

          <span className="flex-1" />
          <ModeToggle mode={mode} onModeChange={onModeChange} disabled={isLoading} />
          <button
            type="button"
            onClick={trySubmit}
            disabled={!hasQuestion || isLoading}
            className="flex cursor-pointer items-center gap-1.5 border-none bg-accent text-sm font-bold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            style={{ minHeight: 42, padding: "0 20px", borderRadius: "var(--radius-button)" }}
          >
            {submitLabel} <span aria-hidden>→</span>
          </button>
        </div>
      </div>

      <p
        role="status"
        className="text-center text-t-tertiary"
        style={{ fontSize: 12.5, marginTop: 8, minHeight: 18 }}
      >
        {mode === "ask" ? (
          <>
            <strong className="font-semibold text-t-secondary">Ask</strong> — one dashboard, ~30s.
            Drop a file anywhere · ⌘↵ to run
          </>
        ) : (
          <>
            <strong className="font-semibold text-t-secondary">Investigate</strong> — multi-step
            deep dive: sub-questions planned and composed into one report. Minutes.
          </>
        )}
      </p>
    </div>
  );
}
