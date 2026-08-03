"use client";

import React, { createContext, useContext, type ReactNode } from "react";

/**
 * Repeat scope value provided to child elements inside a repeated element.
 */
export interface RepeatScopeValue {
  /** The current array item object */
  item: unknown;
  /** Index of the current item in the array */
  index: number;
  /** Absolute state path to the current array item (e.g. "/todos/0") — used for statePath two-way binding */
  basePath: string;
}

const RepeatScopeContext = createContext<RepeatScopeValue | null>(null);

/**
 * Provides repeat scope to child elements so $item and $index expressions resolve correctly.
 */
export function RepeatScopeProvider({
  item,
  index,
  basePath,
  children,
}: RepeatScopeValue & { children: ReactNode }) {
  return (
    <RepeatScopeContext.Provider value={{ item, index, basePath }}>
      {children}
    </RepeatScopeContext.Provider>
  );
}

/**
 * Read the current repeat scope (or null if not inside a repeated element).
 */
export function useRepeatScope(): RepeatScopeValue | null {
  return useContext(RepeatScopeContext);
}
