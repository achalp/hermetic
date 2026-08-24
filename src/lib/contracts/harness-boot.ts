/**
 * Types the harness supplies at boot through the shared slot
 * (lib/harness-slot.ts). Owned by contracts so the slot — which every module
 * graph touches — depends on nothing but contracts (exit audit F4: importing
 * these types from paths.ts / llm/replay.ts pulled both files, and their
 * node: imports, into the renderer\'s module graph).
 */

/** The four storage roots hermetic writes under (see lib/paths.ts). */
export interface HermeticPathRoots {
  dataRoot: string;
  scratchRoot: string;
  userRoot: string;
  assetRoot: string;
}

export type LLMReplayMode = "record" | "replay";

/** Golden record/replay middleware config (see lib/llm/replay.ts). */
export interface LLMReplayConfig {
  mode: LLMReplayMode;
  /** Absolute path to the fixture directory (resolved by the harness). */
  dir: string;
  /** Dump full request bytes for every replay-mode lookup (hit AND miss) as
   *  *.hit.json diagnostics. Set by the harness from HERMETIC_REPLAY_DEBUG=1 —
   *  lib code never reads the environment. */
  debug?: boolean;
}
