# Test Plan — Snowflake + Databricks Connectors (Tier 1, Item #1)

_Last updated: 2026-04-25_

**Spec:** [`tier-1-implementation-plan-2026-04-25.md`](../tier-1-implementation-plan-2026-04-25.md) §"Item #1"

---

## What this feature does

Adds two new warehouse connectors — **Snowflake** and **Databricks** — bringing the supported total from 5 to 7. Both implement the existing `WarehouseConnector` interface so the rest of the pipeline (`/api/warehouse/connect`, `/api/warehouse/query`, SQL generation, refresh, dbt enrichment) lights up automatically.

v1 supports password auth (Snowflake) and Personal Access Token auth (Databricks). OAuth + keypair are deferred.

---

## Files changed

- `src/lib/types.ts` — extended `WarehouseType` union; new `SnowflakeConnectionConfig` and `DatabricksConnectionConfig` interfaces
- `src/lib/warehouse/snowflake.ts` — **new** (~210 lines)
- `src/lib/warehouse/databricks.ts` — **new** (~150 lines)
- `src/lib/warehouse/connector.ts` — `createConnector` switch extended
- `src/lib/warehouse/sql-generation.ts` — `DIALECT_NOTES` extended; quoting branch in `formatTableSchemas` for both
- `src/lib/warehouse/persist-env.ts` — `buildLabel` extended
- `src/app/api/warehouse/connect/route.ts` — type whitelist extended
- `src/components/app/warehouse-connect-panel.tsx` — `Tab` union, tabs, `SnowflakeForm`, `DatabricksForm`, saved-connection edit dispatch, connection-name display
- `next.config.ts` — `snowflake-sdk` and `@databricks/sql` added to `serverExternalPackages`
- `package.json` — `snowflake-sdk@^2.4.0`, `@databricks/sql@^1.13.0` added
- `src/lib/__tests__/snowflake-databricks-connectors.test.ts` — **13 unit tests**

---

## Automated tests

```bash
npx vitest run src/lib/__tests__/snowflake-databricks-connectors.test.ts
```

Expect: **13 passed**.

Coverage:

- Snowflake: `testConnection`, `listTables`, `introspectAllTables` (incl. PK + FK aggregation), `executeSQL` CSV formatting (with comma + quote escaping), empty-result handling, `close`, db/schema uppercase normalization, error propagation
- Databricks: `testConnection`, `listTables` (with three-part name + catalog quoting), `introspectAllTables`, `executeSQL` CSV formatting, `close`

```bash
npm run type-check
```

Expect: clean.

---

## Manual smoke test

### Snowflake (sample share)

You need a Snowflake account with the bundled `SNOWFLAKE_SAMPLE_DATA` share enabled (it is by default on most accounts).

1. Open Settings → identify your account locator (e.g. `abc12345.us-east-1`)
2. Home screen → click **Connect a warehouse** → **Snowflake** tab
3. Fill in:
   - **Account:** `<your-account-locator>`
   - **User:** `<username>`
   - **Password:** `<password>`
   - **Database:** `SNOWFLAKE_SAMPLE_DATA`
   - **Schema:** `TPCH_SF1`
   - **Warehouse:** `COMPUTE_WH` (or any active warehouse)
   - **Role:** leave blank or `PUBLIC`
4. Click **Connect**

**Pass:**

- Status badge: "Connected to Snowflake · 8 tables · ~62 columns"
- Data Explorer rail shows tables: CUSTOMER, LINEITEM, NATION, ORDERS, PART, PARTSUPP, REGION, SUPPLIER
- Ask: _"What are the top 5 nations by total order revenue?"_
- Dashboard renders in <30s. Artifacts panel SQL tab shows generated Snowflake-flavored SQL with `LIMIT 50000` and proper case handling.

### Databricks (Unity Catalog samples)

You need a Databricks workspace with a SQL Warehouse running and a PAT.

1. In Databricks UI: SQL Warehouses → pick one → "Connection Details" → copy **Server hostname** and **HTTP Path**
2. User Settings → "Personal access tokens" → generate token (`dapi-...`)
3. Hermetic home screen → **Connect a warehouse** → **Databricks** tab
4. Fill in:
   - **Server Hostname:** `abc-123.cloud.databricks.com`
   - **HTTP Path:** `/sql/1.0/warehouses/abc123`
   - **Personal Access Token:** `dapi...`
   - **Catalog:** `samples`
   - **Schema:** `nyctaxi`
5. Click **Connect**

**Pass:**

- Status badge: "Connected to Databricks · 1 table · 6 columns" (`samples.nyctaxi.trips`)
- Ask: _"What's the average fare by pickup hour?"_
- Dashboard renders. Artifacts SQL tab shows three-part `\`samples\`.\`nyctaxi\`.\`trips\`` qualifier in the generated SQL.

### Cross-checks

1. **Existing connectors still work.** Connect to ClickHouse playground per README — confirm same behavior as before.
2. **dbt enrichment works on the new connectors.** With a Snowflake or Databricks connection live, paste a `manifest.json` path in Settings → Connected Sources → dbt project. Status badge should show `linked: N / M tables`.
3. **Saved connection round-trip.** After successfully connecting, disconnect, then reconnect via the saved-connection pill. The form should pre-populate.

---

## Known limitations / non-goals

- **Snowflake auth:** password only in v1. Keypair / OAuth / external browser SSO deferred to v2.
- **Databricks auth:** PAT only in v1. OAuth (M2M, U2M) deferred.
- **Snowflake:** no `connections.toml` resolution; users must paste credentials.
- **Databricks:** `row_count_estimate` reported as 0 because `information_schema.tables` doesn't expose it cheaply on Unity Catalog. The `inferRelationships` post-processor still works for FK hints.
- **Databricks:** complex types (struct, array, map) are JSON-stringified into the CSV. The LLM analysis layer treats them as opaque strings.
- **Snowflake:** identifiers are uppercased server-side when unquoted; we uppercase the user-provided database/schema before issuing INFORMATION_SCHEMA queries to match.
- **Bundle size:** `snowflake-sdk` is ~13 MB on disk including transitive deps. It is added to `serverExternalPackages` so it never ships to the client.

---

## Sample test data / setup notes

No bundled fixture — both connectors require live credentials. Free options:

- **Snowflake:** 30-day free trial at signup.snowflake.com — comes with `SNOWFLAKE_SAMPLE_DATA`
- **Databricks:** Community Edition (signup.databricks.com) — comes with `samples` catalog including `nyctaxi`

For driver-level integration testing without live credentials, the unit-test suite uses `vi.mock` to substitute fake SDKs that exercise every code path. Live credentials are only needed for the manual smoke test.

---

## Rollback

Revert these files:

- `src/lib/types.ts`
- `src/lib/warehouse/snowflake.ts` (delete)
- `src/lib/warehouse/databricks.ts` (delete)
- `src/lib/warehouse/connector.ts`
- `src/lib/warehouse/sql-generation.ts`
- `src/lib/warehouse/persist-env.ts`
- `src/app/api/warehouse/connect/route.ts`
- `src/components/app/warehouse-connect-panel.tsx`
- `next.config.ts`
- `package.json` + `package-lock.json` (`npm uninstall snowflake-sdk @databricks/sql`)

Existing 5 warehouses keep working — the `WarehouseConnector` contract is unchanged.
