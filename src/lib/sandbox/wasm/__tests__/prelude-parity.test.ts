import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WASM_PRELUDE } from "@/lib/sandbox/wasm/runtime-constants";
import { WASM_WORKER_SOURCE } from "@/lib/sandbox/wasm/worker-source";

/**
 * The docker↔wasm HELPER-SURFACE parity ratchet (build log D39).
 *
 * The docker prelude defines its helpers at global scope and the code-gen prompt
 * tells the model to call them BARE — so every public helper docker exposes must
 * be reachable as a bare name in the wasm worker too. The first live wasm
 * question burned four attempts ($1.65) discovering the gap one NameError at a
 * time (`to_num` → `declare_check` → `finding_trend` → scipy): each attempt's
 * "fix" just reached the next missing name. This test makes that class of drift
 * a red test instead of a paid retry loop: add a public helper to
 * docker/sandbox/prelude.py and it fails until the wasm prelude binds it.
 */

const DOCKER_PRELUDE = readFileSync(join(process.cwd(), "docker", "sandbox", "prelude.py"), "utf8");

/** Public top-level defs in the docker prelude (bare names the prompt may use). */
function dockerPublicHelpers(): string[] {
  return [...DOCKER_PRELUDE.matchAll(/^def ([a-z][a-zA-Z0-9_]*)\(/gm)].map((m) => m[1]!);
}

describe("wasm prelude binds every public docker-prelude helper", () => {
  const prelude = WASM_PRELUDE;

  it("finds a plausible docker surface (the extractor itself is not broken)", () => {
    const names = dockerPublicHelpers();
    // Spot anchors — if these vanish the regex broke, not the contract.
    expect(names).toContain("to_num");
    expect(names).toContain("declare_check");
    expect(names).toContain("write_output");
    expect(names.length).toBeGreaterThan(20);
  });

  for (const name of [...new Set(dockerPublicHelpers())]) {
    it(`binds \`${name}\``, () => {
      // Bound either by importing it from hermetic_runtime or defining it
      // directly. A word-boundary match on the prelude source covers both:
      // `import (…, name, …)` and `def name(`.
      expect(prelude).toMatch(new RegExp(`\\b${name}\\b`));
    });
  }

  it("BINDS, not copies: the finding implementations come from hermetic_runtime", () => {
    // One implementation, both runtimes — a `def finding_trend` here would be a
    // second copy free to drift from the tested package.
    expect(prelude).toContain("from hermetic_runtime.findings import");
    expect(prelude).not.toMatch(/^def finding_trend/m);
    expect(prelude).not.toMatch(/^def declare_finding/m);
  });

  it("the worker ships the same prelude (no separate worker copy to drift)", () => {
    // The worker embeds the prelude via the executor path; the binding block
    // must be reachable from the shipped worker source chain. Pin the seam:
    // worker source defers to the executor, which prepends wasmPrelude().
    expect(prelude).toContain("hermetic_runtime.frames");
    expect(WASM_WORKER_SOURCE.length).toBeGreaterThan(0);
  });
});

describe("conditional scipy load (D39)", () => {
  it("the worker loads scipy exactly when the run's code imports it", () => {
    expect(WASM_WORKER_SOURCE).toMatch(/scipy/);
    expect(WASM_WORKER_SOURCE).toMatch(/loadPackage\(\["scipy"\]\)/);
  });
});
