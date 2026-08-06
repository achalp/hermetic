/**
 * The candidate ledger (learning-loops spec §3 #2 infrastructure): every
 * extracted lesson lands here keyed by fingerprint, accumulating evidence
 * across runs. Nothing durable is written into prompts from the ledger —
 * graduation only ever produces a PROPOSAL a human approves (spec §4:
 * automatic writes are for counters and rankings, not rules).
 *
 * Storage: data/learning/ledger.json — same corrupt-vs-missing discipline as
 * the other stores (a corrupt file is backed up, never overwritten).
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hermeticPaths } from "@/lib/paths";
import { logger } from "@/lib/logger";
import type { LedgerEntry, LessonEvidence, LessonKind } from "@/lib/contracts/learning";
import { lessonFingerprint } from "./fingerprint";

/**
 * Evidence rows required before a candidate graduates to a proposal.
 * One run is a hypothesis; recurrence is the signal (spec: "one occurrence
 * = hypothesis"). Retreat lessons never auto-graduate regardless of count.
 */
export const GRADUATION_THRESHOLD = 2;

const ledgerFile = () => hermeticPaths.learningLedgerFile();

export async function loadLedger(): Promise<LedgerEntry[]> {
  try {
    return JSON.parse(await readFile(ledgerFile(), "utf-8")) as LedgerEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    const backup = `${ledgerFile()}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    logger.warn("Learning ledger did not parse — backing up and starting fresh", {
      backup,
      error: err instanceof Error ? err.message : String(err),
    });
    await rename(ledgerFile(), backup).catch(() => {});
    return [];
  }
}

async function saveLedger(list: LedgerEntry[]): Promise<void> {
  await mkdir(dirname(ledgerFile()), { recursive: true });
  await writeFile(ledgerFile(), JSON.stringify(list, null, 2) + "\n", "utf-8");
}

export interface CandidateInput {
  kind: LessonKind;
  parentSkill?: string;
  failureClass: string;
  lessonText: string;
  retreat: boolean;
  engineSuggestion?: string;
  errorText: string;
  evidence: LessonEvidence;
}

export interface RecordResult {
  entry: LedgerEntry;
  /** Crossed the graduation threshold on THIS record (fire proposal once). */
  graduated: boolean;
}

/**
 * Record (or reinforce) a lesson candidate. Dedup by fingerprint: a repeat
 * appends evidence and refreshes the lesson text from the newest extraction
 * (later phrasings see more context). Rejected entries stay rejected — the
 * fingerprint is the memory that a human already said no.
 */
export async function recordCandidate(input: CandidateInput): Promise<RecordResult> {
  const list = await loadLedger();
  const now = new Date().toISOString();
  const fingerprint = lessonFingerprint(input);
  let entry = list.find((e) => e.fingerprint === fingerprint);

  if (entry) {
    if (entry.status !== "rejected") {
      const dup = entry.evidence.some((e) => e.runId === input.evidence.runId);
      if (!dup) entry.evidence.push(input.evidence);
      entry.lessonText = input.lessonText;
      entry.retreat = entry.retreat || input.retreat;
      entry.engineSuggestion = input.engineSuggestion ?? entry.engineSuggestion;
      entry.updatedAt = now;
    }
  } else {
    entry = {
      id: randomUUID(),
      fingerprint,
      kind: input.kind,
      parentSkill: input.parentSkill,
      failureClass: input.failureClass,
      lessonText: input.lessonText,
      retreat: input.retreat,
      engineSuggestion: input.engineSuggestion,
      evidence: [input.evidence],
      status: "candidate",
      createdAt: now,
      updatedAt: now,
    };
    list.push(entry);
  }

  const graduated =
    entry.status === "candidate" &&
    entry.kind !== "engine-defect" && // product fixes are surfaced, not prompted
    !entry.retreat && // capitulations need a human (spec §4)
    !!entry.parentSkill && // unattributed lessons stay page-visible only
    entry.evidence.length >= GRADUATION_THRESHOLD;

  await saveLedger(list);
  return { entry, graduated };
}

export async function updateLedgerEntry(
  id: string,
  patch: Partial<Pick<LedgerEntry, "status" | "proposalId">>
): Promise<void> {
  const list = await loadLedger();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
  await saveLedger(list);
}
