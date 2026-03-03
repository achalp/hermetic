import { executeSandbox as e2bExecutor } from "./executor";
import { executeSandbox as dockerExecutor } from "./docker-executor";
import { executeSandbox as microsandboxExecutor } from "./microsandbox-executor";
import type { ExecutionResult } from "@/lib/types";
import { DEFAULT_SANDBOX_RUNTIME } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";

type SandboxExecutor = (
  csv: string,
  code: string,
  geojsonContent?: string | null
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
  geojsonContent?: string | null
): Promise<ExecutionResult> {
  return (executors[runtime ?? DEFAULT_SANDBOX_RUNTIME] ?? dockerExecutor)(
    csvContent,
    code,
    geojsonContent
  );
}
