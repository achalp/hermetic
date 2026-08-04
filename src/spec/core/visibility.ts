import { z } from "zod";
import type {
  VisibilityCondition,
  StateCondition,
  ItemCondition,
  IndexCondition,
  SingleCondition,
  AndCondition,
  OrCondition,
  StateModel,
} from "./types";
import { getByPath } from "./types";

// =============================================================================
// Schemas
// =============================================================================

/**
 * Schema for a single state condition.
 */
const numericOrStateRef = z.union([z.number(), z.object({ $state: z.string() })]);

const comparisonOps = {
  eq: z.unknown().optional(),
  neq: z.unknown().optional(),
  gt: numericOrStateRef.optional(),
  gte: numericOrStateRef.optional(),
  lt: numericOrStateRef.optional(),
  lte: numericOrStateRef.optional(),
  not: z.literal(true).optional(),
};

const StateConditionSchema = z.object({
  $state: z.string(),
  ...comparisonOps,
});

const ItemConditionSchema = z.object({
  $item: z.string(),
  ...comparisonOps,
});

const IndexConditionSchema = z.object({
  $index: z.literal(true),
  ...comparisonOps,
});

const SingleConditionSchema = z.union([
  StateConditionSchema,
  ItemConditionSchema,
  IndexConditionSchema,
]);

/**
 * Visibility condition schema.
 *
 * Lazy because `OrCondition` can recursively contain `VisibilityCondition`.
 */
export const VisibilityConditionSchema: z.ZodType<VisibilityCondition> = z.lazy(() =>
  z.union([
    z.boolean(),
    SingleConditionSchema,
    z.array(SingleConditionSchema),
    z.object({ $and: z.array(VisibilityConditionSchema) }),
    z.object({ $or: z.array(VisibilityConditionSchema) }),
  ])
);

// =============================================================================
// Context
// =============================================================================

/**
 * Context for evaluating visibility conditions.
 *
 * `repeatItem` and `repeatIndex` are only present inside a `repeat` scope
 * and enable `$item` / `$index` conditions.
 */
export interface VisibilityContext {
  stateModel: StateModel;
  /** The current repeat item (set inside a repeat scope). */
  repeatItem?: unknown;
  /** The current repeat array index (set inside a repeat scope). */
  repeatIndex?: number;
}

// =============================================================================
// Evaluation
// =============================================================================

/**
 * Resolve a comparison value. If it's a `{ $state }` reference, look it up;
 * otherwise return the literal.
 */
function resolveComparisonValue(value: unknown, ctx: VisibilityContext): unknown {
  if (typeof value === "object" && value !== null) {
    if ("$state" in value && typeof (value as Record<string, unknown>).$state === "string") {
      return getByPath(ctx.stateModel, (value as { $state: string }).$state);
    }
  }
  return value;
}

/**
 * Type guards for condition sources.
 */
function isItemCondition(cond: SingleCondition): cond is ItemCondition {
  return "$item" in cond;
}

function isIndexCondition(cond: SingleCondition): cond is IndexCondition {
  return "$index" in cond;
}

/**
 * Resolve the left-hand-side value of a condition based on its source.
 */
function resolveConditionValue(cond: SingleCondition, ctx: VisibilityContext): unknown {
  if (isIndexCondition(cond)) {
    return ctx.repeatIndex;
  }
  if (isItemCondition(cond)) {
    if (ctx.repeatItem === undefined) return undefined;
    return cond.$item === "" ? ctx.repeatItem : getByPath(ctx.repeatItem, cond.$item);
  }
  // StateCondition
  return getByPath(ctx.stateModel, (cond as StateCondition).$state);
}

/**
 * Evaluate a single condition against the context.
 *
 * When `not` is `true`, the final result is inverted — this applies to
 * whichever operator is present (or to the truthiness check if no operator
 * is given).  For example:
 * - `{ $state: "/x", not: true }` → `!Boolean(value)`
 * - `{ $state: "/x", gt: 5, not: true }` → `!(value > 5)`
 */
