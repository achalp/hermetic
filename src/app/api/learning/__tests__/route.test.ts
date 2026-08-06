import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setPathRoots } from "@/lib/paths";
import { recordCandidate } from "@/lib/learning/ledger";
import { createProposal } from "@/lib/learning/proposals";
import { GET } from "../route";
import { POST } from "../proposals/[id]/route";
import type { LearningState } from "@/lib/contracts/learning";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "learning-route-"));
  setPathRoots({ dataRoot: root });
});
afterEach(() => {
  setPathRoots({});
  rmSync(root, { recursive: true, force: true });
});

async function seedProposal() {
  await recordCandidate(base("run-1"));
  const { entry } = await recordCandidate(base("run-2"));
  return createProposal(entry);
}

function base(runId: string) {
  return {
    kind: "domain-guidance" as const,
    parentSkill: "geo-overture",
    failureClass: "py_ValueError",
    lessonText: "division_area lookups: do not filter region.",
    retreat: false,
    errorText: "ValueError: San Francisco not found in division_area",
    evidence: { runId, ts: "t", errorHead: "e" },
  };
}

describe("GET /api/learning", () => {
  it("returns ledger, proposals, defects, and exemplar count", async () => {
    await seedProposal();
    await recordCandidate({
      ...base("run-3"),
      kind: "engine-defect",
      parentSkill: undefined,
      errorText: "wrong shape for write_output — expected record, received array",
    });
    const res = await GET();
    const state = (await res.json()) as LearningState;
    expect(state.proposals).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.engineDefects).toHaveLength(1);
    expect(state.exemplarCount).toBe(0);
  });
});

describe("POST /api/learning/proposals/[id]", () => {
  it("accept writes the user-level complement skill (never a built-in)", async () => {
    const p = await seedProposal();
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ action: "accept" }) }),
      { params: Promise.resolve({ id: p.id }) }
    );
    const body = (await res.json()) as { ok: boolean; applied: boolean; path: string };
    expect(body.applied).toBe(true);
    expect(body.path).toContain(join("skills", "geo-overture-learned", "SKILL.md"));
    expect(body.path).toContain(root); // data dir, not the repo's builtin/
    const md = readFileSync(body.path, "utf-8");
    expect(md).toContain("extends: geo-overture");
  });

  it("validates the body and 404s unknown proposals", async () => {
    const bad = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ action: "purge" }) }),
      { params: Promise.resolve({ id: "x" }) }
    );
    expect(bad.status).toBe(400);
    const missing = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ action: "accept" }) }),
      { params: Promise.resolve({ id: "nope" }) }
    );
    expect(missing.status).toBe(404);
  });
});
