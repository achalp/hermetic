"use client";

import { useState, useCallback } from "react";

export type QueryMode = "ask" | "investigate";

interface QueryInputProps {
  onSubmit: (question: string, mode: QueryMode) => void;
  disabled?: boolean;
  isLoading?: boolean;
  initialValue?: string | null;
  /** Show the Ask | Investigate mode picker. Defaults to true. */
  showModePicker?: boolean;
  /**
   * Controlled mode value. The parent owns this so SuggestionPills,
   * analysis-history replays, and multiple QueryInput instances all
   * agree on which mode the user has selected.
   */
  mode: QueryMode;
  onModeChange: (mode: QueryMode) => void;
}

export function QueryInput({
  onSubmit,
  disabled,
  isLoading,
  initialValue,
  showModePicker = true,
  mode,
  onModeChange,
}: QueryInputProps) {
  const [question, setQuestion] = useState(initialValue ?? "");
  const [prevInitial, setPrevInitial] = useState(initialValue);

  // Sync from parent without useEffect — React pattern for derived state
  if (initialValue !== prevInitial) {
    setPrevInitial(initialValue);
    if (initialValue) {
      setQuestion(initialValue);
    }
  }

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = question.trim();
      if (trimmed && !disabled && !isLoading) {
        onSubmit(trimmed, mode);
      }
    },
    [question, onSubmit, disabled, isLoading, mode]
  );

  const placeholder =
    mode === "investigate"
      ? "Investigate: pose a deep question — we'll plan multiple steps..."
      : "Ask a question about your data...";

  const submitLabel = isLoading
    ? mode === "investigate"
      ? "Investigating..."
      : "Analyzing..."
    : mode === "investigate"
      ? "Investigate"
      : "Ask";

  return (
    <form onSubmit={handleSubmit} className="flex gap-3" role="search" aria-label="Data query">
      <label htmlFor="query-input" className="sr-only">
        Ask a question about your data
      </label>
      <input
        id="query-input"
        type="text"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder={placeholder}
        disabled={disabled || isLoading}
        aria-describedby={isLoading ? "query-status" : undefined}
        className="theme-input flex-1 border border-border-default bg-surface-input px-4 py-3 text-sm text-t-primary placeholder-t-tertiary outline-none transition-colors focus:border-accent focus-visible:shadow-[var(--ring-focus)] disabled:opacity-50"
        style={{
          borderRadius: "var(--radius-input)",
          transitionDuration: "var(--transition-speed)",
        }}
      />
      {showModePicker && (
        <label className="sr-only" htmlFor="query-mode">
          Analysis mode
        </label>
      )}
      {showModePicker && (
        <select
          id="query-mode"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as QueryMode)}
          disabled={disabled || isLoading}
          aria-label="Analysis mode"
          title={
            mode === "investigate"
              ? "Investigate runs a multi-step deep analysis (slower, cloud LLM only)."
              : "Ask runs a single fast analysis."
          }
          className="theme-input border border-border-default bg-surface-input px-3 py-3 text-sm text-t-primary outline-none transition-colors focus:border-accent disabled:opacity-50"
          style={{
            borderRadius: "var(--radius-input)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          <option value="ask">Ask</option>
          <option value="investigate">Investigate</option>
        </select>
      )}
      <button
        type="submit"
        disabled={disabled || isLoading || !question.trim()}
        className="bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          borderRadius: "var(--radius-button)",
          transitionDuration: "var(--transition-speed)",
        }}
      >
        {isLoading ? (
          <span className="flex items-center gap-2" id="query-status" role="status">
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            {submitLabel}
          </span>
        ) : (
          submitLabel
        )}
      </button>
    </form>
  );
}
