"use client";

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
}: CodeEditorProps) {
  const extensions = [language === "python" ? python() : sql(), editorTheme];

  return (
    <CodeMirror
      value={value}
      height={`${height}px`}
      theme={oneDark}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
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
