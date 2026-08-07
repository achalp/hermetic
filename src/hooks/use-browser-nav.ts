"use client";

/**
 * Browser-history integration for the page's state machine (2026-08-07).
 *
 * STRUCTURAL CONTRACT: navigation state is expressed as an ADDRESS — a
 * descriptor carrying every key needed to reconstruct the view in a fresh
 * session — never as a bare view label. The hook builds URLs only from
 * addresses, so a view without its reconstruction keys is visibly
 * transitional (bare ?view=...) and upgrades IN PLACE (replaceState, same
 * stack position) the moment its key arrives — e.g. a live analysis's
 * results URL becomes ?restore=<historyId> when the background save
 * returns. Pasting any upgraded URL into a new session reconstructs the
 * view via use-history-restore's mount-time branches:
 *
 *   home     /
 *   data     /?view=data&csv=<csvId>
 *   results  /?restore=<historyId>          (canonical, fully addressed)
 *            /?view=results&csv=<csvId>     (transitional, pre-save)
 *
 * Back/forward walk the app's own transitions (results → data → home);
 * transitional overlays (analyzing, loading) are never recorded.
 */
import { useEffect, useRef } from "react";

export type PageAddress =
  | { view: "home" }
  | { view: "data"; csvId?: string | null }
  | { view: "results"; entryId?: string | null; csvId?: string | null };

export type PageView = PageAddress["view"];

function buildUrl(addr: PageAddress): string {
  switch (addr.view) {
    case "home":
      return window.location.pathname;
    case "data":
      return addr.csvId ? `?view=data&csv=${encodeURIComponent(addr.csvId)}` : "?view=data";
    case "results":
      if (addr.entryId) return `?restore=${encodeURIComponent(addr.entryId)}`;
      return addr.csvId ? `?view=results&csv=${encodeURIComponent(addr.csvId)}` : "?view=results";
  }
}

export function useBrowserNav(args: {
  address: PageAddress;
  /** Transitions the state machine BACKWARD to match a popped entry. */
  onPopTo: (view: PageView) => void;
  /** True while transitional overlays (analyzing, loading) are up — don't
   *  record those as history entries. */
  suspended?: boolean;
}): void {
  const { address, onPopTo, suspended } = args;
  const lastView = useRef<PageView | null>(null);
  const lastUrl = useRef<string | null>(null);
  const popping = useRef(false);
  const onPopRef = useRef(onPopTo);
  onPopRef.current = onPopTo;

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const target = ((e.state as { hermeticView?: PageView } | null)?.hermeticView ??
        "home") as PageView;
      popping.current = true;
      lastView.current = target;
      lastUrl.current = null;
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
    const url = buildUrl(address);
    if (lastView.current === address.view && lastUrl.current === url) return;
    const state = { hermeticView: address.view };
    if (lastView.current === null) {
      // First render: adopt the current entry instead of stacking a new one.
      // Never clobber a deep-link URL (?restore=...) with a weaker address.
      if (!window.location.search.includes("restore=")) {
        window.history.replaceState(state, "", url);
      }
    } else if (lastView.current === address.view) {
      // Same view, better address (the history id arrived): upgrade the
      // CURRENT entry in place — no new stack position.
      window.history.replaceState(state, "", url);
    } else {
      window.history.pushState(state, "", url);
    }
    lastView.current = address.view;
    lastUrl.current = url;
  }, [address, suspended]);
}
