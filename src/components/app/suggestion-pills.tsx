"use client";

import { useState, useEffect, useRef } from "react";

interface SuggestionPillsProps {
  suggestions: string[];
  onSelect: (question: string) => void;
}

export function SuggestionPills({ suggestions, onSelect }: SuggestionPillsProps) {
  // Track which pills are visible and how many chars to show per pill
  const [visibleCount, setVisibleCount] = useState(0);
  const [charCounts, setCharCounts] = useState<number[]>([]);
  const prevSuggestionsRef = useRef<string[]>([]);

  // Reset animation when suggestions change
  useEffect(() => {
    const prev = prevSuggestionsRef.current;
    const changed = suggestions.length !== prev.length || suggestions.some((s, i) => s !== prev[i]);
    if (!changed) return;
    prevSuggestionsRef.current = suggestions;

    if (suggestions.length === 0) {
      setVisibleCount(0);
      setCharCounts([]);
      return;
    }

    setVisibleCount(0);
    setCharCounts(new Array(suggestions.length).fill(0));

    let currentPill = 0;
    let currentChar = 0;
    const interval = setInterval(() => {
      if (currentPill >= suggestions.length) {
        clearInterval(interval);
        return;
      }
      const targetLen = suggestions[currentPill].length;
      currentChar += 2; // type 2 chars per tick for speed
      if (currentChar >= targetLen) {
        // Pill fully typed — finalize it and move to next
        setCharCounts((prev) => {
          const next = [...prev];
          next[currentPill] = targetLen;
          return next;
        });
        setVisibleCount((v) => Math.max(v, currentPill + 1));
        currentPill++;
        currentChar = 0;
      } else {
        setCharCounts((prev) => {
          const next = [...prev];
          next[currentPill] = currentChar;
          return next;
        });
        setVisibleCount((v) => Math.max(v, currentPill + 1));
      }
    }, 30);

    return () => clearInterval(interval);
  }, [suggestions]);

  if (suggestions.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap justify-center gap-1.5 w-full max-w-[700px]">
      {suggestions.slice(0, visibleCount).map((q, i) => {
        const chars = charCounts[i] ?? 0;
        const done = chars >= q.length;
        const displayText = done ? q : q.slice(0, chars);
        return (
          <button
            key={q}
            onClick={() => (done ? onSelect(q) : undefined)}
            className="source-card-hover transition-colors"
            style={{
              padding: "5px 12px",
              borderRadius: 99,
              border: "none",
              background: "var(--color-accent-subtle)",
              color: "var(--color-accent-text)",
              cursor: done ? "pointer" : "default",
              fontFamily: "inherit",
              fontSize: 12,
              whiteSpace: "nowrap",
              opacity: done ? 1 : 0.7,
              transition: "opacity 0.3s",
            }}
          >
            {displayText}
            {!done && <span style={{ opacity: 0.4 }}>|</span>}
          </button>
        );
      })}
    </div>
  );
}
