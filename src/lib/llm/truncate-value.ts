/**
 * Shrink an oversized value to fit `maxChars` of JSON — arrays get a marked
 * `_truncated` sample, objects keep whole leading entries, scalars are sliced.
 *
 * The `_truncated` / `_total` / `_sample` markers are an EFFECTIVE PROMPT
 * CONTRACT: both the single-shot dashboard compose and the investigate
 * composer feed the truncated value into LLM prompts, and the models read
 * those marker keys to know they are looking at a sample. Keep the shape
 * byte-identical across call sites — do not rename the markers.
 */
export function truncateValue(val: unknown, maxChars: number): unknown {
  if (Array.isArray(val)) {
    for (let limit = Math.min(val.length, 50); limit >= 5; limit = Math.floor(limit / 2)) {
      const sliced = val.slice(0, limit);
      const json = JSON.stringify(sliced);
      if (json.length <= maxChars) {
        if (limit < val.length) return { _truncated: true, _total: val.length, _sample: sliced };
        return sliced;
      }
    }
    return { _truncated: true, _total: val.length, _sample: val.slice(0, 3) };
  }
  const json = JSON.stringify(val);
  if (json.length <= maxChars) return val;
  if (typeof val === "object" && val !== null) {
    const entries = Object.entries(val as Record<string, unknown>);
    const trimmed: Record<string, unknown> = {};
    let remaining = maxChars - 50;
    for (const [k, v] of entries) {
      const s = JSON.stringify(v);
      if (s.length <= remaining) {
        trimmed[k] = v;
        remaining -= s.length;
      } else {
        trimmed[k] = truncateValue(v, Math.max(remaining, 200));
        break;
      }
    }
    return trimmed;
  }
  return String(val).slice(0, maxChars);
}
