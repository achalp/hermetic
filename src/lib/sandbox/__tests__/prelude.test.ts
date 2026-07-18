import { describe, it, expect } from "vitest";
import { PYTHON_NAN_PRELUDE } from "@/lib/sandbox";

// The prelude is Python injected before every generated script. These guard the
// runtime helper surface that the prompt now tells the model to rely on.
describe("PYTHON_NAN_PRELUDE", () => {
  it("defines the output + data-shaping helpers", () => {
    expect(PYTHON_NAN_PRELUDE).toMatch(/def write_output\(/);
    expect(PYTHON_NAN_PRELUDE).toMatch(/def safe_qcut\(/);
    expect(PYTHON_NAN_PRELUDE).toMatch(/def to_num\(/);
    expect(PYTHON_NAN_PRELUDE).toMatch(/def numeric\(/);
  });

  it("keeps the prior NaN / corr / duckdb patches", () => {
    expect(PYTHON_NAN_PRELUDE).toMatch(/_json_mod\.dump = _safe_dump/);
    expect(PYTHON_NAN_PRELUDE).toMatch(/_pd\.DataFrame\.corr = _safe_corr/);
  });

  it("provides the live-progress helper + auto heartbeat (emits __progress JSONL)", () => {
    expect(PYTHON_NAN_PRELUDE).toMatch(/def progress\(/);
    expect(PYTHON_NAN_PRELUDE).toMatch(/__progress/);
    // The daemon heartbeat thread so a silent long scan still reports elapsed.
    expect(PYTHON_NAN_PRELUDE).toMatch(/_threading\.Thread\(target=_hb_loop, daemon=True\)/);
    // Unbuffered write+flush so lines stream live under `python3 -u`.
    expect(PYTHON_NAN_PRELUDE).toMatch(/_sys\.stdout\.flush\(\)/);
  });

  it("contains no JS template-literal escape hazards in the added helpers", () => {
    // Our helpers must avoid `${` (interpolation) and backslashes that JS would
    // silently drop from the template literal, corrupting the Python.
    const helpers = PYTHON_NAN_PRELUDE.slice(PYTHON_NAN_PRELUDE.indexOf("def _to_native"));
    expect(helpers.includes("${")).toBe(false);
    expect(helpers.includes("\\")).toBe(false);
  });

  it("write_output targets /data/output.json (rewritten per-runtime)", () => {
    expect(PYTHON_NAN_PRELUDE).toMatch(/open\('\/data\/output\.json', 'w'\)/);
  });
});
