import type { HermeticEnvConfig } from "@/lib/contracts/env-config";
import type { LLMReplayConfig, HermeticPathRoots } from "@/lib/contracts/harness-boot";

/**
 * The ONE globalThis slot through which the harness hands boot-resolved
 * state to lib (modularization M2-B1).
 *
 * Why globalThis at all: Next dev compiles instrumentation and each route as
 * separate module graphs, so module-level state set at boot is invisible to
 * the instances routes import (the lesson learned in M0-0a). Why ONE slot:
 * the ratchet counts globalThis stores; harness-boot handoff is a single
 * concern and gets a single store. WS4's StateStore replaces this.
 */
export interface HarnessSlot {
  envConfig?: HermeticEnvConfig;
  /** On-disk layout roots (see lib/paths.ts). */
  pathRoots?: HermeticPathRoots;
  llmReplay?: LLMReplayConfig | null;
  /** One-time warning flags (dev ergonomics, not state). */
  warnedNoEnvConfig?: boolean;
}

const g = globalThis as unknown as { __hermeticHarness?: HarnessSlot };

export function harnessSlot(): HarnessSlot {
  return (g.__hermeticHarness ??= {});
}

/** Harness boot: push the env snapshot resolved from the real environment. */
export function setEnvConfig(cfg: HermeticEnvConfig): void {
  harnessSlot().envConfig = cfg;
}

/**
 * The one sanctioned way lib reads environment-derived config. Before harness
 * boot (or in a harness that forgot to boot) this returns an empty snapshot
 * and warns once — lib treats missing config exactly like missing env vars.
 */
export function envConfig(): HermeticEnvConfig {
  const slot = harnessSlot();
  if (!slot.envConfig) {
    if (!slot.warnedNoEnvConfig && typeof window === "undefined") {
      slot.warnedNoEnvConfig = true;
      console.warn(
        "[hermetic] envConfig() read before harness boot — returning empty snapshot. " +
          "The harness must call setEnvConfig() at startup (see src/harness/env-config.ts)."
      );
    }
    return {};
  }
  return slot.envConfig;
}
