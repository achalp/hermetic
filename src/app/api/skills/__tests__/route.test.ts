import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/skills — merges built-in skills with user skills/modules and
 * surfaces per-file validation errors. Registry + loaders mocked at their
 * module boundaries so the shaping logic is under test.
 */
vi.mock("@/lib/skills/registry", () => ({
  BUILTIN_SKILLS: [
    {
      name: "builtin-a",
      description: "d",
      origin: "builtin",
      order: 1,
      reviewGate: true,
      helpers: [{ moduleName: "helper_x" }],
    },
  ],
}));
const loadUserSkills = vi.fn();
const loadUserModules = vi.fn();
vi.mock("@/lib/skills/user-skills", () => ({ loadUserSkills: () => loadUserSkills() }));
vi.mock("@/lib/skills/user-modules", () => ({ loadUserModules: () => loadUserModules() }));

import { GET } from "@/app/api/skills/route";

beforeEach(() => {
  vi.clearAllMocks();
  loadUserSkills.mockReturnValue({
    skills: [
      {
        name: "user-b",
        description: "ud",
        origin: "user",
        order: 2,
        reviewGate: false,
        helpers: [],
        sourcePath: "/data/skills/b/SKILL.md",
      },
    ],
    errors: [{ path: "/data/skills/bad", reason: "no frontmatter" }],
  });
  loadUserModules.mockReturnValue({
    modules: [
      {
        moduleName: "utils",
        sourcePath: "/data/user_lib/utils.py",
        functions: [{ name: "clean", signature: "df" }],
      },
    ],
    errors: [],
  });
});

describe("GET /api/skills", () => {
  it("merges builtin + user skills, maps helpers, and surfaces errors", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills.map((s: { name: string }) => s.name)).toEqual(["builtin-a", "user-b"]);
    expect(body.skills[0].helpers).toEqual(["skill_lib.helper_x"]);
    expect(body.skills[0].reviewGate).toBe(true);
    expect(body.skillErrors).toHaveLength(1);
    expect(body.userModules[0].module).toBe("user_lib.utils");
    expect(body.userModules[0].functions).toEqual(["clean(df)"]);
    expect(body.userModuleErrors).toEqual([]);
  });
});
