/**
 * The main-thread RELAY validator (spec §7, security F2/F3/R2).
 *
 * The execution worker is UNTRUSTED. Its only channel to the trusted sidecar is
 * `postMessage`, so the main-thread relay must accept ONLY a strict, bounded
 * result envelope and forward NOTHING else — never a raw worker message. This is
 * the pure decision function behind that relay: it validates shape, caps the
 * serialized size (a giant envelope must not OOM the sidecar — the §6a/§7 read
 * cap's counterpart), and bounds nesting depth (a deeply-nested payload must not
 * blow the composer / a recursive consumer). It does NOT type-close the open
 * findings/series registries (those stay `z.unknown()` downstream by design —
 * final-gate R2); it bounds size/depth/breadth and leaves semantic validation to
 * lib/findings / lib/product.
 *
 * Kept dependency-free and pure so it is trivially 100%-covered and reusable by
 * both the Node-worker (Phase 1a) and the browser relay (Phase 1c).
 */

/** The single message shape the relay will forward. Anything else is dropped. */
export interface WorkerResultMessage {
  kind: "result";
  /** 0 = success; non-zero routes through parseSandboxOutput's error path. */
  exitCode: number;
  /** The raw output.json content — untrusted, size/depth-bounded, not type-checked here. */
  output: unknown;
  /** Optional captured stderr (bounded by maxBytes with the rest). */
  stderr?: string;
}

export type RelayVerdict =
  { ok: true; message: WorkerResultMessage } | { ok: false; reason: string };

export interface RelayLimits {
  /** Max serialized envelope size in bytes. */
  maxBytes: number;
  /** Max object/array nesting depth. */
  maxDepth: number;
}

/** Defaults: 64 MB envelope (well under the sidecar's headroom), depth 64. */
export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
};

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Depth of the deepest nested array/object, counting the root as depth 1.
 * Returns Infinity as soon as `limit` is exceeded (bounded work, no full walk of
 * a pathological payload).
 */
export function measureDepth(value: unknown, limit: number): number {
  const walk = (v: unknown, depth: number): number => {
    if (depth > limit) return Infinity;
    if (Array.isArray(v)) {
      let max = depth;
      for (const item of v) {
        const d = walk(item, depth + 1);
        if (d === Infinity) return Infinity;
        if (d > max) max = d;
      }
      return max;
    }
    if (isPlainRecord(v)) {
      let max = depth;
      for (const key of Object.keys(v)) {
        const d = walk(v[key], depth + 1);
        if (d === Infinity) return Infinity;
        if (d > max) max = d;
      }
      return max;
    }
    return depth;
  };
  return walk(value, 1);
}

/**
 * Validate a raw worker message. Returns the forwardable envelope or a reason to
 * DROP it. The caller forwards `message` and nothing else — never `raw`.
 */
export function validateWorkerResult(
  raw: unknown,
  limits: RelayLimits = DEFAULT_RELAY_LIMITS
): RelayVerdict {
  if (!isPlainRecord(raw)) return { ok: false, reason: "not an object" };
  if (raw.kind !== "result") return { ok: false, reason: `unexpected kind: ${String(raw.kind)}` };
  if (typeof raw.exitCode !== "number" || !Number.isInteger(raw.exitCode)) {
    return { ok: false, reason: "exitCode must be an integer" };
  }
  if (!("output" in raw)) return { ok: false, reason: "missing output" };
  if (raw.stderr !== undefined && typeof raw.stderr !== "string") {
    return { ok: false, reason: "stderr must be a string" };
  }

  // Size cap: serialize once and measure bytes. A non-serializable payload
  // (circular / BigInt) is itself a reason to drop.
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw));
  } catch {
    return { ok: false, reason: "not serializable" };
  }
  if (bytes > limits.maxBytes) {
    return { ok: false, reason: `envelope ${bytes}B exceeds ${limits.maxBytes}B cap` };
  }

  if (measureDepth(raw.output, limits.maxDepth) > limits.maxDepth) {
    return { ok: false, reason: `output nesting exceeds depth ${limits.maxDepth}` };
  }

  return {
    ok: true,
    message: {
      kind: "result",
      exitCode: raw.exitCode,
      output: raw.output,
      ...(raw.stderr !== undefined ? { stderr: raw.stderr } : {}),
    },
  };
}

/**
 * A live progress frame from the worker (the wasm counterpart of the Docker
 * prelude's stdout heartbeat). Far stricter than the result envelope: progress
 * is DISPLAY-ONLY — three short strings/numbers — so anything outside the tiny
 * shape below is dropped, never forwarded. Strings are length-CLAMPED rather
 * than rejected (a chatty phase label must not kill liveness reporting).
 */
export interface WorkerProgressMessage {
  kind: "progress";
  phase: string;
  detail?: string;
  fraction?: number;
}

export type ProgressVerdict =
  { ok: true; message: WorkerProgressMessage } | { ok: false; reason: string };

const PROGRESS_PHASE_MAX = 120;
const PROGRESS_DETAIL_MAX = 500;

export function validateWorkerProgress(raw: unknown): ProgressVerdict {
  if (!isPlainRecord(raw)) return { ok: false, reason: "not an object" };
  if (raw.kind !== "progress") {
    return { ok: false, reason: `unexpected kind: ${String(raw.kind)}` };
  }
  if (typeof raw.phase !== "string" || raw.phase.trim() === "") {
    return { ok: false, reason: "phase must be a non-empty string" };
  }
  if (raw.detail !== undefined && typeof raw.detail !== "string") {
    return { ok: false, reason: "detail must be a string" };
  }
  const fraction =
    typeof raw.fraction === "number" && Number.isFinite(raw.fraction)
      ? Math.min(1, Math.max(0, raw.fraction))
      : undefined;
  return {
    ok: true,
    message: {
      kind: "progress",
      phase: raw.phase.slice(0, PROGRESS_PHASE_MAX),
      ...(typeof raw.detail === "string"
        ? { detail: raw.detail.slice(0, PROGRESS_DETAIL_MAX) }
        : {}),
      ...(fraction !== undefined ? { fraction } : {}),
    },
  };
}
