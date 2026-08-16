import { defineCatalog } from "@/spec/core";
import { schema } from "@/spec/react/schema";
import { z } from "zod";
import { catalogLayoutTables } from "@/lib/catalog-components/layout-tables";
import { catalogCoreCharts } from "@/lib/catalog-components/core-charts";
import { catalogStatistical } from "@/lib/catalog-components/statistical";
import { catalogControls } from "@/lib/catalog-components/controls";

// Exported so tests (and tooling) can validate props directly against each
// component's own zod schema — independent of the json-render render-tree
// validator, whose contract can shift across the floating 0.x dependency.
export const catalogComponents = {
  ...catalogLayoutTables,
  ...catalogCoreCharts,
  ...catalogStatistical,
  ...catalogControls,
};

export const catalog = defineCatalog(schema, {
  components: catalogComponents,
  actions: {
    drillDown: {
      params: z.object({
        segment_label: z.string(),
        segment_value: z.union([z.string(), z.number()]),
        chart_title: z.string().nullable(),
        x_key: z.string().nullable(),
        y_key: z.string().nullable(),
        filter_column: z.string(),
        filter_value: z.union([z.string(), z.number()]),
      }),
      description:
        "Drill into a specific data segment. Triggers a new analysis scoped to the clicked segment. Use on chart components when the data supports further segmentation or breakdown.",
    },
  },
});

export type AppCatalog = typeof catalog;

/**
 * Validate a spec against the full catalog (every component's zod props
 * schema + the envelope) — modularization WS2. The 84 schemas existed from
 * day one but never ran against whole specs; this export runs in the render
 * smoke suite for every fixture and (warn-only) on the history persist path.
 */
const nullableKeysCache = new Map<string, string[]>();
/** Prop keys of a component that ACCEPT null — probed from the zod shape
 *  once per type. Used by validateSpec's sparse-props tolerance. */
function nullablePropKeys(type: string): string[] {
  const cached = nullableKeysCache.get(type);
  if (cached) return cached;
  const keys: string[] = [];
  const def = (catalogComponents as Record<string, { props?: z.ZodObject<z.ZodRawShape> }>)[type];
  const shape = def?.props?.shape;
  if (shape) {
    for (const [k, field] of Object.entries(shape)) {
      try {
        if ((field as z.ZodTypeAny).safeParse(null).success) keys.push(k);
      } catch {
        // a field whose parse throws is not nullable-tolerant
      }
    }
  }
  nullableKeysCache.set(type, keys);
  return keys;
}

export function validateSpec(spec: unknown): { success: boolean; error?: string } {
  // Wire-reality tolerance: hermetic's composer omits `children` on leaf
  // elements and the renderer treats that as "no children" — the envelope
  // schema requires the array. Normalize before validating so validateSpec
  // checks what matters (types, props, structure) against specs the product
  // actually produces. Tightening to always-emit-children is the deferred
  // upstream prompt rule recorded in src/spec/NOTICE (adopt with a golden
  // re-record).
  let candidate = spec;
  if (spec && typeof spec === "object" && "elements" in spec) {
    const s = spec as { elements?: Record<string, Record<string, unknown>> };
    if (s.elements && typeof s.elements === "object") {
      candidate = {
        ...spec,
        elements: Object.fromEntries(
          Object.entries(s.elements).map(([k, el]) => {
            if (!el || typeof el !== "object") return [k, el];
            let next = el;
            if (!("children" in next)) next = { ...next, children: [] };
            // Second wire-reality tolerance (review 2026-08-15): the schemas
            // declare presentation props as .nullable() but NOT .optional(),
            // while the COMPILED composer emits sparse props (absent means
            // null; the renderer reads props?.x). Every compiled save warned
            // "spec fails catalog validation" — a false alarm drowning real
            // regressions. Fill omitted nullable keys with null before
            // validating; required non-nullable keys stay enforced.
            const type = next.type;
            if (typeof type === "string" && next.props && typeof next.props === "object") {
              const nullable = nullablePropKeys(type);
              if (nullable.length > 0) {
                const props = next.props as Record<string, unknown>;
                const missing = nullable.filter((key) => !(key in props));
                if (missing.length > 0) {
                  next = {
                    ...next,
                    props: { ...props, ...Object.fromEntries(missing.map((m) => [m, null])) },
                  };
                }
              }
            }
            return [k, next];
          })
        ),
      };
    }
  }
  const result = catalog.validate(candidate);
  if (result.success) return { success: true };
  return { success: false, error: String(result.error ?? "invalid spec") };
}
