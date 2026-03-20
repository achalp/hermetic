import { executeSandbox as e2bExecutor } from "./executor";
import { executeSandbox as dockerExecutor } from "./docker-executor";
import { executeSandbox as microsandboxExecutor } from "./microsandbox-executor";
import { getWarmManager } from "./warm-sandbox";
import type { ExecutionResult } from "@/lib/types";
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";

export interface AdditionalFile {
  path: string;
  content: string;
}

/**
 * Python prelude injected before every generated script.
 * - Patches json.dump/dumps to force allow_nan=True (prevents NaN crash)
 * - Patches DataFrame.corr/cov to auto-select numeric columns (prevents
 *   "could not convert string to float" when LLM forgets select_dtypes)
 */
export const PYTHON_NAN_PRELUDE = `
import json as _json_mod
_orig_dump = _json_mod.dump
_orig_dumps = _json_mod.dumps
def _safe_dump(*a, **kw):
    kw['allow_nan'] = True
    return _orig_dump(*a, **kw)
def _safe_dumps(*a, **kw):
    kw['allow_nan'] = True
    return _orig_dumps(*a, **kw)
_json_mod.dump = _safe_dump
_json_mod.dumps = _safe_dumps
try:
    import pandas as _pd
    _orig_corr = _pd.DataFrame.corr
    _orig_cov = _pd.DataFrame.cov
    def _safe_corr(self, *a, **kw):
        return _orig_corr(self.select_dtypes(include="number"), *a, **kw)
    def _safe_cov(self, *a, **kw):
        return _orig_cov(self.select_dtypes(include="number"), *a, **kw)
    _pd.DataFrame.corr = _safe_corr
    _pd.DataFrame.cov = _safe_cov
except ImportError:
    pass
`;

type SandboxExecutor = (
  csv: string,
  code: string,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[]
) => Promise<ExecutionResult>;

const executors: Record<SandboxRuntimeId, SandboxExecutor> = {
  docker: dockerExecutor,
  e2b: e2bExecutor,
  microsandbox: microsandboxExecutor,
};

export function executeSandbox(
  csvContent: string,
  code: string,
  runtime?: SandboxRuntimeId,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[],
  csvId?: string
): Promise<ExecutionResult> {
  const rt = runtime ?? getActiveSandboxRuntime();

  // Route through warm manager when available (not for E2B)
  if (rt !== "e2b" && csvId) {
    const manager = getWarmManager(rt);
    if (manager) {
      return manager.execute(csvId, csvContent, code, geojsonContent, additionalFiles);
    }
  }

  // Fallback to ephemeral executors
  return (executors[rt] ?? dockerExecutor)(csvContent, code, geojsonContent, additionalFiles);
}

export { prepareWarmSandbox, warmupAllSandboxes } from "./warm-sandbox";
