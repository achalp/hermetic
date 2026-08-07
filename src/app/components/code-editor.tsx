"use client";

import { useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";

// Lazy-load CodeMirror itself — keeps the artifacts panel light when unused
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

interface CodeEditorProps {
  value: string;
  language: "python" | "sql";
  readOnly?: boolean;
  onChange?: (next: string) => void;
  /** Approximate height of the editor in pixels. */
  height?: number;
  /**
   * Scroll to (and select) a 1-based line. `nonce` exists so repeat clicks
   * on the same line re-trigger the scroll. This is the deep-link target of
   * the Findings tab's `code_ref` links (declared-findings spec §6: the
   * "structurally checked" wording is only honest if the cited line is one
   * interaction away).
   */
  scrollToLine?: { line: number; nonce: number };
}

const editorTheme = EditorView.theme({
  "&": {
    fontSize: "12px",
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  },
  ".cm-scroller": { overflow: "auto" },
});

export function CodeEditor({
  value,
  language,
  readOnly = false,
  onChange,
  height = 360,
  scrollToLine,
}: CodeEditorProps) {
  const extensions = [language === "python" ? python() : sql(), editorTheme];

  const viewRef = useRef<EditorView | null>(null);

  const applyScrollTo = useCallback((view: EditorView, line: number) => {
    const doc = view.state.doc;
    // Clamp: a code_ref can outlive an edit that shortened the script —
    // land on the last line rather than throwing.
    const info = doc.line(Math.max(1, Math.min(line, doc.lines)));
    view.dispatch({
      // Selecting the whole line doubles as the highlight — it is visible
      // even in readOnly mode, where highlightActiveLine is off.
      selection: { anchor: info.from, head: info.to },
      effects: EditorView.scrollIntoView(info.from, { y: "center" }),
    });
  }, []);

  // Two application paths because CodeMirror mounts lazily (next/dynamic):
  // the effect covers "editor already mounted, target changed";
  // onCreateEditor below covers "target set before the editor existed"
  // (e.g. Findings-tab click switches tabs, mounting this editor fresh).
  useEffect(() => {
    if (scrollToLine && viewRef.current) applyScrollTo(viewRef.current, scrollToLine.line);
  }, [scrollToLine, applyScrollTo]);

  return (
    <CodeMirror
      value={value}
      height={`${height}px`}
      theme={oneDark}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      onCreateEditor={(view) => {
        viewRef.current = view;
        if (scrollToLine) applyScrollTo(view, scrollToLine.line);
      }}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: !readOnly,
        foldGutter: false,
        autocompletion: false, // we don't need LSP-style completions
        dropCursor: true,
        indentOnInput: true,
      }}
      onChange={(v) => onChange?.(v)}
    />
  );
}
