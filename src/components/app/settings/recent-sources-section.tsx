"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getRecentSources,
  removeRecentSource,
  renameRecentSource,
  clearRecentSources,
  type RecentSourceInfo,
} from "@/lib/api";
import { relTimeAgo } from "@/lib/rel-time";

/**
 * Fired on window after any recents mutation here, so the home page's
 * Add-data menu can refetch instead of showing a stale list.
 */
import { RECENTS_CHANGED_EVENT } from "@/lib/constants";

const KIND_LABEL: Record<RecentSourceInfo["kind"], string> = {
  upload: "upload",
  "local-file": "local file",
  "local-folder": "folder",
  "remote-parquet": "cloud",
};

/**
 * Management view for recent file/cloud sources (rename / remove / clear all).
 * The home page's Add-data menu is attach-only; the full list with management
 * lives here. Warehouse recents are managed via Saved connections above.
 * Self-contained (fetches on mount) so the drawer needs no new prop threading.
 */
export function RecentSourcesSection() {
  const [recents, setRecents] = useState<RecentSourceInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    void getRecentSources().then((r) => {
      setRecents(r);
      setLoaded(true);
    });
  }, []);
  useEffect(() => refresh(), [refresh]);

  const notifyChanged = useCallback(() => {
    window.dispatchEvent(new Event(RECENTS_CHANGED_EVENT));
  }, []);

  const handleRemove = useCallback(
    async (id: string) => {
      await removeRecentSource(id);
      refresh();
      notifyChanged();
    },
    [refresh, notifyChanged]
  );

  const handleRename = useCallback(
    async (id: string, name: string) => {
      await renameRecentSource(id, name);
      refresh();
      notifyChanged();
    },
    [refresh, notifyChanged]
  );

  const handleClearAll = useCallback(async () => {
    await clearRecentSources();
    refresh();
    notifyChanged();
  }, [refresh, notifyChanged]);

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "0 0 6px",
        }}
      >
        <p
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--color-surface-dark-text3)",
            margin: 0,
          }}
        >
          Recent sources
        </p>
        {recents.length > 0 && (
          <button
            onClick={handleClearAll}
            style={{
              background: "none",
              border: "none",
              fontSize: 11,
              color: "#f87171" /* fixed red on always-dark drawer */,
              cursor: "pointer",
              padding: 0,
            }}
            title="Clear all recent file and cloud sources (saved connections stay)"
          >
            Clear all
          </button>
        )}
      </div>

      {loaded && recents.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--color-surface-dark-text4)", margin: 0 }}>
          No recent files or cloud sources.
        </p>
      )}

      {recents.map((src) => (
        <RecentRow
          key={src.id}
          src={src}
          onRemove={() => handleRemove(src.id)}
          onRename={(name) => handleRename(src.id, name)}
        />
      ))}
    </div>
  );
}

function RecentRow({
  src,
  onRemove,
  onRename,
}: {
  src: RecentSourceInfo;
  onRemove: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(src.name);
  const dirty = nameDraft.trim() !== "" && nameDraft.trim() !== src.name;

  return (
    <div style={{ borderTop: "1px solid var(--color-surface-dark-3)", padding: "8px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 13,
          color: "var(--color-surface-dark-text2)",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {src.name}{" "}
          <span style={{ fontSize: 12, color: "var(--color-surface-dark-text4)" }}>
            {KIND_LABEL[src.kind]} · {relTimeAgo(src.lastUsedAt)}
          </span>
        </span>
        <span style={{ display: "flex", gap: 12, flexShrink: 0 }}>
          <button
            onClick={() => setEditing((v) => !v)}
            style={{
              background: "none",
              border: "none",
              fontSize: 11,
              color: "var(--color-surface-dark-text3)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {editing ? "Cancel" : "Rename"}
          </button>
          <button
            onClick={onRemove}
            style={{
              background: "none",
              border: "none",
              fontSize: 11,
              color: "#f87171" /* fixed red on always-dark drawer */,
              cursor: "pointer",
              padding: 0,
            }}
            title="Remove from recents"
          >
            Remove
          </button>
        </span>
      </div>

      {editing && (
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <label htmlFor={`recent-rename-${src.id}`} className="sr-only">
            New name for {src.name}
          </label>
          <input
            id={`recent-rename-${src.id}`}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={src.name}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--color-surface-dark-3)",
              background: "var(--color-surface-dark-1)",
              color: "var(--color-surface-dark-text)",
              fontSize: 12,
              outline: "none",
            }}
          />
          <button
            onClick={() => {
              onRename(nameDraft.trim());
              setEditing(false);
            }}
            disabled={!dirty}
            style={{
              fontSize: 12,
              padding: "5px 12px",
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              background: "none",
              borderRadius: "var(--radius-button)",
              cursor: dirty ? "pointer" : "not-allowed",
              opacity: dirty ? 1 : 0.5,
            }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
