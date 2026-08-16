/**
 * Periodic sweeper for the in-memory globalThis stores (server-only).
 *
 * Every store expired entries ONLY on read — an entry never read again after
 * its TTL lived forever, a restart emptied the indexes while the on-disk
 * files under tmpdir/hermetic accumulated as orphans, and (worst) expired
 * warehouse entries kept their LIVE connector pools — open sockets with
 * credentials — indefinitely. One unref'd interval sweeps them all.
 *
 * Single-process model (one Next.js server = one set of globalThis stores);
 * that constraint is why in-memory maps + this sweeper are sufficient.
 * NOTE: data/history/ is not swept here — it only grows via saves, so its
 * cap is enforced at the write site instead (prune-on-save in
 * lib/history/storage.ts, HERMETIC_MAX_HISTORY_ENTRIES; API-9).
 */
import { logger, errMessage } from "@/lib/logger";
import { runRegisteredSweeps } from "@/lib/store-ttl";

const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let started = false;

export function startStoreSweeper(): void {
  if (started) return;
  started = true;

  const sweep = async () => {
    try {
      // Side-effect module loading, NOT enumeration: sweeps run from the
      // registry (registerSweepable at each store's definition site — a new
      // store enrolls itself and cannot be forgotten), but registration only
      // fires when the store module is imported, and this sweeper may be a
      // store's first importer. Dynamic imports keep the module
      // import-cycle-free and lazy, exactly as before.
      const [, , , , runControl] = await Promise.all([
        // Loaded for their registerSweepable side effect (each store enrolls
        // at its own definition site) — the sweeper may be a store's first
        // importer, so this list's only remaining job is module loading; it
        // can no longer silently miss a sweep function.
        import("@/lib/warehouse/storage"),
        import("@/lib/pipeline/code-cache"),
        import("@/lib/pipeline/conversation-cache"),
        import("@/lib/pipeline/artifacts-cache"),
        import("@/lib/pipeline/run-control"),
        import("@/lib/pipeline/run-stream-hub"),
        import("@/lib/csv/storage"),
        import("@/lib/excel/storage"),
      ]);

      const counts = {
        ...(await runRegisteredSweeps()),
        // Orphaned `sleep infinity` analysis containers from a crashed/restarted
        // run — the only cleanup path now that we never self-kill on a timer.
        // Not a store sweep, so deliberately outside the registry (pending the
        // sandbox-layer move).
        sandboxOrphans: await runControl.reapOrphanSandboxContainers(),
      };
      if (Object.values(counts).some((n) => n > 0)) {
        logger.debug("Store sweep", counts);
      }
    } catch (err) {
      logger.warn("Store sweep failed", {
        error: errMessage(err),
      });
    }
  };

  const handle = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  handle.unref?.(); // never keep the process alive for the sweeper
  void sweep(); // initial pass cleans restart orphans immediately
  logger.debug("Store sweeper started", { intervalMs: SWEEP_INTERVAL_MS });
}
