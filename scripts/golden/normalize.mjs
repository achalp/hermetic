// Transcript normalizer for golden journeys (modularization M0-0b).
// Pure module — imported by run-journeys.mjs and unit-tested from vitest.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Volatile-by-name numeric fields, zeroed wherever they appear in the stream.
const VOLATILE_KEY_RE =
  /(_ms$|^ms_|duration|elapsed|timestamp|started_?at|finished_?at|created_?at|updated_?at|^took$|latency|eta|remaining_s)/i;
// camelCase millisecond keys (llmMs, wallMs) — case-SENSITIVE so "params" stays.
const CAMEL_MS_RE = /[a-z]Ms$/;

export function normalizeTranscript(lines) {
  const uuidMap = new Map();
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === "{}") continue; // keepalives / blank frames
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line); // non-JSON frame: keep verbatim so drift is visible
      continue;
    }
    out.push(JSON.stringify(normalizeValue(parsed, uuidMap)));
  }
  return out.join("\n") + "\n";
}

function normalizeValue(value, uuidMap, keyHint = "") {
  // Run ids are short hex tokens (not UUIDs) — normalize by key name.
  if (typeof value === "string" && /^(__runId|runId|run_id)$/.test(keyHint)) {
    return "<run-id>";
  }
  if (typeof value === "string") {
    return value.replace(UUID_RE, (m) => {
      const key = m.toLowerCase();
      if (!uuidMap.has(key)) uuidMap.set(key, `<uuid-${uuidMap.size + 1}>`);
      return uuidMap.get(key);
    });
  }
  if (typeof value === "number" && (VOLATILE_KEY_RE.test(keyHint) || CAMEL_MS_RE.test(keyHint)))
    return 0;
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, uuidMap, keyHint));
  if (value && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = normalizeValue(v, uuidMap, k);
    }
    return result;
  }
  return value;
}
