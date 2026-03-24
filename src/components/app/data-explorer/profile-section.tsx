"use client";

interface ProfileSectionProps {
  chips: string[];
  distributions: { name: string; percent: number; range: string }[];
}

export function ProfileSection({ chips, distributions }: ProfileSectionProps) {
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {chips.map((chip) => (
          <span
            key={chip}
            style={{
              fontSize: 12,
              padding: "3px 8px",
              borderRadius: 4,
              background: "var(--color-surface-dark-2)",
              color: "var(--color-surface-dark-text2)",
            }}
          >
            {chip}
          </span>
        ))}
      </div>
      {distributions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {distributions.map((d) => (
            <div key={d.name} style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <span
                style={{
                  fontSize: 13,
                  color: "var(--color-surface-dark-text3)",
                  width: 80,
                  flexShrink: 0,
                }}
              >
                {d.name}
              </span>
              <div
                style={{
                  flex: 1,
                  height: 6,
                  background: "var(--color-surface-dark-2)",
                  borderRadius: 3,
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${d.percent}%`,
                    background: "var(--color-accent)",
                    borderRadius: 3,
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--color-surface-dark-text4)",
                  marginLeft: 8,
                  whiteSpace: "nowrap",
                }}
              >
                {d.range}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
