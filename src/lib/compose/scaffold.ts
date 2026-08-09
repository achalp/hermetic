/**
 * Deterministic scaffold (specs/narrative-compiler-2026-08-09.md §2): the
 * non-narrative layer compiled straight from the typed IR — StatCards from
 * the headline plan, charts from series roles via the component-signature
 * map, failed-check banners. No LLM anywhere in this file.
 */
import type { FindingEntry } from "@/lib/contracts/findings";
import type { SeriesEntry } from "@/lib/contracts/product";
import type { HeadlineTile } from "@/lib/findings/headline-plan";
import { COMPONENT_ROLE_SIGNATURES } from "@/lib/product/signatures";

export interface SpecPatchLine {
  op: "add";
  path: string;
  value: unknown;
}

/** Chart component for a series, from its DECLARED x kind (signature-map
 *  consistent by construction — the lint that checks generative composes
 *  is the same table this selects from). */
export function componentForSeries(s: SeriesEntry): "LineChart" | "BarChart" {
  const kind = s.roles.x.kind;
  const line = COMPONENT_ROLE_SIGNATURES.LineChart.xKinds;
  return line.includes(kind) ? "LineChart" : "BarChart";
}

export function chartElement(s: SeriesEntry): SpecPatchLine {
  const type = componentForSeries(s);
  // Chart the screened measure with its raw sibling beside it (both
  // visible — the raw-beside-attested rule at the chart layer too).
  const yKeys: string[] = [];
  for (const m of s.roles.measures) {
    yKeys.push(m.column);
    if (m.variant_of && !yKeys.includes(m.variant_of)) yKeys.push(m.variant_of);
  }
  return {
    op: "add",
    path: `/elements/chart_${s.id}`,
    value: {
      type,
      props: {
        title: humanizeId(s.id),
        data: `$chartData:${s.id}`,
        x_key: s.roles.x.column,
        y_keys: yKeys,
        ...(type === "LineChart" ? { show_dots: false, curve: "monotone" } : {}),
      },
      children: [],
    },
  };
}

export function tileElement(tile: HeadlineTile, i: number): SpecPatchLine {
  return {
    op: "add",
    path: `/elements/tile_${i}`,
    value: {
      type: "StatCard",
      props: {
        label: tile.label,
        value: tile.binding,
        ...(tile.descriptionBinding ? { description: tile.descriptionBinding } : {}),
      },
      children: [],
    },
  };
}

export function failedCheckBanner(failed: FindingEntry[]): SpecPatchLine | null {
  if (failed.length === 0) return null;
  return {
    op: "add",
    path: "/elements/compiled_check_banner",
    value: {
      type: "Annotation",
      props: {
        icon: "alert",
        severity: failed.some((f) => f.tags?.includes("blocking")) ? "error" : "warning",
        title:
          failed.length === 1
            ? "A data check failed — read the caveats below"
            : `${failed.length} data checks failed — read the caveats below`,
        content: failed.map((f) => `${f.name}: ${f.definition}`).join(" · "),
      },
      children: [],
    },
  };
}

export function humanizeId(id: string): string {
  return id
    .replace(/^step_\d+_/, "")
    .split(/[._]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
