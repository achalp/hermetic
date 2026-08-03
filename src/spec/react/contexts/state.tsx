"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { getByPath, setByPath, type StateModel } from "@/spec/core";

/**
 * State context value
 */
export interface StateContextValue {
  /** The current state model */
  state: StateModel;
  /** Get a value by path */
  get: (path: string) => unknown;
  /** Set a value by path */
  set: (path: string, value: unknown) => void;
  /** Update multiple values at once */
  update: (updates: Record<string, unknown>) => void;
}

const StateContext = createContext<StateContextValue | null>(null);

/**
 * Props for StateProvider
 */
export interface StateProviderProps {
  /** Initial state model */
  initialState?: StateModel;
  /** Callback when state changes */
  onStateChange?: (path: string, value: unknown) => void;
  children: ReactNode;
}

/**
 * Provider for state model context
 */
export function StateProvider({ initialState = {}, onStateChange, children }: StateProviderProps) {
  const [state, setStateInternal] = useState<StateModel>(initialState);

  // Keep a ref to the latest state so `get` doesn't change on every update.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Track the serialized initialState to detect actual value changes (not just reference changes)
  const initialStateJsonRef = useRef<string>(JSON.stringify(initialState));

  // Sync external state changes with internal state - only when values actually change
  useEffect(() => {
    const newJson = JSON.stringify(initialState);
    if (newJson !== initialStateJsonRef.current) {
      initialStateJsonRef.current = newJson;
      if (initialState && Object.keys(initialState).length > 0) {
        setStateInternal((prev) => ({ ...prev, ...initialState }));
      }
    }
  }, [initialState]);

  // `get` uses a ref so it never changes identity — consumers that only
  // need `get` won't re-render on every state change.
  const get = useCallback((path: string) => getByPath(stateRef.current, path), []);

  const set = useCallback(
    (path: string, value: unknown) => {
      setStateInternal((prev) => {
        const next = { ...prev };
        setByPath(next, path, value);
        return next;
      });
      // Side effect after the state update
      onStateChange?.(path, value);
    },
    [onStateChange]
  );

  const update = useCallback(
    (updates: Record<string, unknown>) => {
      const entries = Object.entries(updates);
      setStateInternal((prev) => {
        const next = { ...prev };
        for (const [path, value] of entries) {
          setByPath(next, path, value);
        }
        return next;
      });
      // Side effects after the state update
      for (const [path, value] of entries) {
        onStateChange?.(path, value);
      }
    },
    [onStateChange]
  );

  const value = useMemo<StateContextValue>(
    () => ({
      state,
      get,
      set,
      update,
    }),
    [state, get, set, update]
  );

  return <StateContext.Provider value={value}>{children}</StateContext.Provider>;
}

/**
 * Hook to access the state context
 */
export function useStateStore(): StateContextValue {
  const ctx = useContext(StateContext);
  if (!ctx) {
    throw new Error("useStateStore must be used within a StateProvider");
  }
  return ctx;
}

/**
 * Hook to get a value from the state model
 */
export function useStateValue<T>(path: string): T | undefined {
  const { state } = useStateStore();
  return getByPath(state, path) as T | undefined;
}

/**
 * Hook to get and set a value from the state model (like useState).
 *
 * @deprecated Use {@link useBoundProp} with `$bindState` expressions instead.
 * `useStateBinding` takes a raw state path string, while `useBoundProp` works
 * with the renderer's `bindings` map and supports both `$bindState` and
 * `$bindItem` expressions.
 */
export function useStateBinding<T>(path: string): [T | undefined, (value: T) => void] {
  const { state, set } = useStateStore();
  const value = getByPath(state, path) as T | undefined;
  const setValue = useCallback((newValue: T) => set(path, newValue), [path, set]);
  return [value, setValue];
}