function evaluateCondition(cond: SingleCondition, ctx: VisibilityContext): boolean {
  const value = resolveConditionValue(cond, ctx);
  let result: boolean;

  // Equality
  if (cond.eq !== undefined) {
    const rhs = resolveComparisonValue(cond.eq, ctx);
    result = value === rhs;
  }
  // Inequality
  else if (cond.neq !== undefined) {
    const rhs = resolveComparisonValue(cond.neq, ctx);
    result = value !== rhs;
  }
  // Greater than
  else if (cond.gt !== undefined) {
    const rhs = resolveComparisonValue(cond.gt, ctx);
    result = typeof value === "number" && typeof rhs === "number" ? value > rhs : false;
  }
  // Greater than or equal
  else if (cond.gte !== undefined) {
    const rhs = resolveComparisonValue(cond.gte, ctx);
    result = typeof value === "number" && typeof rhs === "number" ? value >= rhs : false;
  }
  // Less than
  else if (cond.lt !== undefined) {
    const rhs = resolveComparisonValue(cond.lt, ctx);
    result = typeof value === "number" && typeof rhs === "number" ? value < rhs : false;
  }
  // Less than or equal
  else if (cond.lte !== undefined) {
    const rhs = resolveComparisonValue(cond.lte, ctx);
    result = typeof value === "number" && typeof rhs === "number" ? value <= rhs : false;
  }
  // Truthiness (no operator)
  else {
    result = Boolean(value);
  }

  // `not` inverts the result of any condition
  return cond.not === true ? !result : result;
}

/**
 * Type guard for AndCondition
 */
function isAndCondition(condition: VisibilityCondition): condition is AndCondition {
  return (
    typeof condition === "object" &&
    condition !== null &&
    !Array.isArray(condition) &&
    "$and" in condition
  );
}

/**
 * Type guard for OrCondition
 */
function isOrCondition(condition: VisibilityCondition): condition is OrCondition {
  return (
    typeof condition === "object" &&
    condition !== null &&
    !Array.isArray(condition) &&
    "$or" in condition
  );
}

/**
 * Evaluate a visibility condition.
 *
 * - `undefined` → visible
 * - `boolean` → that value
 * - `SingleCondition` → evaluate single condition
 * - `SingleCondition[]` → implicit AND (all must be true)
 * - `AndCondition` → `{ $and: [...] }`, explicit AND
 * - `OrCondition` → `{ $or: [...] }`, at least one must be true
 */
export function evaluateVisibility(
  condition: VisibilityCondition | undefined,
  ctx: VisibilityContext
): boolean {
  // No condition = visible
  if (condition === undefined) {
    return true;
  }

  // Boolean literal
  if (typeof condition === "boolean") {
    return condition;
  }

  // Array = implicit AND
  if (Array.isArray(condition)) {
    return condition.every((c) => evaluateCondition(c, ctx));
  }

  // Explicit AND condition
  if (isAndCondition(condition)) {
    return condition.$and.every((child) => evaluateVisibility(child, ctx));
  }

  // OR condition
  if (isOrCondition(condition)) {
    return condition.$or.some((child) => evaluateVisibility(child, ctx));
  }

  // Single condition
  return evaluateCondition(condition, ctx);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Helper to create visibility conditions.
 */
export const visibility = {
  /** Always visible */
  always: true as const,

  /** Never visible */
  never: false as const,

  /** Visible when state path is truthy */
  when: (path: string): StateCondition => ({ $state: path }),

  /** Visible when state path is falsy */
  unless: (path: string): StateCondition => ({ $state: path, not: true }),

  /** Equality check */
  eq: (path: string, value: unknown): StateCondition => ({
    $state: path,
    eq: value,
  }),

  /** Not equal check */
  neq: (path: string, value: unknown): StateCondition => ({
    $state: path,
    neq: value,
  }),

  /** Greater than */
  gt: (path: string, value: number | { $state: string }): StateCondition => ({
    $state: path,
    gt: value,
  }),

  /** Greater than or equal */
  gte: (path: string, value: number | { $state: string }): StateCondition => ({
    $state: path,
    gte: value,
  }),

  /** Less than */
  lt: (path: string, value: number | { $state: string }): StateCondition => ({
    $state: path,
    lt: value,
  }),

  /** Less than or equal */
  lte: (path: string, value: number | { $state: string }): StateCondition => ({
    $state: path,
    lte: value,
  }),

  /** AND multiple conditions */
  and: (...conditions: VisibilityCondition[]): AndCondition => ({
    $and: conditions,
  }),

  /** OR multiple conditions */
  or: (...conditions: VisibilityCondition[]): OrCondition => ({
    $or: conditions,
  }),
};
