import { executeSandbox as e2bExecutor } from "./executor";
import { executeSandbox as dockerExecutor } from "./docker-executor";
import { executeSandbox as microsandboxExecutor } from "./microsandbox-executor";
import { getWarmManager } from "./warm-sandbox";
import type { ExecutionResult } from "@/lib/types";
import { DEFAULT_SANDBOX_RUNTIME } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";

export interface AdditionalFile {
  path: string;
  content: string;
}

/**
 * Python prelude that monkey-patches json.dump/dumps to force allow_nan=True.
 * This prevents generated code from crashing on NaN/Infinity values.
 * The JS-side output parser already replaces NaN/Infinity with null.
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
  const rt = runtime ?? DEFAULT_SANDBOX_RUNTIME;

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
