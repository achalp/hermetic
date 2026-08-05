"use client";

/**
 * Recent sources (uploads / local / cloud) — the file/cloud analogue of saved
 * warehouse connections (extracted from page.tsx, exit audit F1). Loaded on
 * mount; recorded server-side on every connect, so we just refetch after each
 * open/remove. Warehouses are merged in from the warehouse hook for one
 * unified "Recent" list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RecentItem } from "@/app/components/recent-sources";
import { getRecentSources, type RecentSourceInfo } from "@/app/lib/api";
import { RECENTS_CHANGED_EVENT } from "@/lib/constants";
import { relTimeAgo } from "@/lib/rel-time";
import { ENGINES } from "@/lib/warehouse/engine-descriptor";
import type { useWarehouse } from "@/hooks/use-warehouse";
import type { RemoteParquetCreds } from "@/app/lib/api";

/** Compact row count for a recent-source subtitle: 2547927232 → "2.5B". */
function fmtRowCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

interface UseRecentsListArgs {
  warehouse: ReturnType<typeof useWarehouse>;
  handleRemoteFileSelect: (
    url: string,
    creds: RemoteParquetCreds | undefined,
    force?: boolean
  ) => Promise<void>;
  handleLocalFileSelect: (path: string, kind: "file" | "folder") => Promise<void>;
}

export function useRecentsList({
  warehouse,
  handleRemoteFileSelect,
  handleLocalFileSelect,
}: UseRecentsListArgs) {
  const [recents, setRecents] = useState<RecentSourceInfo[]>([]);
  const refetchRecents = useCallback(() => {
    void getRecentSources().then(setRecents);
  }, []);
  useEffect(() => refetchRecents(), [refetchRecents]);
  // Stay in sync with renames/removals made in Settings → Recent sources.
  useEffect(() => {
    window.addEventListener(RECENTS_CHANGED_EVENT, refetchRecents);
    return () => window.removeEventListener(RECENTS_CHANGED_EVENT, refetchRecents);
  }, [refetchRecents]);

  const recentItems = useMemo<RecentItem[]>(() => {
    const files = recents.map((r) => ({
      ts: r.lastUsedAt,
      item: {
        id: r.id,
        kind: r.kind,
        name: r.name,
        subtitle: r.subtitle,
        meta: [r.rows != null ? `${fmtRowCount(r.rows)} rows` : null, relTimeAgo(r.lastUsedAt)]
          .filter(Boolean)
          .join(" · "),
      } as RecentItem,
    }));
    const whs = warehouse.savedConnections.map((c) => ({
      ts: c.createdAt,
      item: {
        id: c.id,
        kind: "warehouse" as const,
        name: c.name ?? c.label,
        subtitle: "host" in c.config ? c.config.host : c.config.type,
        meta: relTimeAgo(c.createdAt),
        brandColor: ENGINES[c.config.type]?.brandColor,
      } as RecentItem,
    }));
    return [...files, ...whs].sort((a, b) => b.ts.localeCompare(a.ts)).map((x) => x.item);
  }, [recents, warehouse.savedConnections]);

  // Re-open (or refresh) a remembered source. Uploads re-open from their managed
  // byte copy (a file under ~/.hermetic), so they route through the same local-
  // file path as an on-disk file.
  const reopenRecent = useCallback(
    async (item: RecentItem, force = false) => {
      try {
        if (item.kind === "warehouse") {
          const saved = warehouse.savedConnections.find((c) => c.id === item.id);
          if (saved) await warehouse.connect(saved.config, force);
          return;
        }
        const src = recents.find((r) => r.id === item.id);
        if (!src) return;
        if (src.kind === "remote-parquet" && src.url) {
          await handleRemoteFileSelect(src.url, src.creds, force);
        } else if (src.kind === "local-folder" && src.path) {
          await handleLocalFileSelect(src.path, "folder");
        } else if (src.path) {
          await handleLocalFileSelect(src.path, "file");
        }
      } finally {
        refetchRecents();
      }
    },
    [recents, warehouse, handleRemoteFileSelect, handleLocalFileSelect, refetchRecents]
  );

  return { recentItems, reopenRecent };
}
