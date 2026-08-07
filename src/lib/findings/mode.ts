/**
 * Findings rollout mode (spec §8). Runtime-config only — no env knob: the
 * mode is a product rollout switch, shared by every harness, flipped from
 * Settings or by hand in data/runtime-config.json. Default SHADOW: collect,
 * validate, record — ship to no consumer.
 */
import { getRuntimeConfig } from "@/lib/runtime-config";
import type { FindingsMode } from "@/lib/contracts/findings";

export function findingsMode(): FindingsMode {
  const mode = getRuntimeConfig().findings?.mode;
  return mode === "off" || mode === "on" ? mode : "shadow";
}
