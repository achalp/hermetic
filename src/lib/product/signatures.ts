/**
 * Component role signatures (analysis-product spec, deferred item 1): the
 * chart-choice layer of the Binding Catalog. A declared series carries its x
 * KIND; some components only render one family of x correctly — a LineChart
 * over a categorical x draws a trend through unordered categories, a
 * PieChart over a temporal x slices a time axis. With roles declared, that
 * mismatch is checkable deterministically at compose time.
 *
 * The map is deliberately SMALL and confident: only components where a
 * wrong x kind is a defect, not a style choice. Components absent from the
 * map accept any series (BarChart renders every kind legitimately).
 * Advisory posture, like every lint: flag, never block.
 */
import type { SeriesXKind } from "@/lib/contracts/product";
import type { FindingIssue } from "@/lib/contracts/findings";
import type { ProductRolesIndex } from "./index";

export const COMPONENT_ROLE_SIGNATURES: Record<string, { xKinds: SeriesXKind[] }> = {
  LineChart: { xKinds: ["temporal", "ordinal"] },
  AreaChart: { xKinds: ["temporal", "ordinal"] },
  StreamChart: { xKinds: ["temporal", "ordinal"] },
  CandlestickChart: { xKinds: ["temporal"] },
  DualAxisChart: { xKinds: ["temporal", "ordinal"] },
  PieChart: { xKinds: ["categorical"] },
};

const BINDING_RE = /\$(?:chartData|series):([a-zA-Z0-9_]+)/;

/**
 * Check one PRE-resolution spec line: a component in the signature map whose
 * props bind a DECLARED series must accept that series' x kind. Post-
 * resolution the binding token is gone, so callers pass the raw line.
 * Undeclared chart keys are unchecked (no roles to check against).
 */
export function lintComponentSignature(
  rawLine: string,
  rolesIdx: ProductRolesIndex
): FindingIssue[] {
  if (rolesIdx.size === 0 || !rawLine.includes("$")) return [];
  let patch: { value?: { type?: unknown; props?: unknown } };
  try {
    patch = JSON.parse(rawLine) as typeof patch;
  } catch {
    return [];
  }
  const type = patch.value?.type;
  if (typeof type !== "string") return [];
  const sig = COMPONENT_ROLE_SIGNATURES[type];
  if (!sig) return [];
  const m = BINDING_RE.exec(JSON.stringify(patch.value?.props ?? {}));
  if (!m) return [];
  const info = rolesIdx.get(m[1]);
  if (!info || sig.xKinds.includes(info.xKind as SeriesXKind)) return [];
  return [
    {
      kind: "component_role_mismatch",
      name: m[1],
      detail: `${type} binds series ${m[1]}, whose declared x (${info.xCol}) is ${info.xKind} — ${type} renders ${sig.xKinds.join("/")} x axes; use a component matching the declared kind (e.g. BarChart for categories, LineChart for time)`,
    },
  ];
}
