import { describe, it, expect } from "vitest";
import { pythonNanPrelude } from "@/lib/sandbox/prelude";

// The prelude is Python injected before every generated script. These guard the
// runtime helper surface that the prompt now tells the model to rely on.
describe("pythonNanPrelude()", () => {
  it("defines the output + data-shaping helpers", () => {
    expect(pythonNanPrelude()).toMatch(/def write_output\(/);
    expect(pythonNanPrelude()).toMatch(/def safe_qcut\(/);
    expect(pythonNanPrelude()).toMatch(/def to_num\(/);
    expect(pythonNanPrelude()).toMatch(/def numeric\(/);
  });

  it("keeps the prior NaN / corr / duckdb patches", () => {
    expect(pythonNanPrelude()).toMatch(/_json_mod\.dump = _safe_dump/);
    expect(pythonNanPrelude()).toMatch(/_pd\.DataFrame\.corr = _safe_corr/);
  });

  it("provides the live-progress helper + auto heartbeat (emits __progress JSONL)", () => {
    expect(pythonNanPrelude()).toMatch(/def progress\(/);
    expect(pythonNanPrelude()).toMatch(/__progress/);
    // The daemon heartbeat thread so a silent long scan still reports elapsed.
    expect(pythonNanPrelude()).toMatch(/_threading\.Thread\(target=_hb_loop, daemon=True\)/);
    // Unbuffered write+flush so lines stream live under `python3 -u`.
    expect(pythonNanPrelude()).toMatch(/_sys\.stdout\.flush\(\)/);
  });

  it("contains no JS template-literal escape hazards in the added helpers", () => {
    // Our helpers must avoid `${` (interpolation) and backslashes that JS would
    // silently drop from the template literal, corrupting the Python.
    const helpers = pythonNanPrelude().slice(pythonNanPrelude().indexOf("def _to_native"));
    expect(helpers.includes("${")).toBe(false);
    expect(helpers.includes("\\")).toBe(false);
  });

  it("write_output targets /data/output.json (rewritten per-runtime)", () => {
    expect(pythonNanPrelude()).toMatch(/open\('\/data\/output\.json', 'w'\)/);
  });
});
