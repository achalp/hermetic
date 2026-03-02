"use client";

import { useState, useCallback } from "react";

interface QueryInputProps {
  onSubmit: (question: string) => void;
  disabled?: boolean;
  isLoading?: boolean;
}

export function QueryInput({ onSubmit, disabled, isLoading }: QueryInputProps) {
  const [question, setQuestion] = useState("");

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = question.trim();
      if (trimmed && !disabled && !isLoading) {
        onSubmit(trimmed);
      }
    },
    [question, onSubmit, disabled, isLoading]
  );

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
        placeholder="Ask a question about your data..."
        disabled={disabled || isLoading}
        aria-describedby={isLoading ? "query-status" : undefined}
        className="theme-input flex-1 border border-border-default bg-surface-input px-4 py-3 text-sm text-t-primary placeholder-t-tertiary outline-none transition-colors focus:border-accent disabled:opacity-50"
        style={{
          borderRadius: "var(--radius-input)",
          transitionDuration: "var(--transition-speed)",
        }}
        onFocus={(e) => (e.currentTarget.style.boxShadow = "var(--ring-focus)")}
        onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
      />
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
            Analyzing...
          </span>
        ) : (
          "Ask"
        )}
      </button>
    </form>
  );
}
