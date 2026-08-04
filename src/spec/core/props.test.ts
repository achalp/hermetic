import { describe, it, expect } from "vitest";
import {
  resolvePropValue,
  resolveElementProps,
  resolveBindings,
  resolveActionParam,
} from "./props";
import type { PropResolutionContext } from "./props";

// =============================================================================
// resolvePropValue
// =============================================================================

describe("resolvePropValue", () => {
  describe("literals", () => {
    it("passes through strings", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue("hello", ctx)).toBe("hello");
    });

    it("passes through numbers", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue(42, ctx)).toBe(42);
    });

    it("passes through booleans", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue(true, ctx)).toBe(true);
      expect(resolvePropValue(false, ctx)).toBe(false);
    });

    it("passes through null", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue(null, ctx)).toBeNull();
    });

    it("passes through undefined", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue(undefined, ctx)).toBeUndefined();
    });
  });

  describe("$state expressions", () => {
    it("resolves a state path", () => {
      const ctx: PropResolutionContext = {
        stateModel: { user: { name: "Alice" } },
      };
      expect(resolvePropValue({ $state: "/user/name" }, ctx)).toBe("Alice");
    });

    it("returns undefined for missing state path", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue({ $state: "/missing" }, ctx)).toBeUndefined();
    });

    it("resolves nested state path", () => {
      const ctx: PropResolutionContext = {
        stateModel: { a: { b: { c: 42 } } },
      };
      expect(resolvePropValue({ $state: "/a/b/c" }, ctx)).toBe(42);
    });
  });

  describe("$item expressions", () => {
    it("resolves a field from the repeat item", () => {
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: { title: "Hello", id: "1" },
        repeatIndex: 0,
      };
      expect(resolvePropValue({ $item: "title" }, ctx)).toBe("Hello");
    });

    it('resolves "/" to the whole item', () => {
      const item = { title: "Hello", id: "1" };
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: item,
        repeatIndex: 0,
      };
      expect(resolvePropValue({ $item: "" }, ctx)).toBe(item);
    });

    it("resolves nested field from item", () => {
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: { user: { name: "Bob" } },
        repeatIndex: 0,
      };
      expect(resolvePropValue({ $item: "user/name" }, ctx)).toBe("Bob");
    });

    it("returns undefined when no repeat item in context", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue({ $item: "title" }, ctx)).toBeUndefined();
    });

    it("returns undefined for missing field on item", () => {
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: { title: "Hello" },
        repeatIndex: 0,
      };
      expect(resolvePropValue({ $item: "missing" }, ctx)).toBeUndefined();
    });
  });

  describe("$index expressions", () => {
    it("returns the current repeat index", () => {
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: { id: "1" },
        repeatIndex: 3,
      };
      expect(resolvePropValue({ $index: true }, ctx)).toBe(3);
    });

    it("returns 0 for first item", () => {
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: { id: "1" },
        repeatIndex: 0,
      };
      expect(resolvePropValue({ $index: true }, ctx)).toBe(0);
    });

    it("returns undefined when no repeat index in context", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue({ $index: true }, ctx)).toBeUndefined();
    });
  });

  describe("$cond/$then/$else expressions", () => {
    it("returns $then when condition is true", () => {
      const ctx: PropResolutionContext = {
        stateModel: { active: true },
      };
      expect(
        resolvePropValue({ $cond: { $state: "/active" }, $then: "blue", $else: "gray" }, ctx)
      ).toBe("blue");
    });

    it("returns $else when condition is false", () => {
      const ctx: PropResolutionContext = {
        stateModel: { active: false },
      };
      expect(
        resolvePropValue({ $cond: { $state: "/active" }, $then: "blue", $else: "gray" }, ctx)
      ).toBe("gray");
    });

    it("handles eq condition", () => {
      const ctx: PropResolutionContext = {
        stateModel: { tab: "home" },
      };
      expect(
        resolvePropValue(
          {
            $cond: { $state: "/tab", eq: "home" },
            $then: "#007AFF",
            $else: "#8E8E93",
          },
          ctx
        )
      ).toBe("#007AFF");
    });

    it("handles nested expression in $then/$else", () => {
      const ctx: PropResolutionContext = {
        stateModel: { isAdmin: true, admin: { greeting: "Hello Admin" } },
      };
      expect(
        resolvePropValue(
          {
            $cond: { $state: "/isAdmin" },
            $then: { $state: "/admin/greeting" },
            $else: "Welcome",
          },
          ctx
        )
      ).toBe("Hello Admin");
    });

    it("handles array condition (implicit AND)", () => {
      const ctx: PropResolutionContext = {
        stateModel: { isAdmin: true, feature: true },
      };
      expect(
        resolvePropValue(
          {
            $cond: [{ $state: "/isAdmin" }, { $state: "/feature" }],
            $then: "yes",
            $else: "no",
          },
          ctx
        )
      ).toBe("yes");
    });
  });

  describe("nested objects and arrays", () => {
    it("resolves expressions inside plain objects", () => {
      const ctx: PropResolutionContext = {
        stateModel: { color: "red", size: 12 },
      };
      const result = resolvePropValue(
        { fill: { $state: "/color" }, fontSize: { $state: "/size" } },
        ctx
      );
      expect(result).toEqual({ fill: "red", fontSize: 12 });
    });

    it("resolves expressions inside arrays", () => {
      const ctx: PropResolutionContext = {
        stateModel: { a: 1, b: 2 },
      };
      const result = resolvePropValue([{ $state: "/a" }, { $state: "/b" }, 3], ctx);
      expect(result).toEqual([1, 2, 3]);
    });

    it("resolves deeply nested expressions", () => {
      const ctx: PropResolutionContext = {
        stateModel: { theme: { primary: "#007AFF" } },
      };
      const result = resolvePropValue(
        { style: { color: { $state: "/theme/primary" }, margin: 10 } },
        ctx
      );
      expect(result).toEqual({ style: { color: "#007AFF", margin: 10 } });
    });
  });
});

