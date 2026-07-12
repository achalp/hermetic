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
import "server-only";
import { logger } from "@/lib/logger";

const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let started = false;

export function startStoreSweeper(): void {
  if (started) return;
  started = true;

  const sweep = async () => {
    try {
      // Dynamic imports keep this module import-cycle-free and lazy.
      const [csv, warehouse, code, conversation, artifacts, excel, runControl] = await Promise.all([
        import("@/lib/csv/storage"),
        import("@/lib/warehouse/storage"),
        import("@/lib/pipeline/code-cache"),
        import("@/lib/pipeline/conversation-cache"),
        import("@/lib/pipeline/artifacts-cache"),
        import("@/lib/excel/storage"),
        import("@/lib/pipeline/run-control"),
      ]);
      const csvResult = await csv.sweepExpiredCSVStore();
      const counts = {
        csvExpired: csvResult.expired,
        csvOrphans: csvResult.orphans,
        warehouses: warehouse.sweepExpiredWarehouses(),
        code: code.sweepExpiredCodeCache(),
        conversations: conversation.sweepExpiredConversations(),
        artifacts: artifacts.sweepExpiredArtifacts(),
        excel: excel.sweepExpiredExcel(),
        // Orphaned `sleep infinity` analysis containers from a crashed/restarted
        // run — the only cleanup path now that we never self-kill on a timer.
        sandboxOrphans: await runControl.reapOrphanSandboxContainers(),
      };
      if (Object.values(counts).some((n) => n > 0)) {
        logger.debug("Store sweep", counts);
      }
    } catch (err) {
      logger.warn("Store sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handle = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  handle.unref?.(); // never keep the process alive for the sweeper
  void sweep(); // initial pass cleans restart orphans immediately
  logger.debug("Store sweeper started", { intervalMs: SWEEP_INTERVAL_MS });
}
