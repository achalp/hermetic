// @vitest-environment jsdom
/**
 * ValidationProvider + useFieldValidation wiring (validation.tsx was ~2%
 * covered). The pure validator (runValidation) is tested in core; this covers
 * the register/validate/touch/clear lifecycle against live state.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { StateProvider, ValidationProvider, useFieldValidation, useStateStore } from "@/spec/react";
import type { ValidationConfig } from "@/spec/core";

// Stable config ref — a fresh object each render would re-register the field.
const CONFIG: ValidationConfig = { checks: [{ type: "required", message: "Required" }] };

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <StateProvider initialState={{ form: { email: "" } }}>
    <ValidationProvider>{children}</ValidationProvider>
  </StateProvider>
);

describe("useFieldValidation", () => {
  it("runs the field's checks against live state and flips valid/invalid", () => {
    const { result } = renderHook(
      () => ({ fv: useFieldValidation("/form/email", CONFIG), store: useStateStore() }),
      { wrapper }
    );

    // Untouched, unvalidated at mount.
    expect(result.current.fv.state.touched).toBe(false);
    expect(result.current.fv.state.validated).toBe(false);

    // Validate the empty value → the required check fails.
    act(() => void result.current.fv.validate());
    expect(result.current.fv.isValid).toBe(false);
    expect(result.current.fv.errors).toContain("Required");

    // Fill the field, re-validate → passes.
    act(() => result.current.store.set("/form/email", "a@b.com"));
    act(() => void result.current.fv.validate());
    expect(result.current.fv.isValid).toBe(true);
    expect(result.current.fv.errors).toEqual([]);
  });

  it("touch marks touched; clear resets the field state", () => {
    const { result } = renderHook(() => useFieldValidation("/form/email", CONFIG), { wrapper });
    act(() => result.current.touch());
    expect(result.current.state.touched).toBe(true);
    act(() => void result.current.validate());
    expect(result.current.state.validated).toBe(true);
    act(() => result.current.clear());
    expect(result.current.state.validated).toBe(false);
  });
});
