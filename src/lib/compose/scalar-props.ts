/**
 * A prop the catalog declares SCALAR must never hold an object.
 *
 * The renderer string-coerces whatever it is given, so an object in a value slot
 * reaches the user as the literal text `[object Object]`. Observed in the King
 * County correlation dashboard: a StatCard whose value was the whole correlation
 * record — `{pearson_r: 0.2637, pearson_p: 0.342…, spearman_rho: 0.0893, n: 15}`
 * — rendered as `[object Object]` beside a working card showing the same 0.2637.
 *
 * Generalized rather than patched at the one injector that produced it, for two
 * reasons. The defect is a CLASS: any binding that resolves to a record instead
 * of a number lands in the same place, and `unwrapScalar` only reduces the
 * `{value: …}` wrapper shape, not a bag of related statistics. And the catalog
 * already knows which props are scalar — the zod schemas are introspectable the
 * same way `nullablePropKeys` reads them — so the rule can be derived from the
 * component definitions instead of maintained as a hand-list that drifts.
 *
 * The repair prefers RECOVERY over blanking: a stats record usually contains the
 * headline number the composer meant, and showing 0.2637 is better than showing
 * nothing. It only unwraps when the choice is unambiguous — a single scalar
 * field, or one conventional headline key — and otherwise reports the prop as
 * unrenderable rather than inventing a number.
 */
import { z } from "zod";
import { catalogComponents } from "@/lib/catalog";

/**
 * Value slots the catalog CANNOT type, and why.
 *
 * `StatCard.value` is `z.unknown()` on purpose: it may hold a `$state` reference
 * object for reactive updates. So schema introspection alone cannot separate a
 * legitimate reference from an accidental record, and these props are checked by
 * name in addition to the catalog-derived scalar set. The check that matters is
 * not "is it an object" but "is it a REFERENCE" — see isBindingReference.
 */
const UNTYPED_VALUE_PROPS = new Set(["value"]);

/**
 * A `$state` (or unresolved `$result`/`$finding`) envelope. These are objects by
 * design and must pass untouched: the renderer resolves them at paint time, and
 * rewriting one to a scalar would freeze a reactive binding into a constant.
 */
function isBindingReference(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((k) => k.startsWith("$"));
}

/**
 * Conventional headline fields, in priority order. Each names the primary
 * statistic of a record whose other fields qualify it (p-values, counts, the
 * secondary method). Deliberately short: a key that is not obviously THE number
 * is not guessed at.
 */
const HEADLINE_KEYS = [
  "value",
  "pearson_r",
  "r",
  "rho",
  "spearman_rho",
  "estimate",
  "coefficient",
  "slope",
  "mean",
  "median",
  "total",
  "count",
] as const;

const scalarKeyCache = new Map<string, Set<string>>();

/** Props whose catalog schema accepts a scalar but rejects an object. */
export function scalarPropKeys(type: string): Set<string> {
  const cached = scalarKeyCache.get(type);
  if (cached) return cached;
  const keys = new Set<string>();
  const def = (catalogComponents as Record<string, { props?: z.ZodObject<z.ZodRawShape> }>)[type];
  const shape = def?.props?.shape;
  if (shape) {
    for (const [k, field] of Object.entries(shape)) {
      try {
        const f = field as z.ZodTypeAny;
        const takesScalar = f.safeParse(1).success || f.safeParse("x").success;
        // The discriminator: `data`/`rows` props accept objects and arrays, and
        // must stay exempt however they are named.
        const takesObject = f.safeParse({ a: 1 }).success || f.safeParse([{ a: 1 }]).success;
        if (takesScalar && !takesObject) keys.add(k);
      } catch {
        // A field whose parse throws tells us nothing; leave it unconstrained.
      }
    }
  }
  scalarKeyCache.set(type, keys);
  return keys;
}

interface ScalarPropFix {
  elementId: string;
  prop: string;
  /** The scalar recovered from the object, when one was unambiguous. */
  recovered?: string | number | boolean;
  /** Keys of the offending object, for the log when nothing was recoverable. */
  objectKeys?: string[];
}

export interface ScalarPropLint {
  /** Props repaired to a scalar the record already contained. */
  fixed: ScalarPropFix[];
  /** Props holding an object with no unambiguous headline — left for the caller. */
  unrenderable: ScalarPropFix[];
}

/** Pull the intended scalar out of a record, or undefined when it is a guess. */
export function recoverScalar(
  value: Record<string, unknown>
): string | number | boolean | undefined {
  const scalarEntries = Object.entries(value).filter(
    ([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean"
  );
  if (scalarEntries.length === 1) return scalarEntries[0]![1] as string | number | boolean;
  for (const key of HEADLINE_KEYS) {
    const v = value[key];
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  }
  return undefined;
}

/**
 * Find every scalar-declared prop holding an object, repairing in place where the
 * intended value is unambiguous. Mutates `elements` only for repairs it can make.
 */
export function lintScalarProps(elements: Record<string, unknown>): ScalarPropLint {
  const fixed: ScalarPropFix[] = [];
  const unrenderable: ScalarPropFix[] = [];
  for (const [elementId, raw] of Object.entries(elements ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type !== "string" || !el.props || typeof el.props !== "object") continue;
    const scalarKeys = scalarPropKeys(el.type);
    for (const [prop, value] of Object.entries(el.props)) {
      if (!scalarKeys.has(prop) && !UNTYPED_VALUE_PROPS.has(prop)) continue;
      if (value === null || typeof value !== "object") continue;
      if (!Array.isArray(value) && isBindingReference(value as Record<string, unknown>)) continue;
      if (Array.isArray(value)) {
        unrenderable.push({ elementId, prop, objectKeys: [`array(${value.length})`] });
        continue;
      }
      const record = value as Record<string, unknown>;
      const recovered = recoverScalar(record);
      if (recovered !== undefined) {
        el.props[prop] = recovered;
        fixed.push({ elementId, prop, recovered });
      } else {
        unrenderable.push({ elementId, prop, objectKeys: Object.keys(record) });
      }
    }
  }
  return { fixed, unrenderable };
}
