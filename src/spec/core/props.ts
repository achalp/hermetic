import type { VisibilityCondition, StateModel } from "./types";
import { getByPath } from "./types";
import { evaluateVisibility, type VisibilityContext } from "./visibility";

// =============================================================================
// Prop Expression Types
// =============================================================================

/**
 * A prop expression that resolves to a value based on state.
 *
 * - `{ $state: string }` reads a value from the global state model
 * - `{ $item: string }` reads a field from the current repeat item
 *    (relative path into the item object; use `""` for the whole item)
 * - `{ $index: true }` returns the current repeat array index. Uses `true`
 *    as a sentinel flag because the index is a scalar with no sub-path to
 *    navigate — unlike `$item` which needs a path into the item object.
 * - `{ $bindState: string }` two-way binding to a global state path —
 *    resolves to the value at the path (like `$state`) AND exposes the
 *    resolved path so the component can write back.
 * - `{ $bindItem: string }` two-way binding to a field on the current
 *    repeat item — resolves via `repeatBasePath + path` and exposes the
 *    absolute state path for write-back.
 * - `{ $cond, $then, $else }` conditionally picks a value
 * - Any other value is a literal (passthrough)
 */
export type PropExpression<T = unknown> =
  | T
  | { $state: string }
  | { $item: string }
  | { $index: true }
  | { $bindState: string }
  | { $bindItem: string }
  | {
      $cond: VisibilityCondition;
      $then: PropExpression<T>;
      $else: PropExpression<T>;
    };

/**
 * Context for resolving prop expressions.
 * Extends {@link VisibilityContext} with an optional `repeatBasePath` used
 * to resolve `$bindItem` paths to absolute state paths.
 */
export interface PropResolutionContext extends VisibilityContext {
  /** Absolute state path to the current repeat item (e.g. "/todos/0"). Set inside repeat scopes. */
  repeatBasePath?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

function isStateExpression(value: unknown): value is { $state: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$state" in value &&
    typeof (value as Record<string, unknown>).$state === "string"
  );
}

function isItemExpression(value: unknown): value is { $item: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$item" in value &&
    typeof (value as Record<string, unknown>).$item === "string"
  );
}

function isIndexExpression(value: unknown): value is { $index: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$index" in value &&
    (value as Record<string, unknown>).$index === true
  );
}

function isBindStateExpression(value: unknown): value is { $bindState: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$bindState" in value &&
    typeof (value as Record<string, unknown>).$bindState === "string"
  );
}

function isBindItemExpression(value: unknown): value is { $bindItem: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$bindItem" in value &&
    typeof (value as Record<string, unknown>).$bindItem === "string"
  );
}

function isCondExpression(
  value: unknown
): value is { $cond: VisibilityCondition; $then: unknown; $else: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$cond" in value &&
    "$then" in value &&
    "$else" in value
  );
}

// =============================================================================
// Prop Expression Resolution
// =============================================================================

// =============================================================================
// $bindItem path resolution helper
// =============================================================================

/**
 * Resolve a `$bindItem` path into an absolute state path using the repeat
 * scope's base path.
 *
 * `""` resolves to `repeatBasePath` (the whole item).
 * `"field"` resolves to `repeatBasePath + "/field"`.
 *
 * Returns `undefined` when no `repeatBasePath` is available (i.e. `$bindItem`
 * is used outside a repeat scope).
 */
function resolveBindItemPath(itemPath: string, ctx: PropResolutionContext): string | undefined {
  if (ctx.repeatBasePath == null) {
    console.warn(`$bindItem used outside repeat scope: "${itemPath}"`);
    return undefined;
  }
  if (itemPath === "") return ctx.repeatBasePath;
  return ctx.repeatBasePath + "/" + itemPath;
}

// =============================================================================
// Prop Expression Resolution
// =============================================================================

/**
 * Resolve a single prop value that may contain expressions.
 * Handles $state, $item, $index, $bindState, $bindItem, and $cond/$then/$else in a single pass.
 */
