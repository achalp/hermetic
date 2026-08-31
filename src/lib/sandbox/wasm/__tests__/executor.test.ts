/**
 * Phase 1a — the wasm executor produces a valid ExecutionResult from the REAL
 * hermetic_runtime, proving the compute path + envelope contract under Pyodide.
 *
 * OPT-IN (HERMETIC_WASM_TEST=1): boots Pyodide and loads numpy/pandas wheels
 * (network on first run, then cached), so it is excluded from the default fast
 * suite — like the live-warehouse tests. Runs in a dedicated CI job.
 */
import { describe, it, expect, afterAll } from "vitest";
import { executeSandbox, _resetWasmRuntimeForTests } from "@/lib/sandbox/wasm/executor";

const OPTED_IN = process.env.HERMETIC_WASM_TEST === "1";

const CSV = "region,revenue\nnorth,100\nsouth,250\neast,175\nwest,320\n";

// A generated-style analysis: read the CSV, declare a finding via the shipped
// runtime, and write the envelope — the exact contract the Docker path uses.
const CODE = `
import pandas as pd
from hermetic_runtime.findings import declare_finding
from hermetic_runtime.output import write_output

df = pd.read_csv("/data/input.csv")
total = float(df["revenue"].sum())
declare_finding(
    name="total_revenue",
    value=total,
    definition="Sum of the revenue column across all regions.",
    dtype="number",
    unit="usd",
)
write_output(results={"row_count": int(len(df)), "total_revenue": total})
`;

describe.skipIf(!OPTED_IN)("wasm executor — real hermetic_runtime under Pyodide", () => {
  afterAll(() => _resetWasmRuntimeForTests());

  it("runs the analysis and returns a success ExecutionResult with the declared finding", async () => {
    const result = await executeSandbox(CSV, CODE);

    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;

    // The envelope carried the results object write_output emitted.
    expect(result.results).toMatchObject({ row_count: 4, total_revenue: 845 });

    // The declared finding survived the registry → output.json → parse path.
    const findings = (result.findings ?? []) as { name?: string; value?: number }[];
    const rev = findings.find((f) => f.name === "total_revenue");
    expect(rev, `findings: ${JSON.stringify(findings)}`).toBeDefined();
    expect(rev!.value).toBeCloseTo(845, 6);
  }, 120_000); // Pyodide boot + wheel load on a cold first run.

  it("exposes EVERY docker-prelude bare name, callable, in the exec namespace (D39)", async () => {
    // The live King County question burned four attempts discovering missing
    // names one NameError at a time. The parity test pins the SOURCE textually;
    // this proves the bindings actually RESOLVE in a real Pyodide namespace —
    // a typo'd module path in the binding block passes the textual check and
    // fails here. to_num also runs for real: the binding must reach the working
    // implementation, not merely a name.
    const names = [
      "to_num",
      "numeric",
      "safe_qcut",
      "safe_float",
      "safe_int",
      "assert_fits",
      "progress",
      "write_output",
      "declare_finding",
      "declare_check",
      "finding_trend",
      "finding_step_change",
      "finding_decompose",
      "finding_heterogeneity",
      "finding_outliers",
      "finding_correlation",
      "finding_distribution",
      "finding_share",
      "finding_superlative",
      "finding_split_comparison",
      "finding_yoy",
      "finding_current_state",
      "declare_series",
      "declare_value",
      "get_findings",
      "get_series",
      "get_values",
      "profile_regimes",
      "select_center",
      "zero_policy",
    ];
    const code = [
      "missing = [n for n in " + JSON.stringify(names) + " if not callable(globals().get(n))]",
      "assert not missing, 'unbound helpers: %s' % missing",
      "v = to_num(['$1,234', '56%']).tolist()",
      "assert v == [1234.0, 56.0], v",
      "from hermetic_runtime.output import write_output as _wo",
      "_wo(results={'ok': 1})",
    ].join("\n");
    const result = await executeSandbox("a\n1\n", code);
    expect(result.success, JSON.stringify(result)).toBe(true);
  }, 240_000);

  it("surfaces a Python error as an error ExecutionResult (exit path parity)", async () => {
    const result = await executeSandbox(CSV, "raise ValueError('boom')");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/boom|ValueError/i);
  }, 120_000);
});
