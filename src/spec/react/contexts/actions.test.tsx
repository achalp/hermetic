// @vitest-environment jsdom
/**
 * ActionProvider execution lifecycle (actions.tsx was ~30% covered). Covers
 * the built-in action branches (setState / pushState / removeState / push /
 * pop), custom handler registration + execution, loading-state tracking, the
 * confirmation flow (confirm + cancel), onSuccess.navigate, and useAction.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { StateProvider, useStateStore } from "@/spec/react";
import { ActionProvider, useActions, useAction } from "./actions";
import type { ActionHandler } from "@/spec/core";

// Wrapper composing the minimal provider stack useActions needs. A navigate
// spy is threaded through so onSuccess.navigate can be asserted.
const navigate = vi.fn();

function makeWrapper(initialState: Record<string, unknown> = {}) {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <StateProvider initialState={initialState}>
      <ActionProvider navigate={navigate}>{children}</ActionProvider>
    </StateProvider>
  );
  Wrapper.displayName = "Wrapper";
  return Wrapper;
}

// Hook that exposes both the action context and the state store together.
const useBoth = () => ({ actions: useActions(), store: useStateStore() });

describe("useActions", () => {
  it("throws when used outside an ActionProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useActions())).toThrow(/must be used within an ActionProvider/);
    spy.mockRestore();
  });

  it("registers a custom handler and executes it with resolved params", async () => {
    const handler = vi.fn<ActionHandler>();
    const { result } = renderHook(useBoth, { wrapper: makeWrapper({ n: 7 }) });

    act(() => result.current.actions.registerHandler("save", handler));

    await act(async () => {
      await result.current.actions.execute({
        action: "save",
        params: { count: { $state: "/n" }, literal: "x" },
      });
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ count: 7, literal: "x" });
  });

  it("warns and no-ops when no handler is registered for the action", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useActions(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.execute({ action: "unknown" });
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    warn.mockRestore();
  });
});

describe("ActionProvider built-in actions", () => {
  it("setState writes the value to state", async () => {
    const { result } = renderHook(useBoth, { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.actions.execute({
        action: "setState",
        params: { statePath: "/greeting", value: "hi" },
      });
    });

    expect(result.current.store.get("/greeting")).toBe("hi");
  });

  it("pushState appends to an array, resolves $state refs, and clears a path", async () => {
    const { result } = renderHook(useBoth, {
      wrapper: makeWrapper({ todos: [{ text: "a" }], draft: "b" }),
    });

    await act(async () => {
      await result.current.actions.execute({
        action: "pushState",
        params: {
          statePath: "/todos",
          value: { text: { $state: "/draft" } },
          clearStatePath: "/draft",
        },
      });
    });

    expect(result.current.store.get("/todos")).toEqual([{ text: "a" }, { text: "b" }]);
    expect(result.current.store.get("/draft")).toBe("");
  });

  it("removeState drops the item at the given index", async () => {
    const { result } = renderHook(useBoth, {
      wrapper: makeWrapper({ items: ["a", "b", "c"] }),
    });

    await act(async () => {
      await result.current.actions.execute({
        action: "removeState",
        params: { statePath: "/items", index: 1 } as Record<string, unknown>,
      });
    });

    expect(result.current.store.get("/items")).toEqual(["a", "c"]);
  });

  it("push records the current screen on navStack and pop restores it", async () => {
    const { result } = renderHook(useBoth, {
      wrapper: makeWrapper({ currentScreen: "home" }),
    });

    await act(async () => {
      await result.current.actions.execute({
        action: "push",
        params: { screen: "details" },
      });
    });
    expect(result.current.store.get("/currentScreen")).toBe("details");
    expect(result.current.store.get("/navStack")).toEqual(["home"]);

    await act(async () => {
      await result.current.actions.execute({ action: "pop" });
    });
    expect(result.current.store.get("/currentScreen")).toBe("home");
    expect(result.current.store.get("/navStack")).toEqual([]);
  });

  it("push from a screenless start pushes a sentinel that pop clears", async () => {
    const { result } = renderHook(useBoth, { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.actions.execute({ action: "push", params: { screen: "s1" } });
    });
    expect(result.current.store.get("/navStack")).toEqual([""]);

    await act(async () => {
      await result.current.actions.execute({ action: "pop" });
    });
    expect(result.current.store.get("/currentScreen")).toBeUndefined();
  });
});

describe("ActionProvider handler lifecycle", () => {
  it("tracks loadingActions while a handler is in flight", async () => {
    let release!: () => void;
    const handler: ActionHandler = () => new Promise<void>((r) => (release = r));
    const { result } = renderHook(() => useActions(), { wrapper: makeWrapper() });

    act(() => result.current.registerHandler("slow", handler));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.execute({ action: "slow" });
    });
    expect(result.current.loadingActions.has("slow")).toBe(true);

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.loadingActions.has("slow")).toBe(false);
  });

  it("runs onSuccess.navigate after the handler resolves", async () => {
    navigate.mockClear();
    const handler = vi.fn<ActionHandler>();
    const { result } = renderHook(() => useActions(), { wrapper: makeWrapper() });

    act(() => result.current.registerHandler("go", handler));
    await act(async () => {
      await result.current.execute({ action: "go", onSuccess: { navigate: "/next" } });
    });

    expect(handler).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/next");
  });

  it("holds a pendingConfirmation until confirm() runs the handler", async () => {
    const handler = vi.fn<ActionHandler>();
    const { result } = renderHook(() => useActions(), { wrapper: makeWrapper() });

    act(() => result.current.registerHandler("wipe", handler));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.execute({
        action: "wipe",
        confirm: { title: "Sure?", message: "This deletes data", variant: "danger" },
      });
    });

    expect(result.current.pendingConfirmation).not.toBeNull();
    expect(result.current.pendingConfirmation?.action.action).toBe("wipe");
    expect(handler).not.toHaveBeenCalled();

    await act(async () => {
      result.current.confirm();
      await pending;
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.current.pendingConfirmation).toBeNull();
  });

  it("cancel() rejects the pending action without running the handler", async () => {
    const handler = vi.fn<ActionHandler>();
    const { result } = renderHook(() => useActions(), { wrapper: makeWrapper() });

    act(() => result.current.registerHandler("wipe", handler));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.execute({
        action: "wipe",
        confirm: { title: "Sure?", message: "gone" },
      });
    });
    expect(result.current.pendingConfirmation).not.toBeNull();

    await act(async () => {
      result.current.cancel();
      await pending.catch(() => {});
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.current.pendingConfirmation).toBeNull();
  });
});

describe("useAction", () => {
  it("returns a bound execute and reflects the loading flag", async () => {
    let release!: () => void;
    const handler: ActionHandler = () => new Promise<void>((r) => (release = r));

    const { result } = renderHook(
      () => ({ actions: useActions(), one: useAction({ action: "slow" }) }),
      { wrapper: makeWrapper() }
    );

    act(() => result.current.actions.registerHandler("slow", handler));
    expect(result.current.one.isLoading).toBe(false);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.one.execute();
    });
    expect(result.current.one.isLoading).toBe(true);

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.one.isLoading).toBe(false);
  });
});