// =============================================================================
// resolveElementProps
// =============================================================================

describe("resolveElementProps", () => {
  it("resolves all props in an element", () => {
    const ctx: PropResolutionContext = {
      stateModel: { user: { name: "Alice", role: "admin" } },
    };
    const props = {
      label: { $state: "/user/name" },
      badge: { $state: "/user/role" },
      static: "always",
    };
    expect(resolveElementProps(props, ctx)).toEqual({
      label: "Alice",
      badge: "admin",
      static: "always",
    });
  });

  it("resolves mixed expressions and literals", () => {
    const ctx: PropResolutionContext = {
      stateModel: { active: true },
      repeatItem: { title: "Item 1" },
      repeatIndex: 2,
    };
    const props = {
      title: { $item: "title" },
      index: { $index: true },
      color: {
        $cond: { $state: "/active" },
        $then: "green",
        $else: "gray",
      },
      width: 100,
    };
    expect(resolveElementProps(props, ctx)).toEqual({
      title: "Item 1",
      index: 2,
      color: "green",
      width: 100,
    });
  });

  it("returns empty object for empty props", () => {
    const ctx: PropResolutionContext = { stateModel: {} };
    expect(resolveElementProps({}, ctx)).toEqual({});
  });
});

// =============================================================================
// $bindState / $bindItem expressions
// =============================================================================

