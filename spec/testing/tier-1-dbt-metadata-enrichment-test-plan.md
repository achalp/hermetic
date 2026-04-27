# Test Plan — dbt Metadata Enrichment (Tier 1, Item #6)

_Last updated: 2026-04-25_

**Spec:** [`tier-1-implementation-plan-2026-04-25.md`](../tier-1-implementation-plan-2026-04-25.md) §"Item #6"

---

## What this feature does

When a connected warehouse is paired with a dbt project's `manifest.json`, table descriptions and column descriptions from dbt enrich the LLM context used for SQL generation. This sharpens AI accuracy: the model knows what `dim_customer.lifetime_value` actually means.

Reads file-based manifests only (`dbt docs generate` output). dbt Cloud API support is out of scope for v1.

---

## Files changed

- `src/lib/types.ts` — added optional `description` to `WarehouseColumnInfo` and `WarehouseTableSchema`; added `dbtManifestPath` to `StoredWarehouse`
- `src/lib/warehouse/dbt-metadata.ts` — **new**: parser, index, lookup, in-place enrichment, mtime cache
- `src/lib/warehouse/storage.ts` — added `setDbtManifestPath()` that loads the manifest and applies enrichment
- `src/lib/warehouse/sql-generation.ts` — `formatTableSchemas()` now renders descriptions inline as SQL comments
- `src/app/api/warehouse/dbt-metadata/route.ts` — **new** endpoint (`POST` to bind, `DELETE` to clear)
- `src/lib/api.ts` — added `bindDbtManifest()` / `unbindDbtManifest()`
- `src/components/app/settings/connected-sources-section.tsx` — new dbt-binding panel (input + Link / Unlink + status badge)
- `src/components/app/settings-drawer.tsx` — threaded `warehouseId` to the section
- `src/app/page.tsx` — passes `warehouseId` to `SettingsDrawer`
- `src/lib/__tests__/dbt-metadata.test.ts` — **14 unit tests**

---

## Automated tests

```bash
npx vitest run src/lib/__tests__/dbt-metadata.test.ts
```

Expect: **14 passed**. Coverage:

- `validateManifestPath`: empty, wrong filename, real manifest
- `loadDbtManifest`: indexing models + sources, source-identifier handling, schema.name fallback, missing-table behavior, mtime caching, mtime invalidation, malformed JSON
- `applyDbtMetadata`: in-place enrichment, schema.name fallback when database doesn't match, Trino `catalog.schema` form, no-overwrite of existing descriptions

```bash
npm run type-check
```

Expect: clean.

---

## Manual smoke test

### Setup

1. Start dev server: `npm run dev`
2. Open http://localhost:3000
3. Connect to any warehouse — easiest is the ClickHouse playground per README, or a local Postgres with the Pagila dataset.

### Test 1 — bind a real manifest

You need a dbt project with a generated manifest. If you don't have one, use the bundled fixture:

`/Users/achalp/dev/hermetic/data/test-fixtures/tier-1/dbt-enrichment/manifest.json`

This synthetic jaffle-shop manifest has 4 models + 1 source, all with table and column descriptions. It's database-named `jaffle` and schemas `analytics`, `staging`, `raw`. Bind it against any connection — the **schema.name fallback** in `applyDbtMetadata` lets it match even when the warehouse doesn't actually have a `jaffle` database, because lookups also fall back to schema.name.

To verify enrichment for a real warehouse, generate your own manifest:

```bash
cd <your-dbt-project>
dbt docs generate
ls target/manifest.json
```

1. Open Settings → **Connected Sources**
2. Find the **dbt project** panel below the connection status
3. Paste the absolute path to `manifest.json`
4. Click **Link manifest**

**Pass:**

- Within ~1s, a green badge appears: `linked: N / M tables`
- N is the count of warehouse tables that matched a dbt model/source
- M is the total number of warehouse tables

### Test 2 — confirm SQL generation receives descriptions

