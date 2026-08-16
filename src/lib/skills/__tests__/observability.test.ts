import { describe, it, expect, vi, beforeEach } from "vitest";

const { artifacts, events } = vi.hoisted(() => ({
  artifacts: [] as { name: string; content: string }[],
  events: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/logger", () => ({
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRunIdProvider: vi.fn(),
}));
vi.mock("@/lib/diagnostics/run-recorder", () => ({
  recordRunArtifact: (name: string, content: string) => artifacts.push({ name, content }),
  recordRunEvent: (e: Record<string, unknown>) => events.push(e),
}));
vi.mock("@/lib/diagnostics/run-diagnostics", () => ({
  diagEvent: (type: string, data: Record<string, unknown>) => events.push({ type, ...data }),
}));

import { reportSkillActivation } from "@/lib/skills/observability";
import { logger } from "@/lib/logger";
import type { ActiveSkills, SkillDefinition } from "@/lib/skills/types";

function fakeActive(): ActiveSkills {
  const def: SkillDefinition = {
    name: "geo-overture",
    description: "d",
    order: 10,
    origin: "builtin",
    triggers: {},
    buildGuidance: () => "g",
    reviewGate: true,
  };
  return {
    skills: [{ def, reason: "geometry column present", viaQuestion: false }],
    reviewGated: true,
    reviewRules: ["R — rule"],
    failureHints: [{ pattern: "pivot", hint: "h", skill: "geo-overture" }],
    helperFiles: [{ path: "/data/skill_lib/geo.py", content: "def f():\n    pass\n" }],
    preludeSnippets: [],
    prefixGuidance: () => "g",
    questionGuidance: () => "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  artifacts.length = 0;
  events.length = 0;
});

describe("reportSkillActivation", () => {
  it("logs NAMES and reasons (never bare counts) to the console line", () => {
    reportSkillActivation(fakeActive());
    expect(logger.info).toHaveBeenCalledWith(
      "Skills activated",
      expect.objectContaining({
        skills: ["geo-overture"],
        reasons: { "geo-overture": "geometry column present" },
        reviewGated: true,
      })
    );
  });

  it("writes skills.json to the run dir with the full activation record", () => {
    reportSkillActivation(fakeActive());
    const artifact = artifacts.find((a) => a.name === "skills.json");
    expect(artifact).toBeDefined();
    const parsed = JSON.parse(artifact!.content);
    expect(parsed.skills[0]).toMatchObject({
      name: "geo-overture",
      origin: "builtin",
      reason: "geometry column present",
      viaQuestion: false,
    });
    expect(parsed.reviewGated).toBe(true);
    expect(parsed.failureHints).toEqual([{ skill: "geo-overture", pattern: "pivot" }]);
  });

  it("journals a skills_activated event on both diagnostics channels", () => {
    reportSkillActivation(fakeActive());
    const journaled = events.filter(
      (e) => e.type === "skills_activated" && Array.isArray(e.skills)
    );
    expect(journaled).toHaveLength(2); // diagEvent + recordRunEvent
  });

  it("logs a quiet debug line (no journal noise) when nothing activated", () => {
    reportSkillActivation({
      skills: [],
      reviewGated: false,
      reviewRules: [],
      failureHints: [],
      helperFiles: [],
      preludeSnippets: [],
      prefixGuidance: () => "",
      questionGuidance: () => "",
    });
    expect(logger.debug).toHaveBeenCalledWith("Skills: none matched");
    expect(logger.info).not.toHaveBeenCalled();
    expect(artifacts).toEqual([]);
    expect(events).toEqual([]);
  });
});
