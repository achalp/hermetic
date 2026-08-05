"use client";

/**
 * Tiny markdown renderer for user-authored notebook cells. Supports the
 * common subset — #/##/### headings, **bold**, *italic*, `code`, - / 1. lists,
 * and paragraphs. Deliberately minimal (no external dependency); unknown
 * syntax renders as plain text.
 */

import { Fragment, type ReactNode } from "react";

function renderInline(text: string, keyBase: string): ReactNode[] {
  // Split on bold, italic, and inline code while keeping delimiters.
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean);
  return tokens.map((tok, i) => {
    const key = `${keyBase}-${i}`;
    if (tok.startsWith("**") && tok.endsWith("**")) {
      return (
        <strong key={key} className="font-semibold text-t-primary">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    if (tok.startsWith("*") && tok.endsWith("*")) {
      return (
        <em key={key} className="italic">
          {tok.slice(1, -1)}
        </em>
      );
    }
    if (tok.startsWith("`") && tok.endsWith("`")) {
      return (
        <code
          key={key}
          className="bg-surface-2 px-1 py-0.5 text-[0.85em] font-mono text-t-primary"
          style={{ borderRadius: "var(--radius-badge)" }}
        >
          {tok.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={key}>{tok}</Fragment>;
  });
}

export function Markdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      const text = para.join(" ");
      blocks.push(
        <p key={`p-${blocks.length}`} className="text-sm text-t-secondary">
          {renderInline(text, `p-${blocks.length}`)}
        </p>
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items;
      const cls = "ml-5 flex flex-col gap-0.5 text-sm text-t-secondary";
      blocks.push(
        list.ordered ? (
          <ol key={`l-${blocks.length}`} className={`list-decimal ${cls}`}>
            {items.map((it, i) => (
              <li key={i}>{renderInline(it, `li-${blocks.length}-${i}`)}</li>
            ))}
          </ol>
        ) : (
          <ul key={`l-${blocks.length}`} className={`list-disc ${cls}`}>
            {items.map((it, i) => (
              <li key={i}>{renderInline(it, `li-${blocks.length}-${i}`)}</li>
            ))}
          </ul>
        )
      );
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const ordered = line.match(/^\d+\.\s+(.*)$/);

    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const txt = heading[2];
      const sizes = ["text-lg font-semibold", "text-base font-semibold", "text-sm font-semibold"];
      blocks.push(
        <p key={`h-${blocks.length}`} className={`${sizes[level - 1]} text-t-primary`}>
          {renderInline(txt, `h-${blocks.length}`)}
        </p>
      );
    } else if (bullet) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
    } else if (ordered) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return <div className="flex flex-col gap-2">{blocks}</div>;
}