describe("$bindState expressions", () => {
  describe("resolvePropValue with $bindState", () => {
    it("resolves to the state value at the path", () => {
      const ctx: PropResolutionContext = {
        stateModel: { form: { email: "alice@example.com" } },
      };
      expect(resolvePropValue({ $bindState: "/form/email" }, ctx)).toBe("alice@example.com");
    });

    it("returns undefined for missing path", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      expect(resolvePropValue({ $bindState: "/missing" }, ctx)).toBeUndefined();
    });
  });

  describe("resolvePropValue with $bindItem", () => {
    it("resolves item field using repeatBasePath", () => {
      const ctx: PropResolutionContext = {
        stateModel: { todos: [{ completed: true }, { completed: false }] },
        repeatItem: { completed: true },
        repeatIndex: 0,
        repeatBasePath: "/todos/0",
      };
      expect(resolvePropValue({ $bindItem: "completed" }, ctx)).toBe(true);
    });

    it('handles "/" as the full item path', () => {
      const ctx: PropResolutionContext = {
        stateModel: { items: ["hello", "world"] },
        repeatItem: "hello",
        repeatIndex: 0,
        repeatBasePath: "/items/0",
      };
      expect(resolvePropValue({ $bindItem: "" }, ctx)).toBe("hello");
    });

    it("returns undefined when no repeatBasePath", () => {
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: { completed: true },
        repeatIndex: 0,
      };
      // Without repeatBasePath, the raw item path won't resolve in stateModel
      expect(resolvePropValue({ $bindItem: "completed" }, ctx)).toBeUndefined();
    });
  });

  describe("resolveBindings", () => {
    it("extracts $bindState paths from props", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      const props = {
        value: { $bindState: "/form/email" },
        label: "Email",
        placeholder: "Enter email",
      };
      expect(resolveBindings(props, ctx)).toEqual({
        value: "/form/email",
      });
    });

    it("returns undefined when no bind expressions", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      const props = {
        label: "Hello",
        count: 42,
      };
      expect(resolveBindings(props, ctx)).toBeUndefined();
    });

    it("handles multiple $bindState props", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      const props = {
        value: { $bindState: "/form/name" },
        checked: { $bindState: "/form/agree" },
        label: "Name",
      };
      expect(resolveBindings(props, ctx)).toEqual({
        value: "/form/name",
        checked: "/form/agree",
      });
    });

    it("resolves $bindItem paths using repeatBasePath", () => {
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: { completed: false },
        repeatIndex: 1,
        repeatBasePath: "/todos/1",
      };
      const props = {
        checked: { $bindItem: "completed" },
        label: { $item: "title" },
      };
      expect(resolveBindings(props, ctx)).toEqual({
        checked: "/todos/1/completed",
      });
    });

    it("ignores non-bind dynamic expressions", () => {
      const ctx: PropResolutionContext = { stateModel: {} };
      const props = {
        title: { $state: "/title" },
        index: { $index: true },
        name: { $item: "name" },
        value: { $bindState: "/path" },
      };
      expect(resolveBindings(props, ctx)).toEqual({
        value: "/path",
      });
    });

    it("handles mixed $bindState and $bindItem props", () => {
      const ctx: PropResolutionContext = {
        stateModel: {},
        repeatItem: { done: false },
        repeatIndex: 0,
        repeatBasePath: "/todos/0",
      };
      const props = {
        value: { $bindState: "/form/search" },
        checked: { $bindItem: "done" },
        label: "Task",
      };
      expect(resolveBindings(props, ctx)).toEqual({
        value: "/form/search",
        checked: "/todos/0/done",
      });
    });
  });
});

// =============================================================================
// resolveActionParam
// =============================================================================

describe("resolveActionParam", () => {
  it("resolves $item to an absolute state path via repeatBasePath", () => {
    const ctx: PropResolutionContext = {
      stateModel: { todos: [{ title: "Buy milk" }] },
      repeatItem: { title: "Buy milk" },
      repeatIndex: 0,
      repeatBasePath: "/todos/0",
    };
    expect(resolveActionParam({ $item: "title" }, ctx)).toBe("/todos/0/title");
  });

  it("resolves $item with empty string to the repeatBasePath itself", () => {
    const ctx: PropResolutionContext = {
      stateModel: { items: ["a", "b"] },
      repeatItem: "a",
      repeatIndex: 0,
      repeatBasePath: "/items/0",
    };
    expect(resolveActionParam({ $item: "" }, ctx)).toBe("/items/0");
  });

  it("returns undefined for $item when no repeatBasePath", () => {
    const ctx: PropResolutionContext = {
      stateModel: {},
      repeatItem: { title: "Hello" },
      repeatIndex: 0,
    };
    expect(resolveActionParam({ $item: "title" }, ctx)).toBeUndefined();
  });

  it("resolves $index to the current repeat index", () => {
    const ctx: PropResolutionContext = {
      stateModel: {},
      repeatItem: { id: "1" },
      repeatIndex: 5,
    };
    expect(resolveActionParam({ $index: true }, ctx)).toBe(5);
  });

  it("returns undefined for $index when no repeat context", () => {
    const ctx: PropResolutionContext = { stateModel: {} };
    expect(resolveActionParam({ $index: true }, ctx)).toBeUndefined();
  });

  it("delegates $state expressions to resolvePropValue", () => {
    const ctx: PropResolutionContext = {
      stateModel: { form: { id: "abc-123" } },
    };
    expect(resolveActionParam({ $state: "/form/id" }, ctx)).toBe("abc-123");
  });

  it("passes through literal strings", () => {
    const ctx: PropResolutionContext = { stateModel: {} };
    expect(resolveActionParam("submit", ctx)).toBe("submit");
  });

  it("passes through literal numbers", () => {
    const ctx: PropResolutionContext = { stateModel: {} };
    expect(resolveActionParam(42, ctx)).toBe(42);
  });

  it("passes through null", () => {
    const ctx: PropResolutionContext = { stateModel: {} };
    expect(resolveActionParam(null, ctx)).toBeNull();
  });
});
