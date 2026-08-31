"use client";

import { useState } from "react";

export type RecentItemKind =
  "upload" | "local-file" | "local-folder" | "remote-parquet" | "manifest" | "warehouse";

export interface RecentItem {
  id: string;
  kind: RecentItemKind;
  name: string;
  /** The "where": path, URL, or host — middle-truncated when long. */
  subtitle: string;
  /** Prepared right-side meta, e.g. "2.5B rows · 2h ago". */
  meta?: string;
  /** Warehouse brand color for the kind dot (falls back to accent). */
  brandColor?: string;
}

interface RecentSourcesProps {
  items: RecentItem[];
  onOpen: (item: RecentItem) => void;
  onRefresh?: (item: RecentItem) => void;
  onRemove: (item: RecentItem) => void;
  onRename: (item: RecentItem, name: string) => void;
  onClearAll: () => void;
  /** The item currently (re)loading — shows a spinner and disables the row. */
  busyId?: string | null;
}

/** Kinds that can be re-read from source (schema refresh makes sense). */
const REFRESHABLE = new Set<RecentItemKind>([
  "remote-parquet",
  "manifest",
  "local-file",
  "local-folder",
]);

/** Middle-ellipsis so both ends of a long path/URL stay readable. */
function middle(s: string, max = 52): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

export function RecentSources({
  items,
  onOpen,
  onRefresh,
  onRemove,
  onRename,
  onClearAll,
  busyId,
}: RecentSourcesProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (items.length === 0) return null;

  const commitRename = (item: RecentItem) => {
    const name = draft.trim();
    if (name && name !== item.name) onRename(item, name);
    setEditingId(null);
  };

  return (
    <div className="w-full" style={{ maxWidth: 700 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <span
          className="uppercase"
          style={{ fontSize: 12, letterSpacing: "0.06em", color: "var(--color-t-tertiary)" }}
        >
          Recent
        </span>
        <button
          onClick={onClearAll}
          className="transition-colors hover:text-[var(--color-t-secondary)]"
          style={{
            fontSize: 12,
            color: "var(--color-t-tertiary)",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Clear all
        </button>
      </div>

      <div
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-default)",
          borderRadius: "var(--radius-card)",
          overflow: "hidden",
        }}
      >
        {items.map((item, i) => {
          const busy = busyId === item.id;
          const editing = editingId === item.id;
          return (
            <div
              key={item.id}
              className="recent-row group"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                borderTop: i === 0 ? "none" : "1px solid var(--color-border-default)",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
                transition: "background 0.15s",
              }}
              onClick={() => !busy && !editing && onOpen(item)}
            >
              <span style={{ flexShrink: 0, display: "flex" }}>
                {busy ? <Spinner /> : <KindIcon kind={item.kind} color={item.brandColor} />}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                {editing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(item);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    style={{
                      width: "100%",
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--color-t-primary)",
                      background: "var(--color-surface-input)",
                      border: "1px solid var(--color-accent)",
                      borderRadius: "var(--radius-input)",
                      padding: "2px 6px",
                      fontFamily: "inherit",
                      outline: "none",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--color-t-primary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setDraft(item.name);
                      setEditingId(item.id);
                    }}
                    title="Double-click to rename"
                  >
                    {item.name}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--color-t-tertiary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {middle(item.subtitle)}
                  {item.meta ? <span style={{ opacity: 0.7 }}> · {item.meta}</span> : null}
                </div>
              </div>

              {/* Hover actions */}
              <div
                className="recent-actions"
                style={{ display: "flex", gap: 4, flexShrink: 0 }}
                onClick={(e) => e.stopPropagation()}
              >
                {onRefresh && REFRESHABLE.has(item.kind) && (
                  <IconButton
                    title="Refresh schema"
                    onClick={() => onRefresh(item)}
                    disabled={busy}
                  >
                    <RefreshGlyph />
                  </IconButton>
                )}
                <IconButton title="Remove" onClick={() => onRemove(item)} disabled={busy}>
                  <CloseGlyph />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="recent-action-btn"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        borderRadius: 6,
        border: "none",
        background: "transparent",
        color: "var(--color-t-tertiary)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

function KindIcon({ kind, color }: { kind: RecentItemKind; color?: string }) {
  const c = "var(--color-t-secondary)";
  const stroke = { fill: "none", stroke: c, strokeWidth: 1.8 } as const;
  if (kind === "manifest") {
    // A catalog: three stacked layers.
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} width={16} height={16}>
        <path d="M12 3l9 4.5-9 4.5-9-4.5L12 3z" />
        <path d="M3 12l9 4.5 9-4.5" />
        <path d="M3 16.5L12 21l9-4.5" />
      </svg>
    );
  }
  if (kind === "remote-parquet") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M17.5 19a4.5 4.5 0 000-9 6 6 0 00-11.6 1.5A3.5 3.5 0 006.5 19z" />
      </svg>
    );
  }
  if (kind === "local-folder") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      </svg>
    );
  }
  if (kind === "warehouse") {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color ?? c}
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
        <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
      </svg>
    );
  }
  // upload / local-file → a file glyph
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="var(--color-border-default)" strokeWidth="3" />
      <path
        d="M22 12a10 10 0 00-10-10"
        stroke="var(--color-accent)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
