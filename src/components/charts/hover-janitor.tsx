"use client";

import { useEffect } from "react";

/**
 * Dismisses hover bubbles stranded by scroll. Browsers fire no mouse events
 * when content scrolls under a stationary pointer, so a Plotly hover label or
 * a nivo slice tooltip stays pinned to a chart the pointer is no longer over
 * until the next mousemove happens to cross it. This tracks the pointer and,
 * on scroll, dispatches the leave event each chart library was waiting for
 * whenever an open bubble's chart is no longer under the pointer.
 */
export function HoverJanitor() {
  useEffect(() => {
    let px = -1;
    let py = -1;
    let raf = 0;

    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
    };

    const outside = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return px < r.left || px > r.right || py < r.top || py > r.bottom;
    };

    const leave = (el: Element) => {
      // relatedTarget outside the chart subtree makes React's enter/leave
      // plugin (nivo) and Plotly's fx module both treat this as a real exit.
      el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      el.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: document.body }));
    };

    const sweep = () => {
      raf = 0;
      if (px < 0) return;
      // Plotly: an open label lives in g.hoverlayer; the drag rect owns the
      // hover listeners.
      for (const gd of document.querySelectorAll(".js-plotly-plot")) {
        if (!gd.querySelector("g.hoverlayer g.hovertext")) continue;
        const drag = gd.querySelector("rect.nsewdrag");
        if (drag && outside(drag)) leave(drag);
      }
      // Nivo: an open tooltip is an absolutely positioned pointer-events-none
      // div (zIndex 10) next to the chart svg; the interaction capture rects
      // (slice columns / mesh) carry the React leave handlers.
      for (const tip of document.querySelectorAll<HTMLElement>("div")) {
        if (tip.style.zIndex !== "10" || tip.style.pointerEvents !== "none") continue;
        if (tip.style.position !== "absolute" || tip.children.length === 0) continue;
        const svg = tip.parentElement?.querySelector("svg");
        if (!svg || svg.closest(".js-plotly-plot") || !outside(svg)) continue;
        for (const rect of svg.querySelectorAll("rect")) {
          // Nivo's interaction layers: the full-size transparent capture rect
          // and the invisible per-slice column rects.
          if (
            rect.getAttribute("fill") === "transparent" ||
            rect.getAttribute("fill-opacity") === "0"
          ) {
            leave(rect);
          }
        }
      }
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(sweep);
    };

    window.addEventListener("pointermove", onMove, { passive: true, capture: true });
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener("pointermove", onMove, { capture: true } as EventListenerOptions);
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return null;
}
