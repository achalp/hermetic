/**
 * The entity-selection pre-step (spec §7, decided in review: K=4, hard cap 6,
 * code-gen model tier).
 *
 * ── How the LLM knows which entities can answer, WITHOUT schemas ──
 * It doesn't need schemas for the PICK. The manifest itself carries what
 * selection needs: entity names, the publisher's descriptions (with year spans
 * folded in by the adapter), and row-count hints — all harvested at connect,
 * before any parquet is touched. The pre-step shows the model that one-line-per-
 * entity INDEX and asks which entities the question needs; only the SELECTED
 * entities are then introspected (lazily, if still pending) before code-gen sees
 * their full schemas. Selection reads the catalog; code-gen reads the schemas.
 *
 * Pure logic here (index building, response parsing, fallback); the LLM call
 * lives in the route. NOT cached across questions (the scanWindow lesson: a
 * cached pick serves a wrong scope to a different question).
 */
import type { ManifestRecord } from "./store";

export const SELECT_DEFAULT_K = 4;
export const SELECT_HARD_CAP = 6;

/** One line per entity — everything selection needs, nothing it doesn't. */
export function buildEntityIndex(record: ManifestRecord): string {
  const lines: string[] = [];
  for (const s of record.entities.values()) {
    const e = s.entity;
    const rows =
      s.rowCount !== undefined
        ? `${s.rowCount.toLocaleString()} rows`
        : e.rowCountHint !== undefined
          ? `~${e.rowCountHint.toLocaleString()} rows`
          : "size unknown";
    lines.push(`- ${e.name} (${rows})${e.description ? `: ${e.description}` : ""}`);
  }
  return lines.join("\n");
}

export function buildSelectionPrompt(record: ManifestRecord, question: string): string {
  return [
    `A dataset catalog contains these entities (Parquet tables):`,
    ``,
    buildEntityIndex(record),
    ``,
    `Question: ${question}`,
    ``,
    `Which entities are needed to answer it? Prefer the FEWEST that suffice ` +
      `(usually 1; up to ${SELECT_DEFAULT_K} when a join or comparison genuinely needs them). ` +
      `Reply with ONLY a JSON object: {"entities": ["name", ...]}`,
  ].join("\n");
}

/**
 * Parse the model's pick. Robustness rules, each earned:
 *  - names are validated against the catalog (a hallucinated entity is dropped);
 *  - an entity NAMED in the question is always included, whatever the model said;
 *  - the result is capped at SELECT_HARD_CAP;
 *  - an empty/unusable reply falls back to keyword overlap, then to the largest
 *    entity — the pre-step must never leave the question with zero entities.
 */
export function parseSelection(
  raw: string,
  record: ManifestRecord,
  question: string
): { entities: string[]; usedFallback: boolean; autoIncluded: string[] } {
  const valid = new Set([...record.entities.keys()]);
  let picked: string[] = [];
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { entities?: unknown };
      if (Array.isArray(parsed.entities)) {
        picked = parsed.entities.filter((n): n is string => typeof n === "string" && valid.has(n));
      }
    } catch {
      // fall through to fallback
    }
  }
  const usedFallback = picked.length === 0;
  if (usedFallback) picked = keywordFallback(record, question);

  // Explicitly-named entities always ride along.
  const q = question.toLowerCase();
  for (const name of valid) {
    if (q.includes(name.toLowerCase()) && !picked.includes(name)) picked.push(name);
  }

  // Boundary providers ride along with any geo-themed pick. The geo recipe
  // resolves a named region's POLYGON from the divisions entity (bbox-only
  // filtering leaks neighbors — the Overture named-region rule), so a pick
  // like ["building"] for "most isolated building in Seattle" is structurally
  // doomed: the generated code MUST read divisions the pick never registered
  // (run 9ee0e56b — every retry died in the engine against files that were
  // never aliased). Selection reads only the catalog, so the tie is by
  // name/description; the cost of a wrong include is one extra entity's
  // schema + aliases, the cost of a miss is the whole run.
  const boundaryProviders = [...record.entities.values()]
    .map((s) => s.entity)
    .filter((e) =>
      /\b(divisions?|division_area|boundar(?:y|ies)|administrative)\b/i.test(
        `${e.name} ${e.description ?? ""}`
      )
    )
    .map((e) => e.name);
  const geoThemed = (name: string): boolean => {
    const s = record.entities.get(name);
    if (!s) return false;
    return /\b(building|place|road|transport|infrastructure|land|water|address|geometr|spatial|geo)\w*/i.test(
      `${s.entity.name} ${s.entity.description ?? ""}`
    );
  };
  const autoIncluded: string[] = [];
  if (picked.length > 0 && picked.some(geoThemed)) {
    for (const b of boundaryProviders) {
      if (!picked.includes(b)) {
        picked.push(b);
        autoIncluded.push(b);
      }
    }
  }

  // The hard cap must never evict a boundary provider a geo pick depends on:
  // trim from the back but keep every boundary name that made the list.
  let final = picked.slice(0, SELECT_HARD_CAP);
  for (const b of picked) {
    if (boundaryProviders.includes(b) && !final.includes(b)) {
      const evictAt = final.map((n) => boundaryProviders.includes(n)).lastIndexOf(false);
      if (evictAt >= 0) final = [...final.slice(0, evictAt), b, ...final.slice(evictAt + 1)];
    }
  }
  // autoIncluded names are ESCORTS for the model's pick (boundary polygons),
  // never a pick of their own: the caller must not let a run proceed on
  // escorts alone when every model-picked entity failed to load (observed:
  // run a897dbcc answered a BUILDINGS question with only division tables
  // after the building extraction hit a transient network error).
  return {
    entities: final,
    usedFallback,
    autoIncluded: autoIncluded.filter((n) => final.includes(n)),
  };
}

/** Deterministic fallback: token overlap between question and name+description. */
function keywordFallback(record: ManifestRecord, question: string): string[] {
  const tokens = new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3)
  );
  const scored = [...record.entities.values()].map((s) => {
    const hay = `${s.entity.name} ${s.entity.description ?? ""}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score++;
    return { name: s.entity.name, score, rows: s.rowCount ?? s.entity.rowCountHint ?? 0 };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length > 0) return hits.slice(0, SELECT_DEFAULT_K).map((s) => s.name);
  // Zero overlap: the largest entity is the least-wrong single guess.
  const largest = scored.sort((a, b) => b.rows - a.rows)[0];
  return largest ? [largest.name] : [];
}
