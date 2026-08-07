"use client";

/**
 * Browser-history integration for the page's state machine (2026-08-07).
 *
 * The app's home → data → results transitions were pure React state: the
 * back button left the app entirely instead of walking the transitions,
 * and no view was URL-addressable. This hook mirrors the CURRENT view
 * into history entries (pushState on forward transitions, popstate to
 * walk back) and keeps the URL meaningful:
 *
 *   home     /
 *   data     /?view=data
 *   results  /?view=results[&restore=<historyId>]
 *
 * `restore` reuses the EXISTING deep-link param (use-history-restore.ts),
 * so a copied results URL for a saved analysis reloads it on a fresh
 * visit. Forward-restoring an UNSAVED in-flight result after backing out
 * of it is not attempted — back semantics and addressability are the
 * contract here, not time travel.
 */
import { useEffect, useRef } from "react";

export type PageView = "home" | "data" | "results";

export function useBrowserNav(args: {
  view: PageView;
  /** History id when the shown results came from a saved/history entry. */
  restoreId?: string | null;
  /** Transitions the state machine BACKWARD to match a popped entry. */
  onPopTo: (view: PageView) => void;
  /** True while transitional overlays (analyzing, loading) are up — don't
   *  record those as history entries. */
  suspended?: boolean;
}): void {
  const { view, restoreId, onPopTo, suspended } = args;
  const lastPushed = useRef<PageView | null>(null);
  const popping = useRef(false);
  const onPopRef = useRef(onPopTo);
  onPopRef.current = onPopTo;

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const target = ((e.state as { hermeticView?: PageView } | null)?.hermeticView ??
        "home") as PageView;
      popping.current = true;
      lastPushed.current = target;
      onPopRef.current(target);
      // Release after React applies the popped state so the mirror effect
      // below doesn't re-push the entry we just returned to.
      setTimeout(() => {
        popping.current = false;
      }, 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (suspended || popping.current) return;
    if (lastPushed.current === view) return;
    const url =
      view === "home"
        ? window.location.pathname
        : view === "data"
          ? "?view=data"
          : `?view=results${restoreId ? `&restore=${encodeURIComponent(restoreId)}` : ""}`;
    const state = { hermeticView: view };
    if (lastPushed.current === null) {
      // First render: adopt the current entry instead of stacking a new one.
      window.history.replaceState(state, "", url);
    } else {
      window.history.pushState(state, "", url);
    }
    lastPushed.current = view;
  }, [view, restoreId, suspended]);
}
