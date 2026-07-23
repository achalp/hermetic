import { NextResponse } from "next/server";
import { BUILTIN_SKILLS } from "@/lib/skills/registry";
import { loadUserSkills } from "@/lib/skills/user-skills";
import { loadUserModules } from "@/lib/skills/user-modules";

/**
 * GET /api/skills — the settings surface for the skills registry: every known
 * skill (built-in + user) and user Python module, INCLUDING per-file
 * validation errors so a rejected SKILL.md/module is visible with its reason
 * instead of silently absent. Read-only; skills/modules are edited on disk
 * (data/skills/, data/user_lib/).
 */
export async function GET() {
  const userSkills = loadUserSkills();
  const userModules = loadUserModules();
  return NextResponse.json({
    skills: [
      ...BUILTIN_SKILLS.map((s) => ({
        name: s.name,
        description: s.description,
        origin: s.origin,
        order: s.order,
        reviewGate: !!s.reviewGate,
        helpers: s.helpers?.map((h) => `skill_lib.${h.moduleName}`) ?? [],
      })),
      ...userSkills.skills.map((s) => ({
        name: s.name,
        description: s.description,
        origin: s.origin,
        order: s.order,
        reviewGate: !!s.reviewGate,
        helpers: s.helpers?.map((h) => `skill_lib.${h.moduleName}`) ?? [],
        sourcePath: s.sourcePath,
      })),
    ],
    skillErrors: userSkills.errors,
    userModules: userModules.modules.map((m) => ({
      module: `user_lib.${m.moduleName}`,
      sourcePath: m.sourcePath,
      functions: m.functions.map((f) => `${f.name}(${f.signature})`),
    })),
    userModuleErrors: userModules.errors,
  });
}
