// Transcript normalizer for golden journeys (modularization M0-0b).
// Pure module — imported by run-journeys.mjs and unit-tested from vitest.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Plan-node ids embed Date.now() (nextPlanNodeId in lib/compose/plan.ts:
// `pn_<base36 wall clock>_<base36 counter>`), so every run mints fresh ones.
// Mapped to stable placeholders by first appearance, like uuids.
const PLAN_NODE_ID_RE = /\bpn_[0-9a-z]+_[0-9a-z]+\b/g;
// Volatile-by-name numeric fields, zeroed wherever they appear in the stream.
const VOLATILE_KEY_RE =
  /(_ms$|^ms_|duration|elapsed|timestamp|started_?at|finished_?at|created_?at|updated_?at|^took$|latency|eta|remaining_s)/i;
// camelCase millisecond keys (llmMs, wallMs) — case-SENSITIVE so "params" stays.
const CAMEL_MS_RE = /[a-z]Ms$/;

export function normalizeTranscript(lines) {
  const idMaps = { uuid: new Map(), pn: new Map() };
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === "{}") continue; // blank frames
    // SSE comment heartbeats (": keepalive") are WALL-CLOCK noise: whether one
    // lands before the first patch depends on how long pre-run probes take on
    // the host (docker-less CI crosses the interval; a warm laptop does not).
    // Deterministic journeys must not compare them.
    if (line.startsWith(":")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line); // non-JSON frame: keep verbatim so drift is visible
      continue;
    }
    // Sandbox progress telemetry (__estimate banner, __exec heartbeats) is
    // emitted from execution-side callbacks racing the main patch stream:
    // whether an estimate fires and where it interleaves depends on host
    // speed, not journey semantics. Same category as keepalives — drop.
    if (isExecTelemetryFrame(parsed)) continue;
    out.push(JSON.stringify(normalizeValue(parsed, idMaps)));
  }
  return out.join("\n") + "\n";
}

/** Progress-telemetry patches raced in from the sandbox — see call site. */
function isExecTelemetryFrame(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.path === "/state/__estimate" || parsed.path === "/state/__exec") return true;
  // The first telemetry event may CREATE /state, carrying only its own key.
  if (parsed.path === "/state" && parsed.value && typeof parsed.value === "object") {
    const keys = Object.keys(parsed.value);
    return keys.length > 0 && keys.every((k) => k === "__estimate" || k === "__exec");
  }
  return false;
}

function normalizeString(value, idMaps) {
  return value
    .replace(UUID_RE, (m) => {
      const key = m.toLowerCase();
      if (!idMaps.uuid.has(key)) idMaps.uuid.set(key, `<uuid-${idMaps.uuid.size + 1}>`);
      return idMaps.uuid.get(key);
    })
    .replace(PLAN_NODE_ID_RE, (m) => {
      if (!idMaps.pn.has(m)) idMaps.pn.set(m, `<pn-${idMaps.pn.size + 1}>`);
      return idMaps.pn.get(m);
    });
}

function normalizeValue(value, idMaps, keyHint = "") {
  // Run ids are short hex tokens (not UUIDs) — normalize by key name.
  if (typeof value === "string" && /^(__runId|runId|run_id)$/.test(keyHint)) {
    return "<run-id>";
  }
  if (typeof value === "string") {
    return normalizeString(value, idMaps);
  }
  if (typeof value === "number" && (VOLATILE_KEY_RE.test(keyHint) || CAMEL_MS_RE.test(keyHint)))
    return 0;
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, idMaps, keyHint));
  if (value && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      // Plan-node ids also appear as KEYS (element maps keyed by node id).
      result[normalizeString(k, idMaps)] = normalizeValue(v, idMaps, k);
    }
    return result;
  }
  return value;
}
