// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";

function setup(active: boolean) {
  const onClose = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);

  const { unmount } = renderHook(() => {
    const ref = useRef<HTMLElement>(container);
    useClickOutside(ref, onClose, active);
  });

  return { onClose, container, unmount };
}

describe("useClickOutside", () => {
  it("calls onClose when clicking outside the ref element", () => {
    const { onClose } = setup(true);
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the ref element", () => {
    const { onClose, container } = setup(true);

    container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key press", () => {
    const { onClose } = setup(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose on other key presses", () => {
    const { onClose } = setup(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call onClose when active is false", () => {
    const { onClose } = setup(false);

    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cleans up listeners on unmount", () => {
    const { onClose, unmount } = setup(true);
    unmount();

    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
