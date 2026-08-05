"use client";

interface SampleSectionProps {
  columns: string[];
  rows: string[][];
}

export function SampleSection({ columns, rows }: SampleSectionProps) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--color-surface-dark-text4)",
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--color-surface-dark-2)",
                  textAlign: "left",
                  fontWeight: 500,
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 3).map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    fontSize: 12,
                    color: "var(--color-surface-dark-text2)",
                    padding: "5px 10px",
                    borderBottom: "1px solid var(--color-surface-dark-2)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
