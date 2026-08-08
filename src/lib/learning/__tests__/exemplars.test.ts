import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots, hermeticPaths } from "@/lib/paths";
import {
  bankExemplar,
  listExemplars,
  retrieveExemplar,
  deleteExemplar,
} from "@/lib/learning/exemplars";

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "hermetic-ex-"));
  setPathRoots({ dataRoot: root });
});

describe("exemplar retirement-era behavior (learning review)", () => {
  it("stale-generation exemplars are never retrieved", async () => {
    await bankExemplar({
      runId: "r1",
      question: "how have prices changed over time",
      columns: [
        { name: "year", dtype: "number" },
        { name: "price", dtype: "number" },
      ],
      detectedDomain: null,
      activeSkills: [],
      code: "print('fresh')",
      attempts: 1,
      rowCount: 10,
    });
    // Forge a stale one by rewriting its stamp on disk.
    const all = await listExemplars();
    expect(all).toHaveLength(1);
    const fresh = await retrieveExemplar({
      question: "how have prices changed over time",
      columns: [
        { name: "year", dtype: "number" },
        { name: "price", dtype: "number" },
      ],
      detectedDomain: null,
      activeSkills: [],
    });
    expect(fresh?.code).toContain("fresh");
    const dir = join(hermeticPaths.learningExemplarsDir(), `${all[0].id}.json`);
    const raw = JSON.parse(readFileSync(dir, "utf-8"));
    raw.contractGen = 1;
    writeFileSync(dir, JSON.stringify(raw));
    const stale = await retrieveExemplar({
      question: "how have prices changed over time",
      columns: [
        { name: "year", dtype: "number" },
        { name: "price", dtype: "number" },
      ],
      detectedDomain: null,
      activeSkills: [],
    });
    expect(stale).toBeNull();
  });

  it("deleteExemplar removes and rejects bad ids", async () => {
    await bankExemplar({
      runId: "r2",
      question: "q2 about totals",
      columns: [{ name: "a", dtype: "number" }],
      detectedDomain: null,
      activeSkills: [],
      code: "x=1",
      attempts: 2,
      rowCount: 5,
    });
    const [e] = await listExemplars();
    expect(await deleteExemplar("../../etc/passwd")).toBe(false);
    expect(await deleteExemplar(e.id)).toBe(true);
    expect(await listExemplars()).toHaveLength(0);
  });
});
