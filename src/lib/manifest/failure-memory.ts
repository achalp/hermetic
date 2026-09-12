/**
 * Short-lived memory of entities whose extraction FAILED, so a permanently
 * broken entity does not re-burn the connect budget on every reconnect.
 *
 * Why this exists: the eager batch gets ONE wall-clock budget for the whole
 * manifest. An entity that fails slowly (observed: ~90s against a 60s budget)
 * consumes it entirely, so the batch attempts that same entity again on the
 * next connect and SKIPS every sibling — three consecutive connects each
 * reported `attempted:1 ok:0 failed:1 skipped:13` while 11 other entities sat
 * cached and fine. Remembering the failure lets the next connect spend its
 * budget on entities that can actually succeed.
 *
 * Deliberately SHORT-LIVED and best-effort: a failure is often transient (a
 * flaky network, a throttled bucket), so this suppresses re-attempts for a
 * cooldown window rather than permanently. `force` (the user's "ignore cached
 * schema" control) clears it — an explicit retry must always be honored.
 *
 * Keyed exactly like the positive cache (sourceKey + fingerprint), so a
 * changed manifest or changed data re-attempts naturally.
 */
import { readSchemaCache, writeSchemaCache, deleteSchemaCache } from "@/lib/schema-cache";

/** How long a recorded failure suppresses re-attempts. */
export const FAILURE_COOLDOWN_MS = 30 * 60_000; // 30 minutes

interface FailureRecord {
  failedAt: number;
  reason: string;
}

/** Namespaced so a failure can never be mistaken for a cached schema. */
function failureKey(sourceKey: string): string {
  return `extract-failure:${sourceKey}`;
}

/**
 * Is this entity in its post-failure cooldown? Returns the remembered reason
 * when it is, so the caller can surface WHY without re-running the extraction.
 */
export async function recentFailure(
  sourceKey: string,
  fingerprint: string,
  now: number = Date.now()
): Promise<string | null> {
  const entry = await readSchemaCache<FailureRecord>(failureKey(sourceKey));
  if (!entry || entry.fingerprint !== fingerprint) return null;
  const rec = entry.artifact;
  if (!rec || typeof rec.failedAt !== "number") return null;
  if (now - rec.failedAt >= FAILURE_COOLDOWN_MS) return null;
  return rec.reason ?? "previous extraction failed";
}

export async function rememberFailure(
  sourceKey: string,
  fingerprint: string,
  reason: string,
  now: number = Date.now()
): Promise<void> {
  await writeSchemaCache<FailureRecord>(failureKey(sourceKey), fingerprint, {
    failedAt: now,
    reason: reason.slice(0, 500),
  }).catch(() => {});
}

/** Clear a remembered failure — a successful extraction, or an explicit retry. */
export async function clearFailure(sourceKey: string): Promise<void> {
  await deleteSchemaCache(failureKey(sourceKey)).catch(() => {});
}
