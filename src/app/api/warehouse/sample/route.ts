import { getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";

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

  try {
    const csv = await connector.executeSQL(buildSampleQuery(tableName, warehouse.config.type));

    // Parse CSV into rows
    const lines = csv.trim().split("\n");
    if (lines.length < 2) {
      return Response.json({ headers: [], rows: [] });
    }

    const headers = parseCSVLine(lines[0]);
    const rows = lines.slice(1).map(parseCSVLine);

    return Response.json({ headers, rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch sample";
    return Response.json({ error: msg }, { status: 500 });
  }
}

function buildSampleQuery(table: string, dbType: string): string {
  switch (dbType) {
    case "postgresql":
      return `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT 5`;
    case "bigquery":
      return `SELECT * FROM \`${table}\` LIMIT 5`;
    case "clickhouse":
      return `SELECT * FROM \`${table.replace(/`/g, "\\`")}\` LIMIT 5`;
    default:
      return `SELECT * FROM "${table}" LIMIT 5`;
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
