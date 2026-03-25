"use client";

interface SourceCardsProps {
  onFileDrop: () => void;
  onWarehouseClick: () => void;
}

const cardBase =
  "source-card-hover flex flex-col items-center gap-3 cursor-pointer text-center transition-all duration-200";

export function SourceCards({ onFileDrop, onWarehouseClick }: SourceCardsProps) {
  return (
    <div
      className="source-cards-grid grid w-full"
      style={{ gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 700 }}
    >
      {/* Upload a file */}
      <button
        onClick={onFileDrop}
        className={cardBase}
        style={{
          background: "var(--color-surface-1)",
          border: "2px dashed var(--color-border-default)",
          borderRadius: "var(--radius-card)",
          padding: "40px 32px",
        }}
      >
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 48, height: 48, background: "var(--color-accent)" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            width="22"
            height="22"
            style={{ color: "white" }}
          >
            <path d="M12 16V4m0 0l-4 4m4-4l4 4" />
            <path d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" />
          </svg>
        </div>
        <span style={{ fontSize: 16, fontWeight: 600, color: "var(--color-t-primary)" }}>
          Upload a file
        </span>
        <span style={{ fontSize: 13, color: "var(--color-t-secondary)" }}>
          CSV &middot; Excel &middot; JSON &middot; GeoJSON
        </span>
      </button>

      {/* Connect a warehouse */}
      <button
        onClick={onWarehouseClick}
        className={cardBase}
        style={{
          background: "var(--color-surface-1)",
          border: "2px solid var(--color-border-default)",
          borderRadius: "var(--radius-card)",
          padding: "40px 32px",
        }}
      >
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 48, height: 48, background: "var(--color-accent)" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            width="22"
            height="22"
            style={{ color: "white" }}
          >
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
            <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
          </svg>
        </div>
        <span style={{ fontSize: 16, fontWeight: 600, color: "var(--color-t-primary)" }}>
          Connect a warehouse
        </span>
        <span style={{ fontSize: 13, color: "var(--color-t-secondary)" }}>
          PostgreSQL &middot; BigQuery &middot; ClickHouse &middot; Trino &middot; Hive
        </span>
      </button>
    </div>
  );
}
