// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { StateProvider, useStateStore, useStateValue, useStateBinding } from "./state";

describe("StateProvider", () => {
  it("provides initial state to children", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{ user: { name: "John" } }}>{children}</StateProvider>
    );

    const { result } = renderHook(() => useStateStore(), { wrapper });

    expect(result.current.state).toEqual({ user: { name: "John" } });
  });

  it("provides empty object when no initial state", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider>{children}</StateProvider>
    );

    const { result } = renderHook(() => useStateStore(), { wrapper });

    expect(result.current.state).toEqual({});
  });
});

describe("useStateStore", () => {
  it("provides get function to retrieve values", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{ user: { name: "John" } }}>{children}</StateProvider>
    );

    const { result } = renderHook(() => useStateStore(), { wrapper });

    expect(result.current.get("/user/name")).toBe("John");
  });

  it("allows setting state at path with set function", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{}}>{children}</StateProvider>
    );

    const { result } = renderHook(() => useStateStore(), { wrapper });

    act(() => {
      result.current.set("/user/name", "Alice");
    });

    expect((result.current.state.user as Record<string, unknown>).name).toBe("Alice");
  });

  it("calls onStateChange callback when state changes", () => {
    const onStateChange = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{}} onStateChange={onStateChange}>
        {children}
      </StateProvider>
    );

    const { result } = renderHook(() => useStateStore(), { wrapper });

    act(() => {
      result.current.set("/count", 42);
    });

    expect(onStateChange).toHaveBeenCalledWith("/count", 42);
  });

  it("allows updating multiple values with update function", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{}}>{children}</StateProvider>
    );

    const { result } = renderHook(() => useStateStore(), { wrapper });

    act(() => {
      result.current.update({
        "/name": "John",
        "/age": 30,
      });
    });

    expect(result.current.state.name).toBe("John");
    expect(result.current.state.age).toBe(30);
  });
});

describe("useStateValue", () => {
  it("returns value at specified path", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{ user: { name: "John", age: 30 } }}>{children}</StateProvider>
    );

    const { result } = renderHook(() => useStateValue("/user/name"), {
      wrapper,
    });

    expect(result.current).toBe("John");
  });

  it("returns undefined for missing path", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{}}>{children}</StateProvider>
    );

    const { result } = renderHook(() => useStateValue("/missing"), { wrapper });

    expect(result.current).toBeUndefined();
  });

  it("updates when state changes", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{ count: 0 }}>{children}</StateProvider>
    );

    // Use a single hook that returns both values
    const { result, rerender } = renderHook(
      () => ({
        store: useStateStore(),
        value: useStateValue<number>("/count"),
      }),
      { wrapper }
    );

    expect(result.current.value).toBe(0);

    act(() => {
      result.current.store.set("/count", 5);
    });

    rerender();
    expect(result.current.value).toBe(5);
  });
});

describe("useStateBinding", () => {
  it("returns tuple with value and setter for path", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{ name: "John" }}>{children}</StateProvider>
    );

    const { result } = renderHook(() => useStateBinding("/name"), { wrapper });

    const [value, setValue] = result.current;
    expect(value).toBe("John");
    expect(typeof setValue).toBe("function");
  });

  it("setter updates the value", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StateProvider initialState={{ name: "John" }}>{children}</StateProvider>
    );

    const { result, rerender } = renderHook(() => useStateBinding("/name"), {
      wrapper,
    });

    act(() => {
      const [, setValue] = result.current;
      setValue("Alice");
    });

    rerender();
    const [value] = result.current;
    expect(value).toBe("Alice");
  });
});
