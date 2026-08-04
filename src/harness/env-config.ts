import { ENV_CONFIG_KEYS, type HermeticEnvConfig } from "@/lib/contracts/env-config";
import { setEnvConfig } from "@/lib/harness-slot";

/**
 * Harness-side env resolution (modularization M2-B1). This file — not lib —
 * is where process.env is read. Each harness calls installEnvConfig() once
 * at boot: instrumentation-node for the Next server, the CLI's main for WS8.
 *
 * `live` mode (vitest) installs a view that reads process.env on every
 * access instead of a frozen snapshot — existing tests mutate process.env
 * per-test and must keep working.
 */

export function resolveEnvConfig(): HermeticEnvConfig {
  const snapshot: HermeticEnvConfig = {};
  for (const key of ENV_CONFIG_KEYS) {
    const value = process.env[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

export function installEnvConfig(mode: "snapshot" | "live" = "snapshot"): void {
  if (mode === "snapshot") {
    setEnvConfig(resolveEnvConfig());
    return;
  }
  const liveView = new Proxy({} as HermeticEnvConfig, {
    get: (_t, prop) => (typeof prop === "string" ? process.env[prop] : undefined),
    has: (_t, prop) => typeof prop === "string" && process.env[prop] !== undefined,
    ownKeys: () => ENV_CONFIG_KEYS.filter((k) => process.env[k] !== undefined),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
  setEnvConfig(liveView);
}
