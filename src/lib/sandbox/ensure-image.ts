/**
 * Make the sandbox image present before the first container starts.
 *
 * The web path builds it (`start.sh`: `docker build -t hermetic-sandbox`), so it
 * has a Dockerfile and a toolchain. The DESKTOP app has neither — it ships a
 * sidecar, not a repo — so if Docker is to be a real option there (and it must
 * be: WASM is the least-proven tier and it was the only one desktop users could
 * reach), the engine has to arrive some other way.
 *
 * It arrives from GHCR, which the release workflow already publishes and attests
 * (`ghcr.io/<owner>/<repo>-sandbox:<version>`). Anonymous pull works — verified
 * against the live registry via the token exchange — so no credential handling
 * is needed for a user who just downloaded an app.
 *
 * Pinned to the app's OWN version, never `latest`: the image and the code that
 * drives it are one artifact, and a `latest` that moved under a pinned app is
 * how a sandbox starts failing on a machine nobody touched.
 */
import { run } from "@/lib/sandbox/docker-utils";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_REMOTE_IMAGE_REPO } from "@/lib/constants";
import { logger } from "@/lib/logger";

/** Pull progress, so a multi-GB first run is visible rather than a silent stall. */
export type ImagePullProgress = (evt: {
  phase: "checking" | "pulling" | "ready";
  note?: string;
}) => void;

let ensured: Promise<void> | null = null;

/** Local presence check — cheap, and the common path on every run after the first. */
async function imagePresent(): Promise<boolean> {
  const res = await run("docker", ["image", "inspect", DOCKER_SANDBOX_IMAGE], {
    timeoutMs: 15_000,
  }).catch(() => null);
  return !!res && res.exitCode === 0;
}

/**
 * Ensure `hermetic-sandbox` exists locally, pulling it from GHCR if not.
 *
 * Memoized per process on SUCCESS only: a failed pull (offline, registry down)
 * must not be cached into a permanent refusal — the next run retries, matching
 * how the daemon-memory probe treats its own failures.
 */
export function ensureSandboxImage(
  appVersion: string,
  onProgress?: ImagePullProgress
): Promise<void> {
  if (ensured) return ensured;
  const attempt = (async () => {
    onProgress?.({ phase: "checking" });
    if (await imagePresent()) {
      onProgress?.({ phase: "ready" });
      return;
    }
    const remote = `${SANDBOX_REMOTE_IMAGE_REPO}:${appVersion}`;
    logger.info("Sandbox image missing — pulling", { remote });
    onProgress?.({
      phase: "pulling",
      note: `Fetching the analysis engine (${remote}). First run only.`,
    });
    // No timeout: this is a multi-hundred-MB download over the user's connection,
    // the same reason a value profile has no wall clock. A stuck pull is the
    // user's to cancel, not a timer's to guess at.
    const pull = await run("docker", ["pull", remote]);
    if (pull.exitCode !== 0) {
      throw new Error(
        `Could not fetch the analysis engine (${remote}). ` +
          `Check your connection, or switch the runtime to the built-in engine in Settings. ` +
          `Docker said: ${(pull.stderr || pull.stdout || "").trim().slice(0, 200)}`
      );
    }
    // Tag to the local name every call site already uses, so nothing downstream
    // has to know whether the image was built here or pulled.
    const tag = await run("docker", ["tag", remote, DOCKER_SANDBOX_IMAGE], { timeoutMs: 30_000 });
    if (tag.exitCode !== 0) {
      throw new Error(`Fetched the engine but could not tag it as ${DOCKER_SANDBOX_IMAGE}.`);
    }
    logger.info("Sandbox image ready", { image: DOCKER_SANDBOX_IMAGE, from: remote });
    onProgress?.({ phase: "ready" });
  })();
  ensured = attempt.catch((err) => {
    ensured = null; // retryable: see the memoization note above
    throw err;
  });
  return ensured;
}

/** Test seam: forget the memoized success. */
export function resetSandboxImageCacheForTests(): void {
  ensured = null;
}
