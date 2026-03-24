"use client";

interface WorkingIndicatorProps {
  status: string;
}

export function WorkingIndicator({ status }: WorkingIndicatorProps) {
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ minHeight: "calc(100vh - 56px)", gap: 16 }}
    >
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div className="flex flex-row items-center" style={{ gap: 6 }}>
        {[0, 0.2, 0.4].map((delay, i) => (
          <div
            key={i}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--color-accent)",
              animation: `pulse 1.2s ease-in-out infinite`,
              animationDelay: `${delay}s`,
            }}
          />
        ))}
      </div>
      <p
        style={{
          fontSize: 14,
          color: "var(--color-t-secondary)",
          textAlign: "center",
          margin: 0,
        }}
      >
        {status}
      </p>
    </div>
  );
}
