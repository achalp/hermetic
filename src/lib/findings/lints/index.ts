/**
 * Findings coherence lints (spec §3.3, §7.2, §7.3) — pure, advisory.
 *
 * The posture matters more than the checks: entries are KEPT and flagged.
 * A wrong-but-visible verdict beats a silently dropped one.
 *
 * Split from the former single lints.ts (2072 lines, L7) into thematic family
 * files. The public surface is unchanged — `@/lib/findings/lints` still
 * resolves here and re-exports every lint by name.
 */
export * from "./derivation-language";
export * from "./charts-screens";
export * from "./superlatives-units";