export function resolvePropValue(value: unknown, ctx: PropResolutionContext): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // $state: read from global state model
  if (isStateExpression(value)) {
    return getByPath(ctx.stateModel, value.$state);
  }

  // $item: read from current repeat item
  if (isItemExpression(value)) {
    if (ctx.repeatItem === undefined) return undefined;
    // "" means the whole item, "field" means a field on the item
    return value.$item === "" ? ctx.repeatItem : getByPath(ctx.repeatItem, value.$item);
  }

  // $index: return current repeat array index
  if (isIndexExpression(value)) {
    return ctx.repeatIndex;
  }

  // $bindState: two-way binding to global state path
  if (isBindStateExpression(value)) {
    return getByPath(ctx.stateModel, value.$bindState);
  }

  // $bindItem: two-way binding to repeat item field
  if (isBindItemExpression(value)) {
    const resolvedPath = resolveBindItemPath(value.$bindItem, ctx);
    if (resolvedPath === undefined) return undefined;
    return getByPath(ctx.stateModel, resolvedPath);
  }

  // $cond/$then/$else: evaluate condition and pick branch
  if (isCondExpression(value)) {
    const result = evaluateVisibility(value.$cond, ctx);
    return resolvePropValue(result ? value.$then : value.$else, ctx);
  }

  // Arrays: resolve each element
  if (Array.isArray(value)) {
    return value.map((item) => resolvePropValue(item, ctx));
  }

  // Plain objects (not expressions): resolve each value recursively
  if (typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolvePropValue(val, ctx);
    }
    return resolved;
  }

  // Primitive literal: passthrough
  return value;
}

/**
 * Resolve all prop values in an element's props object.
 * Returns a new props object with all expressions resolved.
 */
export function resolveElementProps(
  props: Record<string, unknown>,
  ctx: PropResolutionContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    resolved[key] = resolvePropValue(value, ctx);
  }
  return resolved;
}

/**
 * Scan an element's raw props for `$bindState` / `$bindItem` expressions
 * and return a map of prop name → resolved absolute state path.
 *
 * This is called **before** `resolveElementProps` so the component can
 * receive both the resolved value (in `props`) and the write-back path
 * (in `bindings`).
 *
 * @example
 * ```ts
 * const rawProps = { value: { $bindState: "/form/email" }, label: "Email" };
 * const bindings = resolveBindings(rawProps, ctx);
 * // bindings = { value: "/form/email" }
 * ```
 */
export function resolveBindings(
  props: Record<string, unknown>,
  ctx: PropResolutionContext
): Record<string, string> | undefined {
  let bindings: Record<string, string> | undefined;
  for (const [key, value] of Object.entries(props)) {
    if (isBindStateExpression(value)) {
      if (!bindings) bindings = {};
      bindings[key] = value.$bindState;
    } else if (isBindItemExpression(value)) {
      const resolved = resolveBindItemPath(value.$bindItem, ctx);
      if (resolved !== undefined) {
        if (!bindings) bindings = {};
        bindings[key] = resolved;
      }
    }
  }
  return bindings;
}

/**
 * Resolve a single action parameter value.
 *
 * Like {@link resolvePropValue} but with special handling for path-valued
 * params: `{ $item: "field" }` resolves to an **absolute state path**
 * (e.g. `/todos/0/field`) instead of the field's value, so the path can
 * be passed to `setState` / `pushState` / `removeState`.
 *
 * - `{ $item: "field" }` → absolute state path via `repeatBasePath`
 * - `{ $index: true }` → current repeat index (number)
 * - Everything else delegates to `resolvePropValue` ($state, $cond, literals).
 */
export function resolveActionParam(value: unknown, ctx: PropResolutionContext): unknown {
  if (isItemExpression(value)) {
    return resolveBindItemPath(value.$item, ctx);
  }
  if (isIndexExpression(value)) {
    return ctx.repeatIndex;
  }
  return resolvePropValue(value, ctx);
}