1. Bind a manifest
2. Ask a question that requires SQL across tables that have dbt descriptions
3. Open the **Artifacts** bottom sheet → **SQL** tab
4. _Server-side_, look for the SQL-gen prompt in your dev server log — the `formatTableSchemas` output should show `-- description...` SQL comments above each table and after each column when descriptions exist

**Pass:** the LLM uses the column description in its query (e.g. picks `lifetime_value` over `total` when the question is about lifetime spend).

### Test 3 — unbind preserves connection

1. Bind a manifest, observe enrichment
2. Click **Unlink**
3. Run an analysis

**Pass:** descriptions disappear from the SQL-gen prompt; warehouse continues to work; no errors.

### Test 4 — invalid path

1. Paste a non-existent path or a path to a file not named `manifest.json`
2. Click **Link manifest**

**Pass:** error message appears below the form, status stays `idle`.

### Test 5 — malformed manifest

1. Create a `manifest.json` with invalid JSON (`echo "{ broken" > /tmp/manifest.json`)
2. Try to bind it

**Pass:** error message: "dbt manifest is not valid JSON: ..."

### Test 6 — mtime invalidation

1. Bind a manifest, observe `linked: N / M`
2. Run a `dbt docs generate` again (or `touch` the file with new content)
3. Re-bind to the same path

**Pass:** the second link operation re-parses (cache miss because mtime changed). Verify in dev log: `[INFO] Loaded dbt manifest`.

---

## API contract

### Bind

```http
POST /api/warehouse/dbt-metadata
Content-Type: application/json

{ "warehouse_id": "...", "manifestPath": "/abs/path/to/manifest.json" }
```

Response:

```json
{
  "ok": true,
  "manifestPath": "/abs/path/to/manifest.json",
  "enrichedTableCount": 12,
  "totalTableCount": 47
}
```

Errors: `400` for invalid path, `404` for unknown warehouse, `500` for parse failure.

### Unbind

```http
DELETE /api/warehouse/dbt-metadata
Content-Type: application/json

{ "warehouse_id": "..." }
```

Response: `{ "ok": true }`.

---

## Known limitations / non-goals

- **File-based only.** dbt Cloud API support requires auth flow; deferred to v2.
- **No semantic-layer cells.** This is metadata enrichment, not a SQL-generation passthrough to dbt's MetricFlow.
- **Manifest-version drift.** Pinned to v10/v11. Newer schema versions parse with a warning but may miss new fields.
- **No tests as guardrails.** dbt model `tests:` blocks are not surfaced to the LLM in v1.
- **No incremental refresh awareness.** dbt model materializations (table/incremental/view) are not used for SQL hints.
- **Persistence.** The dbt manifest path is stored in-memory only. App restart drops the binding (consistent with the rest of the warehouse-connection lifecycle which already TTLs out).

---

## Sample fixture

`data/test-fixtures/tier-1/dbt-enrichment/manifest.json` — a small but realistic jaffle-shop-style manifest:

| Resource        | Type   | Schema    | Has description         |
| --------------- | ------ | --------- | ----------------------- |
| `customers`     | model  | analytics | Yes (table + 5 columns) |
| `orders`        | model  | analytics | Yes (table + 9 columns) |
| `stg_orders`    | model  | staging   | Yes (table + 2 columns) |
| `raw_customers` | source | raw       | Yes (table + 1 column)  |

dbt schema version: v11. Total payload: ~2.5 KB.

---

## Rollback

Revert these files (no DB or storage migrations needed):

- `src/lib/types.ts`
- `src/lib/warehouse/dbt-metadata.ts` (delete)
- `src/lib/warehouse/storage.ts`
- `src/lib/warehouse/sql-generation.ts`
- `src/app/api/warehouse/dbt-metadata/route.ts` (delete)
- `src/lib/api.ts`
- `src/components/app/settings/connected-sources-section.tsx`
- `src/components/app/settings-drawer.tsx`
- `src/app/page.tsx`

`StoredWarehouse.dbtManifestPath` is optional — connections without it continue to work identically.
