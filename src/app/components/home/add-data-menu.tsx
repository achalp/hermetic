"use client";

import type { RecentItem } from "@/app/components/recent-sources";

export interface SavedConnectionItem {
  id: string;
  name: string;
  /** Engine brand color for the kind dot (falls back to accent). */
  brandColor?: string;
}

interface AddDataMenuProps {
  /** Unified recents (files, local/cloud paths, warehouses), newest first. */
  recents: RecentItem[];
  /** Saved warehouse connections — the full set, recent or not. */
  savedConnections: SavedConnectionItem[];
  onOpenRecent: (item: RecentItem) => void;
  onUpload: () => void;
  onLocalBrowse: () => void;
  onNewWarehouse: () => void;
  onSavedConnect: (id: string) => void;
  onSample: () => void;
  /** Called after any choice so the owning popover can close. */
  onPicked: () => void;
}

const MAX_RECENTS = 3;

/**
 * The single "Add data" menu: every way into the product, in priority order.
 * Recent (fast resume) → Add new (upload / local & cloud / warehouse, with
 * saved connections nested one level inside the warehouse door) → Sample.
 * Recents answer "continue where I left off"; saved answers "which of my
 * warehouses" — a connection can be both, and neither costs a page row.
 */
export function AddDataMenu({
  recents,
  savedConnections,
  onOpenRecent,
  onUpload,
  onLocalBrowse,
  onNewWarehouse,
  onSavedConnect,
  onSample,
  onPicked,
}: AddDataMenuProps) {
  const pick = (fn: () => void) => () => {
    fn();
    onPicked();
  };
  const topRecents = recents.slice(0, MAX_RECENTS);

  return (
    <div role="menu" aria-label="Add data" className="p-1.5" style={{ minWidth: 330 }}>
      {topRecents.length > 0 && (
        <>
          <GroupHeading>Recent</GroupHeading>
          {topRecents.map((item) => (
            <MenuItem key={`${item.kind}:${item.id}`} onClick={pick(() => onOpenRecent(item))}>
              <KindDot brandColor={item.brandColor} kind={item.kind} />
              <span className="min-w-0 flex-1 truncate text-left font-medium text-t-primary text-sm">
                {item.name}
              </span>
              {item.meta && <Meta>{item.meta}</Meta>}
            </MenuItem>
          ))}
          <Separator />
          <GroupHeading>Add new</GroupHeading>
        </>
      )}

      <MenuItem onClick={pick(onUpload)}>
        <ActionIcon>
          <UploadIcon />
        </ActionIcon>
        <ItemText
          title="Upload a file"
          detail="CSV · Excel · JSON · GeoJSON — or drop it anywhere"
        />
      </MenuItem>

      <MenuItem onClick={pick(onLocalBrowse)}>
        <ActionIcon>
          <FolderIcon />
        </ActionIcon>
        <ItemText title="Local & cloud files" detail="Parquet · S3/HTTPS — zero-copy" />
      </MenuItem>

      <MenuItem onClick={pick(onNewWarehouse)}>
        <ActionIcon>
          <DatabaseIcon />
        </ActionIcon>
        <ItemText
          title="Connect a warehouse"
          detail="Postgres · BigQuery · ClickHouse · Trino · Hive"
        />
      </MenuItem>

      {savedConnections.length > 0 && (
        <div
          role="group"
          aria-label="Saved connections"
          className="border-l-2 border-border-default"
          style={{ margin: "0 6px 4px 47px", paddingLeft: 6 }}
        >
          {savedConnections.map((c) => (
            <MenuItem key={c.id} compact onClick={pick(() => onSavedConnect(c.id))}>
              <KindDot brandColor={c.brandColor} kind="warehouse" />
              <span className="min-w-0 flex-1 truncate text-left text-sm text-t-primary">
                {c.name}
              </span>
              <Meta>saved</Meta>
            </MenuItem>
          ))}
        </div>
      )}

      <MenuItem onClick={pick(onSample)}>
        <ActionIcon>
          <SparkleIcon />
        </ActionIcon>
        <ItemText title="Use the sample dataset" detail="Ready now — nothing to set up" />
      </MenuItem>
    </div>
  );
}

/* ── Presentational bits ──────────────────────────────────────────── */

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-t-tertiary uppercase"
      style={{ fontSize: 11, letterSpacing: 0.5, padding: "8px 12px 4px" }}
    >
      {children}
    </div>
  );
}

function Separator() {
  return (
    <div
      role="presentation"
      className="bg-border-default"
      style={{ height: 1, margin: "5px 8px" }}
    />
  );
}

function MenuItem({
  children,
  onClick,
  compact,
}: {
  children: React.ReactNode;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-3 border-none bg-transparent text-left transition-colors hover:bg-surface-2"
      style={{
        minHeight: compact ? 40 : 42,
        padding: compact ? "6px 10px" : "7px 12px",
        borderRadius: "calc(var(--radius-card) - 4px)",
      }}
    >
      {children}
    </button>
  );
}

function ItemText({ title, detail }: { title: string; detail: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-semibold text-t-primary">{title}</span>
      <span className="block truncate text-t-tertiary" style={{ fontSize: 12 }}>
        {detail}
      </span>
    </span>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 text-t-tertiary" style={{ fontSize: 11.5 }}>
      {children}
    </span>
  );
}

function KindDot({ brandColor, kind }: { brandColor?: string; kind: string }) {
  return (
    <span
      aria-hidden
      title={kind}
      className="shrink-0 rounded-full"
      style={{ width: 9, height: 9, background: brandColor ?? "var(--color-accent)" }}
    />
  );
}

function ActionIcon({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center"
      style={{
        width: 30,
        height: 30,
        borderRadius: "calc(var(--radius-card) - 4px)",
        background: "var(--color-accent-subtle)",
        color: "var(--color-accent-text)",
      }}
    >
      {children}
    </span>
  );
}

const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
} as const;

function UploadIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 16V4m0 0l-4 4m4-4l4 4" />
      <path d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg {...iconProps}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </svg>
  );
}
