import { executeSandbox as e2bExecutor } from "./executor";
import { executeSandbox as dockerExecutor } from "./docker-executor";
import { executeSandbox as microsandboxExecutor } from "./microsandbox-executor";
import type { ExecutionResult } from "@/lib/types";
import { DEFAULT_SANDBOX_RUNTIME } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";

const executors: Record<SandboxRuntimeId, (csv: string, code: string) => Promise<ExecutionResult>> =
  {
    docker: dockerExecutor,
    e2b: e2bExecutor,
    microsandbox: microsandboxExecutor,
  };

export function executeSandbox(
  csvContent: string,
  code: string,
  runtime?: SandboxRuntimeId
): Promise<ExecutionResult> {
  return (executors[runtime ?? DEFAULT_SANDBOX_RUNTIME] ?? dockerExecutor)(csvContent, code);
}
