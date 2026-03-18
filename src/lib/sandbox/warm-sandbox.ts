import type { ExecutionResult } from "@/lib/types";
import type { AdditionalFile } from "./index";
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { logger } from "@/lib/logger";

// ── WarmSandboxBackend interface ─────────────────────────────────────

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

// ── WarmSandboxManager ───────────────────────────────────────────────

export class WarmSandboxManager {
  private backend: WarmSandboxBackend;
  private warmupPromise: Promise<void> | null = null;
  private preparationPromise: Promise<void> | null = null;
  private loadedCsvId: string | null = null;

  constructor(backend: WarmSandboxBackend) {
    this.backend = backend;
  }

  /** Idempotent warmup — deduplicates concurrent calls */
  async warmup(): Promise<void> {
    if (!this.warmupPromise) {
      this.warmupPromise = this.backend.warmup().catch((err) => {
        this.warmupPromise = null;
        throw err;
      });
    }
    return this.warmupPromise;
  }

  /** Fire-and-forget data preparation. Stores Promise for later await. */
  prepareData(
    csvId: string,
    csvContent: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): void {
    // Replace any in-flight preparation
    this.loadedCsvId = null;

    this.preparationPromise = (async () => {
      try {
        await this.warmup();
        await this.backend.loadData(csvId, csvContent, geojsonContent, additionalFiles);
        this.loadedCsvId = csvId;
        logger.info("Warm sandbox data pre-loaded", { csvId });
      } catch (err) {
        logger.warn("Warm sandbox preparation failed", {
          csvId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.loadedCsvId = null;
      }
    })();
  }

  /** Execute code. Uses fast path if csvId matches loaded data, otherwise full execution. */
  async execute(
    csvId: string,
    csvContent: string,
    code: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): Promise<ExecutionResult> {
    // Await any in-flight preparation
    if (this.preparationPromise) {
      await this.preparationPromise.catch(() => {});
    }

    // Fast path: data already loaded and sandbox healthy
    if (this.loadedCsvId === csvId) {
      try {
        const healthy = await this.backend.isHealthy();
        if (healthy) {
          logger.info("Warm sandbox fast path", { csvId });
          return await this.backend.executeScript(code);
        }
      } catch {
        // Fall through to full execution
      }
      // Sandbox unhealthy — reset state
      logger.warn("Warm sandbox unhealthy, falling back to full execution");
      this.warmupPromise = null;
      this.loadedCsvId = null;
    }

    // Fallback: full execution
    logger.info("Warm sandbox full execution", { csvId });
    try {
      const result = await this.backend.executeFull(
        csvContent,
        code,
        geojsonContent,
        additionalFiles
      );
      // After successful full execution, the sandbox has this data loaded
      this.loadedCsvId = csvId;
      return result;
    } catch (err) {
      this.warmupPromise = null;
      this.loadedCsvId = null;
      throw err;
    }
  }

  async destroy(): Promise<void> {
    this.warmupPromise = null;
    this.preparationPromise = null;
    this.loadedCsvId = null;
    await this.backend.destroy();
  }
}

// ── Global registry (survives HMR) ──────────────────────────────────

const globalRegistry = globalThis as unknown as {
  __warmSandboxManagers?: Map<SandboxRuntimeId, WarmSandboxManager>;
};
if (!globalRegistry.__warmSandboxManagers) {
  globalRegistry.__warmSandboxManagers = new Map();
}
const managers = globalRegistry.__warmSandboxManagers;

export function registerWarmManager(
  runtime: SandboxRuntimeId,
  backend: WarmSandboxBackend
): WarmSandboxManager {
  let manager = managers.get(runtime);
  if (!manager) {
    manager = new WarmSandboxManager(backend);
    managers.set(runtime, manager);
  }
  return manager;
}

export function getWarmManager(runtime: SandboxRuntimeId): WarmSandboxManager | undefined {
  return managers.get(runtime);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Pre-load CSV data into a warm sandbox. Fire-and-forget from upload routes.
 */
export function prepareWarmSandbox(
  csvId: string,
  csvContent: string,
  runtime?: SandboxRuntimeId,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[]
): void {
  const rt = runtime ?? getActiveSandboxRuntime();
  if (rt === "e2b") return; // E2B stays ephemeral

  // Lazy-initialize backends, then prepare data (all fire-and-forget)
  ensureBackendRegistered(rt).then((manager) => {
    manager?.prepareData(csvId, csvContent, geojsonContent, additionalFiles);
  });
}

/**
 * Warmup all non-E2B sandbox runtimes.
 */
export async function warmupAllSandboxes(): Promise<void> {
  const rt = getActiveSandboxRuntime();
  if (rt === "e2b") return;

  const manager = await ensureBackendRegistered(rt);
  if (manager) {
    await manager.warmup();
  }
}

/**
 * Ensure the warm sandbox backend is registered and data preparation has started.
 * Unlike prepareWarmSandbox (fire-and-forget), this awaits backend registration
 * so that getWarmManager() won't return undefined when executeSandbox is called
 * immediately after. The manager.execute() method already awaits preparationPromise.
 */
export async function ensureWarmSandboxReady(
  csvId: string,
  csvContent: string,
  runtime?: SandboxRuntimeId,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[]
): Promise<void> {
  const rt = runtime ?? getActiveSandboxRuntime();
  if (rt === "e2b") return;

  const manager = await ensureBackendRegistered(rt);
  if (!manager) return;

  // Start data preparation — manager.execute() will await the promise
  manager.prepareData(csvId, csvContent, geojsonContent, additionalFiles);
}

async function ensureBackendRegistered(
  runtime: SandboxRuntimeId
): Promise<WarmSandboxManager | undefined> {
  if (managers.has(runtime)) return managers.get(runtime);

  if (runtime === "docker") {
    const { DockerWarmBackend } = await import("./docker-warm-backend");
    return registerWarmManager(runtime, new DockerWarmBackend());
  } else if (runtime === "microsandbox") {
    const { MicrosandboxWarmBackend } = await import("./microsandbox-warm-backend");
    return registerWarmManager(runtime, new MicrosandboxWarmBackend());
  }
  return undefined;
}
