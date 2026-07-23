// GENERATED-ONCE from the buildGeospatialGuidance monolith in llm/prompts.ts
// (split 2026-07-22, see spec/skills-implementation-plan-2026-07-22.md).
// The equivalence snapshot test locks the concatenated output byte-for-byte —
// edit the text here freely going forward, but update the snapshots knowingly.
// Section 3: the map must show the answer + scope disclosure.
import type { SkillDefinition, SkillRenderContext } from "../types";
import { hasBareGeometryColumn } from "../triggers";

export const mapAnswerVisibility: SkillDefinition = {
  name: "map-answer-visibility",
  description:
    "Superlative maps must contain the winner (union top-N into the plotted layer) and results must disclose analysis scope",
  order: 30,
  origin: "builtin",
  reviewGate: true,
  requires: ["geo-overture"],
  triggers: {
    when: hasBareGeometryColumn,
    label: "geometry column present (no GeoJSON sidecar)",
  },
  buildGuidance(_ctx: SkillRenderContext): string {
    return `THE MAP MUST SHOW THE ANSWER — when you plot points on a map/scatter for a superlative and you SAMPLE for context (e.g. a random \`np.random.choice(..., 2000)\` of the millions, to show the NN-distance distribution), that uniform sample essentially NEVER contains the single most-extreme building — so the ACTUAL ANSWER is INVISIBLE on the map (observed: the most-isolated Seattle building, at the edge of Seward Park, was absent because it wasn't in the 2,000-point sample). Rules: (1) ALWAYS union the top-N winners (which you already have) INTO whatever point layer the map binds to — never hand the map a bare random sample. (2) TAG the winners with a field the chart can key on — e.g. \`rank\` (1..N) or \`is_winner\`=True — and color/size the layer by the metric so the winner visibly stands out (it is by definition the extreme value). (3) Prefer making the top-N the PRIMARY map layer (guaranteed to include the winner) with any sample as faint context underneath, rather than a sample that merely might contain it. The point of the map is to LOCATE the answer; a map that omits it has failed the question. (4) ATTACH per-building values (e.g. the NN distance) to the map SAMPLE by POSITION — index the arrays you already computed at the sample's row indices (\`sample_df["nn_m"] = nn_m[sample_idx]\`). NEVER build a Python dict/Series over ALL N rows to do it: \`{int(rowid[i]): float(nn_m[i]) for i in range(len(c))}\` is ~150 bytes PER ENTRY ≈ GIGABYTES at millions of rows — a pure-Python OOM that the .df() cap and assert_fits CANNOT see because it isn't a DataFrame (OBSERVED: a full-N dict built just to label a 2,000-row sample OOM'd a 14M-building California run at 90% of a 5 GB cap, on top of the coords frame + KD-tree already resident). The same rule holds for hydrating winners — you already have their positions; index, don't build an N-sized map.
SCOPE DISCLOSURE — if you bound the analysis (a region rather than everything asked, an approximate/sampled method, or a very large count), set results["analysis_scope"] to a short sentence stating exactly what was covered and how (e.g. "Analyzed all 11,240,338 buildings inside the California boundary polygon (Overture division_area, region=US-CA) via an exact KD-tree."). If you filtered by a raw bounding box rather than the true boundary, SAY SO explicitly ("...within the California bounding box, which includes some neighboring-state points") — do not imply the result is confined to the named area when it is not. Report the actual number of points analyzed.\n`;
  },
};
