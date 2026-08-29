import { NextResponse, type NextRequest } from "next/server";
import { getHandoffRegistry } from "@/lib/sandbox/wasm/handoff-singleton";
import type { HandoffEnvelope } from "@/lib/sandbox/wasm/handoff-registry";
import { logger } from "@/lib/logger";

/**
 * The browser worker POSTs its execution result here (spec §4a / build log D6),
 * closing the live sidecar↔webview handoff: the pipeline `create()`d a pending
 * handoff, emitted a "wasm-execute" request into the run's stream, and is awaiting
 * this POST. `resolve(id, envelope)` completes that promise so the run resumes.
 *
 * TRUST: the body is UNTRUSTED worker output. This route does only coarse
 * validation (id present, body an object, size cap) — the real shape/size/depth
 * gate is the relay (validateWorkerResult in handoff.ts), which runs before the
 * envelope is decoded into an ExecutionResult. The id is a crypto UUID minted
 * server-side, so a guessed POST cannot resolve a run it doesn't own.
 */

// Coarse DoS guard (Content-Length is advisory — a chunked body still streams
// into req.json(); this stops an honest oversized POST early). Mirrors the
// relay's own 64 MiB envelope cap so a body the relay would reject anyway can't
// buffer past it here.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "invalid envelope" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  // Coerce only the fields resolve() stores; a non-numeric exitCode becomes NaN
  // so the downstream relay integer check rejects it (never trusted as 0).
  const envelope: HandoffEnvelope = {
    exitCode: typeof b.exitCode === "number" ? b.exitCode : Number.NaN,
    output: b.output,
    ...(typeof b.stderr === "string" ? { stderr: b.stderr } : {}),
  };

  const resolved = getHandoffRegistry().resolve(id, envelope);
  if (!resolved) {
    // Unknown or already-settled id: a late duplicate, a timed-out handoff, or a
    // guessed id. Nothing the caller can fix — 404, no detail leaked.
    logger.debug("wasm-result for unknown handoff id", { id });
    return NextResponse.json({ resolved: false }, { status: 404 });
  }
  return NextResponse.json({ resolved: true });
}
