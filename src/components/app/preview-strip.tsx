"use client";

/**
 * Payoff preview strip (extracted from page.tsx, ARCH-5): two real
 * Hermetic-generated dashboards (light + dark) shown as framed thumbnails so
 * a first-time visitor sees the output before committing data.
 */
import Image from "next/image";

const PREVIEWS = [
  {
    src: "/previews/dashboard-light.png",
    alt: "Generated dashboard: scatter, radar, and a statistical test",
    w: 1100,
    h: 557,
  },
  {
    src: "/previews/dashboard-dark.png",
    alt: "Generated sales dashboard with KPIs, filters, and charts",
    w: 900,
    h: 620,
  },
] as const;

export function PreviewStrip() {
  return (
    <div className="flex w-full flex-col items-center gap-2" style={{ maxWidth: 700 }}>
      <div
        className="source-cards-grid grid w-full"
        style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}
      >
        {PREVIEWS.map((p) => (
          <div
            key={p.src}
            style={{
              overflow: "hidden",
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-border-default)",
              boxShadow: "var(--shadow-card)",
            }}
          >
            <Image
              src={p.src}
              alt={p.alt}
              width={p.w}
              height={p.h}
              unoptimized
              sizes="(max-width: 767px) 100vw, 342px"
              style={{
                display: "block",
                width: "100%",
                height: 200,
                objectFit: "cover",
                objectPosition: "center",
              }}
            />
          </div>
        ))}
      </div>
      <span className="text-t-tertiary" style={{ fontSize: 12 }}>
        Real dashboards generated from one question — charts, stats, and narrative.
      </span>
    </div>
  );
}
