/**
 * Live-container guard for the sandbox hardening flags (finding M10 regression).
 *
 * The unit test asserts the flag ARRAY; it cannot catch a flag that makes the
 * real container fail to start. `--security-opt no-new-privileges` did exactly
 * that — execve of python3 returned EPERM against this image, breaking every
 * run, and the arg-array test was green throughout. This test actually starts
 * the image WITH the production hardening args and asserts python3 execs.
 *
 * Skipped when docker or the hermetic-sandbox image is unavailable (CI without
 * a built image), so it never blocks — but on any machine that can run the
 * sandbox, a hardening flag that breaks container startup fails here.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { DOCKER_SANDBOX_IMAGE } from "@/lib/constants";
import { sandboxHardeningRunArgs } from "@/lib/sandbox/hardening";

const canRun = (() => {
  try {
    execFileSync("docker", ["image", "inspect", DOCKER_SANDBOX_IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("sandbox hardening — live container", () => {
  it.skipIf(!canRun)("starts the image and execs python3 under the hardening flags", async () => {
    const out = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        ...(await sandboxHardeningRunArgs()),
        DOCKER_SANDBOX_IMAGE,
        "python3",
        "-c",
        "import pandas, duckdb; print('HARDENED_OK')",
      ],
      { encoding: "utf8", timeout: 60_000 }
    );
    expect(out).toContain("HARDENED_OK");
  });
});
