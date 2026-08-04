/**
 * The MCP harness's dependency seam (mcp-server spec §4, M1).
 *
 * Every tool handler takes an `McpDeps` — never imports a lib function
 * directly — so tests exercise handlers with fakes and the lib surface the
 * harness consumes is enumerated in ONE place. `realDeps()` is the only
 * binding to the real libraries; if a lib module ever grows a framework
 * dependency, this file is where the harness-purity grep will catch it.
 */
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV } from "@/lib/csv/storage";
import { createConnector } from "@/lib/warehouse/connector";
import { loadConnections } from "@/lib/warehouse/persist-env";
import { assertReadOnlySql } from "@/lib/warehouse/sql-guard";

export interface McpDeps {
  parseCSV: typeof parseCSV;
  extractSchema: typeof extractSchema;
  storeCSV: typeof storeCSV;
  createConnector: typeof createConnector;
  loadConnections: typeof loadConnections;
  assertReadOnlySql: typeof assertReadOnlySql;
}

export function realDeps(): McpDeps {
  return {
    parseCSV,
    extractSchema,
    storeCSV,
    createConnector,
    loadConnections,
    assertReadOnlySql,
  };
}
