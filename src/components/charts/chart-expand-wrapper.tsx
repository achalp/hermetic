"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyChartToClipboard, downloadChartAsPng } from "@/lib/export-utils";

interface ChartExpandWrapperProps {
  title?: string | null;
  children: ReactNode;
}

/* -- Icon components ----------------------------------------- */

function ClipboardIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="2" width="6" height="3" rx="1" />
      <path d="M5 3H4a1 1 0 00-1 1v9a1 1 0 001 1h8a1 1 0 001-1V4a1 1 0 00-1-1h-1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 8 7 11 12 5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2v8M4 7l4 4 4-4" />
      <path d="M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="10 2 14 2 14 6" />
      <polyline points="6 14 2 14 2 10" />
      <line x1="14" y1="2" x2="9.5" y2="6.5" />
      <line x1="2" y1="14" x2="6.5" y2="9.5" />
    </svg>
  );
}

const btnBase =
  "p-1.5 text-t-secondary shadow-sm backdrop-blur transition-opacity hover:text-t-primary bg-surface-btn/80 hover:bg-surface-btn";

const hoverVisible = "opacity-0 group-hover:opacity-100";

export function ChartExpandWrapper({ title, children }: ChartExpandWrapperProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setExpanded(false), []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [expanded, close]);

  const handleCopy = useCallback(async (el: HTMLElement | null) => {
    if (!el) return;
    try {
      await copyChartToClipboard(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Copy failed:", e);
    }
  }, []);

  const handleDownload = useCallback(
    async (el: HTMLElement | null) => {
      if (!el) return;
      try {
        await downloadChartAsPng(el, title ?? "chart");
      } catch (e) {
        console.error("Download failed:", e);
      }
    },
    [title]
  );

  return (
    <div className="group relative flex-1 min-w-0">
      <div ref={chartRef}>{children}</div>

      {/* Action buttons -- visible on hover */}
      <div className={`absolute right-2 top-2 z-10 flex items-center gap-1 ${hoverVisible}`}>
        <button
          type="button"
          onClick={() => handleCopy(chartRef.current)}
          className={btnBase}
          style={{ borderRadius: "var(--radius-badge)" }}
          aria-label={copied ? "Copied" : "Copy chart to clipboard"}
        >
          {copied ? <CheckIcon /> : <ClipboardIcon />}
        </button>
        <button
          type="button"
          onClick={() => handleDownload(chartRef.current)}
          className={btnBase}
          style={{ borderRadius: "var(--radius-badge)" }}
          aria-label="Download chart as PNG"
        >
          <DownloadIcon />
        </button>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={btnBase}
          style={{ borderRadius: "var(--radius-badge)" }}
          aria-label="Expand chart"
        >
          <ExpandIcon />
        </button>
      </div>

      {/* Fullscreen overlay */}
      {expanded &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex flex-col bg-black/50 backdrop-blur-sm"
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              className="theme-card mx-auto flex w-full max-w-[95vw] flex-1 flex-col overflow-hidden my-6 max-h-[calc(100vh-48px)]"
              style={{
                background: "var(--bg-panel)",
                borderRadius: "var(--radius-card)",
                boxShadow: "var(--shadow-elevated)",
              }}
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border-default px-4 py-3">
                <h2
                  className="text-t-secondary"
                  style={{
                    fontSize: "var(--chart-title-size)",
                    fontWeight: "var(--chart-title-weight)",
                  }}
                >
                  {title || "Chart"}
                </h2>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleCopy(chartRef.current)}
                    className="p-1.5 text-t-tertiary transition-colors hover:bg-surface-btn hover:text-t-primary"
                    style={{
                      borderRadius: "var(--radius-badge)",
                      transitionDuration: "var(--transition-speed)",
                    }}
                    aria-label={copied ? "Copied" : "Copy chart to clipboard"}
                  >
                    {copied ? <CheckIcon /> : <ClipboardIcon />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownload(chartRef.current)}
                    className="p-1.5 text-t-tertiary transition-colors hover:bg-surface-btn hover:text-t-primary"
                    style={{
                      borderRadius: "var(--radius-badge)",
                      transitionDuration: "var(--transition-speed)",
                    }}
                    aria-label="Download chart as PNG"
                  >
                    <DownloadIcon />
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    className="p-1.5 text-t-tertiary transition-colors hover:bg-surface-btn hover:text-t-primary"
                    style={{
                      borderRadius: "var(--radius-badge)",
                      transitionDuration: "var(--transition-speed)",
                    }}
                    aria-label="Close"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <line x1="4" y1="4" x2="12" y2="12" />
                      <line x1="12" y1="4" x2="4" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Chart area */}
              <div className="flex-1 overflow-auto" style={{ padding: "var(--padding-card)" }}>
                <div className="h-full w-full min-h-[70vh]">{children}</div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
