/**
 * Next.js instrumentation. `register()` runs once inside the server process that
 * binds the port and handles requests. We only need Node-runtime behavior, and
 * node:http/node:https can't be bundled for the Edge runtime — so the actual work
 * lives in "./instrumentation-node", dynamically imported ONLY under the nodejs
 * runtime so the Edge bundle never sees those imports.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { raiseServerTimeouts, installConnectionErrorGuard } =
    await import("./instrumentation-node");
  await raiseServerTimeouts();
  // A client leaving mid-stream (reload / tab close / laptop sleep) must not
  // read as a server fault or risk a worker — downgrade those to debug.
  installConnectionErrorGuard();
  // Periodic expiry for the in-memory stores + tmpdir orphan cleanup —
  // previously all lazy-read-only, so never-touched entries (including live
  // warehouse connector pools) leaked. See lib/store-sweeper.ts.
  const { startStoreSweeper } = await import("./lib/store-sweeper");
  startStoreSweeper();
}
