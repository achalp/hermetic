/**
 * Next.js instrumentation. `register()` runs once inside the server process that
 * binds the port and handles requests. We only need Node-runtime behavior, and
 * node:http/node:https can't be bundled for the Edge runtime — so the actual work
 * lives in "./instrumentation-node", dynamically imported ONLY under the nodejs
 * runtime so the Edge bundle never sees those imports.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { raiseServerTimeouts } = await import("./instrumentation-node");
  await raiseServerTimeouts();
}
