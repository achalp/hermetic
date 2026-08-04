import type { ExecutionResult } from "@/lib/contracts/execution";
import type { AdditionalFile } from "@/lib/contracts/execution";

/**
 * The SPI a warm-sandbox backend implements (docker, microsandbox). Lives in
 * its own leaf module so backends can import the type without creating a
 * cycle with warm-sandbox.ts, which imports THEM (M7 exit-audit residue —
 * the cycles were type-only and harmless at runtime, but poisoned madge/
 * ESLint cycle checks as noise future real cycles could hide behind).
 */
export interface WarmSandboxBackend {
  /** Create sandbox, install packages */
  warmup(): Promise<void>;
  /** Write data files into the sandbox */
  loadData(
    csvId: string,
    csvContent: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): Promise<void>;
  /** Write script + run (data already loaded) */
  executeScript(code: string): Promise<ExecutionResult>;
  /** Fallback: full execution (warmup + load + execute) */
  executeFull(
    csvContent: string,
    code: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): Promise<ExecutionResult>;
  /** Container/sandbox alive? */
  isHealthy(): Promise<boolean>;
  /** Tear down */
  destroy(): Promise<void>;
}
