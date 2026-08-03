"use client";

import { Suspense, lazy, type ComponentType, type ReactNode } from "react";

/**
 * Framework-free replacement for next/dynamic({ ssr: false }) (modularization
 * M5-5c): React.lazy + Suspense, with the same client-only guarantee — the
 * loader NEVER runs during server rendering (plotly/deck.gl/globe touch
 * `self`/`window` at import time), the fallback renders instead.
 *
 * The fallback carries data-testid="lazy-loading" so the render smoke suite
 * can await settlement of every lazy chart.
 */
export function clientLazy<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null
): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: await load() }));
  const wrapped = <span data-testid="lazy-loading">{fallback}</span>;
  function ClientLazy(props: P) {
    if (typeof window === "undefined") return wrapped;
    return (
      <Suspense fallback={wrapped}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return ClientLazy;
}
