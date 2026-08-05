import { getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";
import { ENGINES } from "@/lib/warehouse/engine-descriptor";
import { apiError } from "@/app/lib/api-error";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const warehouseId = url.searchParams.get("warehouse_id");
  const tableName = url.searchParams.get("table");

  if (!warehouseId || !tableName) {
    return Response.json({ error: "warehouse_id and table are required" }, { status: 400 });
  }

  const warehouse = getStoredWarehouse(warehouseId);
  if (!warehouse) {
    return Response.json({ error: "Warehouse not found or expired" }, { status: 404 });
  }

  const connector = getWarehouseConnector(warehouseId);
  if (!connector) {
    return Response.json({ error: "Warehouse connector not found" }, { status: 404 });
  }

  // Membership check: `table` is user input interpolated into SQL. Requiring
  // it to be one of the connection's introspected tables kills injection at
  // the source (the identifier then comes from our own introspection, not the
  // request) — the Snowflake branch below has no escaping at all, and the
  // backtick-escaping on the other branches is dialect-questionable.
  const wanted = tableName.toLowerCase();
  const known = warehouse.tables.some(
    (t) => t.name.toLowerCase() === wanted || `${t.schema}.${t.name}`.toLowerCase() === wanted
  );
  if (!known) {
    return Response.json({ error: "Unknown table for this connection" }, { status: 400 });
  }

  try {
    // Per-engine identifier quoting lives in the engine descriptor (ARCH-12).
    const csv = await connector.executeSQL(ENGINES[warehouse.config.type].sampleQuery(tableName));

    // Parse CSV into rows
    const lines = csv.trim().split("\n");
    if (lines.length < 2) {
      return Response.json({ headers: [], rows: [] });
    }

    const headers = parseCSVLine(lines[0]);
    const rows = lines.slice(1).map(parseCSVLine);

    return Response.json({ headers, rows });
  } catch (err) {
    return apiError("/api/warehouse/sample", err, "Failed to fetch sample");
  }
}

/** Simple CSV line parser that handles quoted fields */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}
