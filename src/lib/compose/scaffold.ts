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
import type { JsonPatch } from "@/spec/core/types";

/**
 * The compiled composer only ever ADDS elements, so its emitted line is the
 * strict validated `JsonPatch` (op+path required — spec/core, the renderer's
 * own type) narrowed to `op: "add"` with a required `value`. Deriving it from
 * JsonPatch keeps the compiled producer from drifting from the runtime truth
 * (PE-1 4-way PatchLine dup); the loose consumer-side counterpart is the
 * `PatchLine` contract used at the streaming boundary.
 */
export type SpecPatchLine = JsonPatch & { op: "add"; value: unknown };

/** Chart component for a series, from its DECLARED x kind (signature-map
 *  consistent by construction — the lint that checks generative composes
 *  is the same table this selects from). */
export function componentForSeries(s: SeriesEntry): "LineChart" | "BarChart" {
  const kind = s.roles.x.kind;
  const line = COMPONENT_ROLE_SIGNATURES.LineChart.xKinds ?? ["temporal", "ordinal"];
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

/**
 * Plain-language explanation of what a "data check" is — shown behind the callouts'
 * "what does this mean?" disclosure so a non-technical reader can understand a flag
 * without wading through the mechanics. Kept here so the summary banner and the
 * per-check caveats (compile.ts) share one wording.
 */
export const DATA_CHECK_EXPLANATION =
  "A data check is an automatic test the analysis runs to catch problems in the numbers — " +
  "like totals that don't reconcile or values that look unusual. A check that doesn't pass " +
  "isn't necessarily an error; it's a signal to read the related figure with a little extra care.";

export function failedCheckBanner(failed: FindingEntry[]): SpecPatchLine | null {
  if (failed.length === 0) return null;
  const blocking = failed.some((f) => f.tags?.includes("blocking"));
  const names = failed.map((f) => humanizeId(f.name));
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return {
    op: "add",
    path: "/elements/compiled_check_banner",
    value: {
      type: "Annotation",
      props: {
        // Flag (🚩), not the alarm bell, unless a check is genuinely blocking — the
        // note is a "read with care", not an error.
        icon: blocking ? "alert" : "flag",
        severity: blocking ? "error" : "warning",
        title:
          failed.length === 1
            ? "One result is worth a closer look"
            : `${failed.length} results are worth a closer look`,
        content:
          `${list} didn't fully pass an automatic quality check. ` +
          `The related figures still stand — they just deserve a second glance, explained in the notes on this page.`,
        details: DATA_CHECK_EXPLANATION,
        detailsLabel: "What does this mean?",
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
