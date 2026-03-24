import { HiveClient, thrift, auth, connections } from "hive-driver";
import type {
  HiveConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/types";
import type { WarehouseConnector } from "./connector";

const { TCLIService_types } = thrift;

/** Convert a value to a CSV-safe string */
function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function createHiveConnector(config: HiveConnectionConfig): WarehouseConnector {
  const client = new HiveClient(TCLIService_types, TCLIService_types);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;
  let connected = false;

  const dbName = config.database || "default";

  async function ensureSession(): Promise<void> {
    if (session) return;

    // Build auth and connection based on auth method
    const authMethod = config.auth ?? "NONE";
    let authProvider;
    let connection;

    if (authMethod === "NOSASL") {
      authProvider = new auth.NoSaslAuthentication();
      connection = new connections.TcpConnection();
    } else if (authMethod === "LDAP" || authMethod === "NONE") {
      authProvider = new auth.PlainTcpAuthentication({
        username: config.user,
        password: config.password ?? "",
      });
      connection = new connections.TcpConnection();
    } else {
      // KERBEROS — use plain TCP as fallback (real Kerberos needs krb5 config)
      authProvider = new auth.PlainTcpAuthentication({
        username: config.user,
        password: config.password ?? "",
      });
      connection = new connections.TcpConnection();
    }

    await client.connect({ host: config.host, port: config.port }, connection, authProvider);
    connected = true;

    session = await client.openSession({
      client_protocol: TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10,
    });

    // Switch to the target database
    if (dbName !== "default") {
      await runSessionQuery(`USE \`${dbName}\``);
    }
  }

  /** Execute a query on the current session and return rows */
  async function runSessionQuery(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    await ensureSession();

    const operation = await session.executeStatement(sql, {
      runAsync: false,
    });

    const columns: string[] = [];
    const rows: unknown[][] = [];

    // Get schema (column names)
    const schema = await operation.getSchema();
    if (schema?.columns) {
      for (const col of schema.columns) {
        columns.push(col.columnName);
      }
    }

    // Fetch all rows
    let hasMore = true;
    while (hasMore) {
      const result = await operation.fetchChunk({ maxRows: 10000 });
      if (result && result.length > 0) {
        for (const row of result) {
          if (Array.isArray(row)) {
            rows.push(row);
          } else if (typeof row === "object" && row !== null) {
            rows.push(columns.map((c) => (row as Record<string, unknown>)[c]));
          }
        }
      } else {
        hasMore = false;
      }
      if (hasMore) {
        hasMore = await operation.hasMoreRows();
      }
    }

    await operation.close();
    return { columns, rows };
  }

  return {
    async testConnection() {
      await ensureSession();
      await runSessionQuery("SELECT 1");
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      await ensureSession();

      const { rows } = await runSessionQuery("SHOW TABLES");

      const tables: WarehouseTableInfo[] = [];
      for (const row of rows) {
        const tableName = String(row[0]);
        // Get column count via DESCRIBE
        try {
          const { rows: descRows } = await runSessionQuery(`DESCRIBE \`${tableName}\``);
          const colCount = descRows.filter(
            (r) => r[0] && String(r[0]).trim() && !String(r[0]).startsWith("#")
          ).length;

          tables.push({
            schema: dbName,
            name: tableName,
            row_count_estimate: 0,
            column_count: colCount,
          });
        } catch {
          tables.push({
            schema: dbName,
            name: tableName,
            row_count_estimate: 0,
            column_count: 0,
          });
        }
      }

      return tables;
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      await ensureSession();

      const { rows: tableRows } = await runSessionQuery("SHOW TABLES");
      const schemas: WarehouseTableSchema[] = [];

      for (const row of tableRows) {
        const tableName = String(row[0]);

        try {
          const { rows: descRows } = await runSessionQuery(`DESCRIBE \`${tableName}\``);

          const columns: WarehouseColumnInfo[] = [];
          for (const r of descRows) {
            const colName = String(r[0] ?? "").trim();
            const colType = String(r[1] ?? "").trim();
            if (!colName || colName.startsWith("#") || !colType) continue;
            columns.push({
              name: colName,
              type: colType,
              nullable: true, // Hive doesn't indicate nullability in DESCRIBE
            });
          }

          schemas.push({
            schema: dbName,
            name: tableName,
            columns,
            row_count_estimate: 0,
          });
        } catch {
          // Skip tables we can't describe
        }
      }

      return schemas;
    },

    async executeSQL(sql: string): Promise<string> {
      const { columns, rows } = await runSessionQuery(sql);

      if (rows.length === 0) return "";

      const lines = [columns.map(csvValue).join(",")];
      for (const row of rows) {
        lines.push(row.map(csvValue).join(","));
      }
      return lines.join("\n") + "\n";
    },

    async close() {
      try {
        if (session) {
          await session.close();
          session = null;
        }
        if (connected) {
          await client.close();
          connected = false;
        }
      } catch {
        // Best effort cleanup
      }
    },
  };
}
