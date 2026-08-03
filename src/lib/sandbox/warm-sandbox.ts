import type { ExecutionResult } from "@/lib/contracts/execution";
import type { AdditionalFile } from "@/lib/contracts/execution";
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { logger } from "@/lib/logger";
import { stateNamespace, stateBox } from "@/lib/state-store";

// Backend SPI lives in ./warm-backend (leaf module) so implementations can
// import it without a cycle back through this file; re-exported for existing
// consumers.
export type { WarmSandboxBackend } from "./warm-backend";
import type { WarmSandboxBackend } from "./warm-backend";

// ── WarmSandboxManager ───────────────────────────────────────────────

export class WarmSandboxManager {
  private backend: WarmSandboxBackend;
  private warmupPromise: Promise<void> | null = null;
  private preparationPromise: Promise<void> | null = null;
  private loadedCsvId: string | null = null;
  // Serializes every backend container operation (load + execute). The warm
  // Docker backend shares ONE container and ONE set of /data paths, so concurrent
  // operations — e.g. an Investigate wave running sub-questions in parallel —
  // would interleave their `cat > /data/script.py` writes (corrupting the script,
  // dropping the prelude → NameError), clobber each other's /data/input.csv, and
  // even tear down the container mid-run. Chaining makes each load+run atomic.
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(backend: WarmSandboxBackend) {
    this.backend = backend;
  }

  /** Run `fn` exclusively on the shared container — never concurrently. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    // Keep the chain alive regardless of this op's success.
    this.opChain = run.then(
      () => {},
      () => {}
    );
    return run;
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

  /** Ensure the container is up and healthy (re-warming a dead one). */
  private async ensureWarm(): Promise<void> {
    await this.warmup();
    let healthy = false;
    try {
      healthy = await this.backend.isHealthy();
    } catch {
      healthy = false;
    }
    if (!healthy) {
      this.warmupPromise = null;
      this.loadedCsvId = null;
      await this.warmup();
    }
  }

  /** Fire-and-forget data preparation. Stores Promise for later await. */
  prepareData(
    csvId: string,
    csvContent: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): void {
    this.preparationPromise = this.withLock(async () => {
      try {
        await this.ensureWarm();
        await this.backend.loadData(csvId, csvContent, geojsonContent, additionalFiles);
        this.loadedCsvId = csvId;
        logger.info("Warm sandbox data pre-loaded", { csvId });
      } catch (err) {
        this.loadedCsvId = null;
        logger.warn("Warm sandbox preparation failed", {
          csvId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * Execute code on the shared warm container — serialized so concurrent callers
   * (parallel Investigate sub-questions) never clobber each other. Reuses the
   * container, reloading data only when it differs from what's already loaded.
   */
  async execute(
    csvId: string,
    csvContent: string,
    code: string,
    opts: {
      geojsonContent?: string | null;
      additionalFiles?: AdditionalFile[];
      hooks?: import("@/lib/contracts/execution").SandboxRunHooks;
    } = {}
  ): Promise<ExecutionResult> {
    const { geojsonContent, additionalFiles } = opts;
    return this.withLock(async () => {
      try {
        await this.ensureWarm();
        if (this.loadedCsvId !== csvId) {
          this.loadedCsvId = null; // invalidate before the (possibly failing) load
          await this.backend.loadData(csvId, csvContent, geojsonContent, additionalFiles);
          this.loadedCsvId = csvId;
          logger.info("Warm sandbox execution", { csvId, reloaded: true });
        } else {
          logger.info("Warm sandbox execution (data reused)", { csvId });
        }
        return await this.backend.executeScript(code);
      } catch (err) {
        // Container may be wedged — force a fresh warmup on the next call.
        this.warmupPromise = null;
        this.loadedCsvId = null;
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          execution_ms: 0,
        };
      }
    });
  }

  async destroy(): Promise<void> {
    this.warmupPromise = null;
    this.preparationPromise = null;
    this.loadedCsvId = null;
    await this.backend.destroy();
  }
}

// ── Global registry (survives HMR) ──────────────────────────────────
// The manager is cached on globalThis so the warm container survives Hot Module
// Reload (no re-warm on every edit). The downside: a code change to
// WarmSandboxManager itself won't take effect on HMR — the OLD instance lingers.
// REGISTRY_VERSION guards against that: BUMP IT whenever this class's logic
// changes, and HMR will drop the stale instance. The replacement reuses the
// still-running container via its health check, so there's no re-warm cost.
const REGISTRY_VERSION = 2;

const managers = stateNamespace<WarmSandboxManager>("warm-sandbox-managers") as Map<
  SandboxRuntimeId,
  WarmSandboxManager
>;
const registryVersion = stateBox<number>("warm-sandbox-registry-version", () => REGISTRY_VERSION);
if (registryVersion.get() !== REGISTRY_VERSION) {
  managers.clear();
  registryVersion.set(REGISTRY_VERSION);
}

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
