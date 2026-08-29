/**
 * FULL no-Docker path in Node: the dispatcher (executeSandbox) routes a wasm run
 * to the injected executor and a REAL generated-style analysis runs through
 * Pyodide + hermetic_runtime, returning a success ExecutionResult — proving the
 * whole chain dispatch → wasm plan → executor → Pyodide → envelope → parse is
 * wired, not just the pieces.
 *
 * The injected executor here is the Node-Pyodide one (wasm/executor.ts) — CI/
 * parity only (build log D1); the production executor is the browser worker.
 * OPT-IN (HERMETIC_WASM_TEST=1) since it boots Pyodide + wheels.
 */
import { describe, it, expect, afterAll } from "vitest";
import { executeSandbox } from "@/lib/sandbox";
import {
  executeSandbox as nodeWasmExecutor,
  _resetWasmRuntimeForTests,
} from "@/lib/sandbox/wasm/executor";

const OPTED_IN = process.env.HERMETIC_WASM_TEST === "1";

const CSV = "region,revenue\nnorth,100\nsouth,250\neast,175\nwest,320\n";
const ANALYSIS = `
import pandas as pd
from hermetic_runtime.findings import declare_finding
from hermetic_runtime.output import write_output
df = pd.read_csv("/data/input.csv")
total = float(df["revenue"].sum())
declare_finding(name="total_revenue", value=total, definition="Sum of revenue.", dtype="number", unit="usd")
write_output(results={"row_count": int(len(df)), "total_revenue": total})
`;

describe.skipIf(!OPTED_IN)("no-Docker path — dispatcher → wasm executor → Pyodide", () => {
  afterAll(() => _resetWasmRuntimeForTests());

  it("a runtime:'wasm' run executes the analysis via the injected executor and returns a success result", async () => {
    const result = await executeSandbox(CSV, ANALYSIS, {
      runtime: "wasm",
      wasmExecutor: nodeWasmExecutor, // the executor's signature IS a WasmExecutor
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.results).toMatchObject({ row_count: 4, total_revenue: 845 });
    const findings = (result.findings ?? []) as { name?: string; value?: number }[];
    expect(findings.find((f) => f.name === "total_revenue")?.value).toBeCloseTo(845, 6);
  }, 120_000);

  it("the SAME run with no executor configured fails cleanly (never silently Docker)", async () => {
    const result = await executeSandbox(CSV, ANALYSIS, { runtime: "wasm" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKind).toBe("user-config");
  });
});
