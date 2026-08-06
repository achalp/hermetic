/**
 * Graduated lessons → reviewable proposals → user-level complement skills.
 *
 * The durable write path (spec §4): a proposal is a PROPOSAL — acceptance is
 * a human click, and what it writes is always a USER skill at
 * data/skills/<parent>-learned/SKILL.md with `extends: <parent>` frontmatter.
 * Shipped built-ins are never modified; the complement mechanism
 * (skills/registry) makes the learned skill activate and render alongside
 * its parent. Accepting a second lesson for the same parent APPENDS a bullet
 * to the existing complement's guidance; skills hot-reload on mtime, so an
 * accepted lesson is live on the next question.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hermeticPaths } from "@/lib/paths";
import { logger } from "@/lib/logger";
import type { LearnedProposal, LedgerEntry } from "@/lib/contracts/learning";
import { updateLedgerEntry } from "./ledger";

const proposalsDir = () => hermeticPaths.learningProposalsDir();
const complementDirName = (parent: string) => `${parent}-learned`;

export async function listProposals(): Promise<LearnedProposal[]> {
  try {
    const files = (await readdir(proposalsDir())).filter((f) => f.endsWith(".json"));
    const all = await Promise.all(
      files.map(async (f) => {
        try {
          return JSON.parse(await readFile(join(proposalsDir(), f), "utf-8")) as LearnedProposal;
        } catch {
          return null;
        }
      })
    );
    return all
      .filter((p): p is LearnedProposal => p !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

async function saveProposal(p: LearnedProposal): Promise<void> {
  await mkdir(proposalsDir(), { recursive: true });
  await writeFile(join(proposalsDir(), `${p.id}.json`), JSON.stringify(p, null, 2), "utf-8");
}

/** Draft a proposal from a graduated ledger entry (called by harvest). */
export async function createProposal(entry: LedgerEntry): Promise<LearnedProposal> {
  const parent = entry.parentSkill!;
  const proposal: LearnedProposal = {
    id: randomUUID(),
    ledgerId: entry.id,
    parentSkill: parent,
    skillName: complementDirName(parent),
    guidanceLine: `- ${entry.lessonText.replace(/^[-•]\s*/, "")}`,
    retreat: entry.retreat,
    evidenceCount: entry.evidence.length,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await saveProposal(proposal);
  await updateLedgerEntry(entry.id, { status: "proposed", proposalId: proposal.id });
  logger.info("Learning: lesson graduated to proposal", {
    proposalId: proposal.id,
    parentSkill: parent,
    evidence: proposal.evidenceCount,
  });
  return proposal;
}

function newComplementMd(parent: string, guidanceLine: string): string {
  return `---
name: ${complementDirName(parent)}
description: Learned lessons complementing the ${parent} skill (accepted from the learning ledger)
extends: ${parent}
---
## Guidance
${guidanceLine}
`;
}

/**
 * Apply an accepted proposal: create the complement skill, or append the
 * bullet to its existing guidance. Idempotent per proposal (a re-accept of
 * an already-applied line is a no-op — the line is checked before append).
 */
export async function acceptProposal(id: string): Promise<{ applied: boolean; path: string }> {
  const proposals = await listProposals();
  const p = proposals.find((x) => x.id === id);
  if (!p) throw new Error(`No proposal ${id}`);
  if (p.status !== "pending") return { applied: false, path: "" };

  const skillDir = join(hermeticPaths.skillsDir(), p.skillName);
  const mdPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });

  let existing: string | null = null;
  try {
    existing = await readFile(mdPath, "utf-8");
  } catch {
    // first lesson for this parent
  }
  if (existing) {
    if (!existing.includes(p.guidanceLine)) {
      await writeFile(mdPath, existing.trimEnd() + "\n" + p.guidanceLine + "\n", "utf-8");
    }
  } else {
    await writeFile(mdPath, newComplementMd(p.parentSkill, p.guidanceLine), "utf-8");
  }

  p.status = "accepted";
  p.decidedAt = new Date().toISOString();
  await saveProposal(p);
  await updateLedgerEntry(p.ledgerId, { status: "accepted" });
  logger.info("Learning: proposal accepted — complement skill updated", {
    skill: p.skillName,
    path: mdPath,
  });
  return { applied: true, path: mdPath };
}

/** Reject: the ledger entry's fingerprint remembers the no — it will not re-propose. */
export async function rejectProposal(id: string): Promise<void> {
  const proposals = await listProposals();
  const p = proposals.find((x) => x.id === id);
  if (!p || p.status !== "pending") return;
  p.status = "rejected";
  p.decidedAt = new Date().toISOString();
  await saveProposal(p);
  await updateLedgerEntry(p.ledgerId, { status: "rejected" });
}
