/**
 * Shared warehouse-query hardening — the single path BOTH Ask and Investigate
 * run their SQL through, so every reliability/error-recovery fix lands once and
 * applies to both. Today that means:
 *
 *   1. Bound the scan from engine METADATA (no table scan) before generating,
 *      so the model can't guess a too-wide window and trip "rows to read
 *      exceeded" on a billion-row table.
 *   2. Self-heal: generate → execute → on ANY engine error feed it back to the
 *      model and retry (generateSQLWithRepair). The repair prompt already knows
 *      how to fix TOO_MANY_ROWS / memory blowups / empty results.
 *
 * Future warehouse-SQL fixes belong HERE, not in a route.
 */
import type { ConversationTurn } from "@/lib/contracts/storage-types";
import type { WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";
import type { WarehouseType } from "@/lib/contracts/connection-configs";
import type { WarehouseConnector } from "./connector";
import { generateSQLWithRepair } from "./sql-generation";
import { pickMaterializationScope } from "./materialization-scope";
import { PLANNER_MODEL } from "@/lib/constants";
import { withWakeLock } from "@/lib/wake-lock";
import { logger } from "@/lib/logger";

export type SqlAttemptPhase = "generating" | "executing" | "repairing";

/**
 * Best-effort metadata scan-window hint. Picks the primary table + date column
 * (a cheap Haiku call) and asks the connector to size a recent window from
 * engine metadata (no scan), then returns prompt text binding SQL-gen to it.
 * Empty string when no window can be derived — the SQL-gen system prompt's
 * generic scan-bounding guidance still applies. Shared so Ask and Investigate
 * bound their scans identically.
 */
export async function scanWindowHint(args: {
  question: string;
  tables: WarehouseTableSchema[];
  connector: Pick<WarehouseConnector, "getScanSafeWindow">;
  /** Target rows for sizing the metadata scan window (a SCAN budget, not the
   *  output cap) — see WAREHOUSE_SCAN_ROW_BUDGET. */
  scanRowBudget: number;
  model?: string;
}): Promise<string> {
  try {
    const scope = await pickMaterializationScope(
      args.question,
      args.tables,
      args.model ?? PLANNER_MODEL
    );
    if (!scope || !args.connector.getScanSafeWindow) return "";
    const win = await args.connector.getScanSafeWindow(
      scope.table,
      scope.dateColumn,
      args.scanRowBudget
    );
    if (!win) return "";
    logger.info("Warehouse scan window", {
      table: scope.table,
      column: win.column,
      start: win.start,
      end: win.end,
      estimatedRows: win.estimatedRows,
    });
    // Bind the window to the table it was sized FOR. The scope picker chooses one
    // primary table, but the query may target a DIFFERENT table (or a join), and
    // applying one table's partition window to another's column returns zero rows.
    return (
      `\nSCAN BUDGET (sized from metadata for table \`${scope.table}\`): if your main scan IS \`${scope.table}\`, constrain its \`${win.column}\` to >= '${win.start}' AND <= '${win.end}' — this window is already sized to stay under the engine's read limit, so do NOT widen it (a wider range trips "rows to read exceeded"), and keep it alongside any status/category filter. ` +
      `If your query's primary table is DIFFERENT from \`${scope.table}\` (e.g. a join pulls mainly from another table), do NOT copy this column/window — instead bound THAT table's own most-recent partition/date column to a comparable window.`
    );
  } catch {
    return "";
  }
}

/**
 * Generate + execute a warehouse query with the full shared hardening (scan
 * bound + self-healing repair). Returns the SQL that finally ran and its CSV
 * result. Throws only after exhausting repairs.
 *
 * Does NOT bail on resource-limit errors: narrowing a too-wide scan IS the
 * recovery, and neither caller has a cheaper fallback than fixing it here.
 */
export async function runWarehouseQuery(args: {
  tables: WarehouseTableSchema[];
  connector: WarehouseConnector;
  warehouseType: WarehouseType;
  /** The framed question (Ask: the user's question; Investigate: the row-pull prompt). */
  question: string;
  /** Code-gen model for SQL generation/repair. */
  model: string;
  /** Target rows for sizing the metadata scan window (a SCAN budget, not the
   *  output cap) — see WAREHOUSE_SCAN_ROW_BUDGET. */
  scanRowBudget: number;
  /** Cheaper model for the scope pick; defaults to PLANNER_MODEL. */
  scopeModel?: string;
  /** Follow-up context (prior questions + their SQL) for SQL generation. */
  priorTurns?: ConversationTurn[];
  onAttempt?: (attempt: number, phase: SqlAttemptPhase) => void;
}): Promise<{ sql: string; csv: string }> {
  const hint = await scanWindowHint({
    question: args.question,
    tables: args.tables,
    connector: args.connector,
    scanRowBudget: args.scanRowBudget,
    model: args.scopeModel,
  });
  const outcome = await generateSQLWithRepair({
    tables: args.tables,
    question: args.question + hint,
    warehouseType: args.warehouseType,
    model: args.model,
    priorTurns: args.priorTurns,
    execute: async (sql) => {
      try {
        // A warehouse query can run for minutes while the driver polls the API
        // over the network; idle sleep drops that connection (surfacing as
        // "Cannot connect to API"). Hold the wake lock for the execution, same
        // as the Docker sandbox — this path was the one gap the sandbox-only
        // wake lock left open.
        const csv = await withWakeLock("warehouse-query", () => args.connector.executeSQL(sql));
        if (!csv || csv.trim() === "") throw new Error("SQL query returned no results");
        return csv;
      } catch (err) {
        // Driver-level context at the shared chokepoint — the connectors
        // themselves log nothing, so engine quirks (auth failures, dialect
        // errors) previously surfaced only as generic repair-loop errors.
        logger.warn("Warehouse SQL execution failed", {
          warehouseType: args.warehouseType,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
        throw err;
      }
    },
    onAttempt: args.onAttempt,
  });
  return { sql: outcome.sql, csv: outcome.result };
}
