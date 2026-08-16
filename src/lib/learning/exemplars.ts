/**
 * The verified-exemplar bank (learning-loops spec §3 #3): a run that
 * executed, passed semantic validation, and got grounded is banked as
 * working code for its ⟨schema, question⟩ neighborhood, so the next similar
 * question starts from proven code instead of re-running the whack-a-mole.
 *
 * Privacy floor (spec §4): structure only — column names/dtypes, domain,
 * question, hermetic-generated code. Never data values.
 *
 * Retrieval is deterministic and local (no embeddings, no network): domain
 * match + active-skill overlap + question keyword Jaccard.
 */
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hermeticPaths } from "@/lib/paths";
import { logger, errMessage } from "@/lib/logger";
import { CONTRACT_GENERATION, type Exemplar } from "@/lib/contracts/learning";
import { schemaFingerprint } from "./fingerprint";

const MAX_EXEMPLARS = 50;
const dir = () => hermeticPaths.learningExemplarsDir();

export async function listExemplars(): Promise<Exemplar[]> {
  try {
    const files = (await readdir(dir())).filter((f) => f.endsWith(".json"));
    const all = await Promise.all(
      files.map(async (f) => {
        try {
          return JSON.parse(await readFile(join(dir(), f), "utf-8")) as Exemplar;
        } catch {
          return null;
        }
      })
    );
    return all
      .filter((e): e is Exemplar => e !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export interface BankInput {
  runId: string;
  question: string;
  columns: Array<{ name: string; dtype: string }>;
  detectedDomain: string | null;
  activeSkills: string[];
  code: string;
  attempts: number;
  rowCount: number;
}

/**
 * Bank a verified success. Dedup by ⟨schemaFingerprint, normalized question⟩
 * — a repeat of the same question on the same shape updates in place (the
 * newest verified code wins). Prunes oldest past the cap.
 */
export async function bankExemplar(input: BankInput): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true });
    const fp = schemaFingerprint(input.columns);
    const qNorm = normalizeQuestion(input.question);
    const existing = (await listExemplars()).find(
      (e) => e.schemaFingerprint === fp && normalizeQuestion(e.question) === qNorm
    );
    const entry: Exemplar = {
      id: existing?.id ?? randomUUID(),
      contractGen: CONTRACT_GENERATION,
      runId: input.runId,
      question: input.question,
      schemaFingerprint: fp,
      detectedDomain: input.detectedDomain,
      columnNames: input.columns.map((c) => c.name),
      activeSkills: input.activeSkills,
      code: input.code,
      attempts: input.attempts,
      rowCount: input.rowCount,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir(), `${entry.id}.json`), JSON.stringify(entry, null, 2), "utf-8");

    const all = await listExemplars();
    for (const stale of all.slice(MAX_EXEMPLARS)) {
      await unlink(join(dir(), `${stale.id}.json`)).catch(() => {});
    }
  } catch (err) {
    logger.debug("Exemplar banking failed — skipping (learning is best-effort)", {
      error: errMessage(err),
    });
  }
}

const STOPWORDS = new Set(
  "the a an of in on for by with and or to is are what which how many much most does do show me per".split(
    " "
  )
);

function keywords(q: string): Set<string> {
  return new Set(
    q
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function normalizeQuestion(q: string): string {
  return [...keywords(q)].sort().join(" ");
}

export interface RetrieveInput {
  question: string;
  columns: Array<{ name: string; dtype: string }>;
  detectedDomain: string | null;
  activeSkills: string[];
}

/**
 * Best exemplar for a new run, or null when nothing clears the floor.
 * Score: exact schema match dominates; then domain equality, skill-set
 * overlap, and question keyword Jaccard. The floor keeps weak matches out
 * of the prompt — a wrong exemplar is worse than none.
 */
export function scoreExemplar(e: Exemplar, input: RetrieveInput): number {
  const fp = schemaFingerprint(input.columns);
  let score = 0;
  if (e.schemaFingerprint === fp) score += 3;
  if (e.detectedDomain && e.detectedDomain === input.detectedDomain) score += 1;
  const skillOverlap = e.activeSkills.filter((s) => input.activeSkills.includes(s)).length;
  score += Math.min(skillOverlap, 2) * 0.5;
  const a = keywords(e.question);
  const b = keywords(input.question);
  const inter = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size || 1;
  score += (inter / union) * 2;
  return score;
}

export async function retrieveExemplar(input: RetrieveInput): Promise<Exemplar | null> {
  // Stale-generation exemplars are never retrieved: code banked under a
  // retired contract re-seeds retired behavior on similar questions.
  const all = (await listExemplars()).filter((x) => (x.contractGen ?? 0) === CONTRACT_GENERATION);
  if (all.length === 0) return null;
  const scored = all
    .map((e) => ({ e, score: scoreExemplar(e, input) }))
    .sort((x, y) => y.score - x.score);
  const best = scored[0];
  // Floor: schema match alone qualifies; otherwise require domain/skill
  // affinity AND real question similarity.
  return best.score >= 2.5 ? best.e : null;
}

/** User curation (Learning page): remove a banked exemplar. */
export async function deleteExemplar(id: string): Promise<boolean> {
  try {
    if (!/^[a-f0-9-]{8,40}$/.test(id)) return false;
    await unlink(join(dir(), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Quality veto (run-40 review): banking happens at pipeline success, but
 *  the lint battery runs later — a run flagged with severe advisories must
 *  not teach. Withdraws the exemplar the run just banked (or refreshed). */
export async function vetoExemplarByRunId(runId: string): Promise<boolean> {
  try {
    const hit = (await listExemplars()).find((x) => x.runId === runId);
    if (!hit) return false;
    await unlink(join(dir(), `${hit.id}.json`));
    logger.info("Learning: exemplar vetoed — run was lint-flagged", { runId, id: hit.id });
    return true;
  } catch {
    return false;
  }
}
