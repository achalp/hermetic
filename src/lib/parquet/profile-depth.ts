/**
 * Is a cached profile deep enough for what the caller now asks for?
 *
 * Extracted from the remote-parquet route so the rule lives in ONE place: it is
 * the kind of policy whose duplicate silently drifts (a test re-implementing it
 * would keep passing while the route regressed), and it is subtle in three ways
 * worth stating once.
 */
import type { ProfileBasis } from "@/lib/contracts/data-schema";
import { DEFAULT_PROFILE_DEPTH } from "@/lib/constants";

export function profileSatisfiesDepth(
  basis: ProfileBasis | undefined,
  requestedDepth: number
): boolean {
  // 1. A FULL SCAN cannot be improved on: the source was smaller than whatever
  //    depth produced it, so every deeper request is already answered.
  if (basis?.kind === "full_scan") return true;
  // 2. An entry written before provenance existed carries no depth. Assuming it
  //    was deep would serve a shallow profile to someone who asked for more;
  //    assuming it was shallow would re-extract every existing cache entry on
  //    upgrade. Accept it only for a request no deeper than the old default.
  if (basis?.rows_examined === undefined) return requestedDepth <= DEFAULT_PROFILE_DEPTH;
  // 3. Deeper satisfies shallower — re-reading a source to know LESS about it is
  //    never right, so this is an at-least test, not an equality test.
  return basis.rows_examined >= requestedDepth;
}
