"use client";

interface ProfileStripProps {
  items: string[];
}

export function ProfileStrip({ items }: ProfileStripProps) {
  return (
    <div className="flex flex-row items-center justify-center flex-wrap gap-0">
      {items.map((item, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && (
            <span className="px-0" style={{ color: "var(--color-border-default)" }}>
              |
            </span>
          )}
          <span
            style={{
              fontSize: 13,
              color: "var(--color-t-secondary)",
              padding: "0 10px",
            }}
          >
            {item}
          </span>
        </span>
      ))}
    </div>
  );
}
