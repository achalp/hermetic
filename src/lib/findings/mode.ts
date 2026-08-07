/**
 * Findings rollout mode (spec §8, amended 2026-08-06): runtime-config only —
 * the mode is a product switch shared by every harness. Default ON (full
 * rollout by product decision, superseding the spec's shadow-first plan);
 * "shadow" (collect, ship to no consumer) and "off" remain available as the
 * fallback lever — the §8 kill criteria still apply, they just act via this
 * flag instead of gating the launch.
 */
import { getRuntimeConfig } from "@/lib/runtime-config";
import type { FindingsMode } from "@/lib/contracts/findings";

export function findingsMode(): FindingsMode {
  const mode = getRuntimeConfig().findings?.mode;
  return mode === "off" || mode === "shadow" ? mode : "on";
}
