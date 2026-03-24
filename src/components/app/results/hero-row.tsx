"use client";

import { useEffect, useRef } from "react";

interface HeroRowProps {
  value: string;
  numericValue?: number;
  label: string;
  trend?: string;
  sparkData?: number[];
}

export function HeroRow({ value, numericValue, label, trend, sparkData }: HeroRowProps) {
  const numberRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (numericValue == null || !numberRef.current) return;
    const el = numberRef.current;
    const suffix = value.endsWith("%") ? "%" : "";
    const duration = 800;
    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = eased * numericValue!;
      el.textContent = current.toFixed(1) + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }

    el.textContent = "0" + suffix;
    requestAnimationFrame(tick);
  }, [numericValue, value]);

  const maxSpark = sparkData ? Math.max(...sparkData) : 1;

  return (
    <div
      className="flex flex-row items-center w-full"
      style={{
        background: "var(--color-hero-bg)",
        borderRadius: "var(--radius-card)",
        padding: 32,
      }}
    >
      <div className="flex flex-col" style={{ flex: 3 }}>
        <div
          ref={numberRef}
          style={{
            fontSize: 56,
            fontWeight: "var(--font-heading-weight)" as never,
            color: "var(--color-accent)",
            lineHeight: 1,
          }}
        >
          {value}
        </div>
        <div style={{ fontSize: 16, color: "var(--color-t-secondary)", marginTop: 6 }}>{label}</div>
      </div>

      <div className="flex flex-col items-end" style={{ flex: 2, gap: 8 }}>
        {sparkData && (
          <div className="flex flex-row items-end" style={{ gap: 4, height: 40 }}>
            {sparkData.map((d, i) => (
              <div
                key={i}
                style={{
                  width: 6,
                  borderRadius: 2,
                  background: "var(--color-accent)",
                  height: (d / maxSpark) * 40,
                }}
              />
            ))}
          </div>
        )}
        {trend && (
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-accent)" }}>
            {trend}
          </span>
        )}
      </div>
    </div>
  );
}
