# Dataset manifests: connect a catalog of Parquet entities as a virtual warehouse

Status: DRAFT v1 — for review before build
Date: 2026-08-30
Decisions locked with the author: LLM-fallback adapter deferred to V2; eager
introspection bounded by wall-clock (~1 min), lazy beyond it; **same-host-only,
strictly**; entity selection gets its own LLM pre-step.

## 1. Why

Most published Parquet datasets are not one file. They are a _collection_ of
entities — one file (or hive tree) per entity — described by a machine-readable
manifest at a stable URL. Today Hermetic can connect exactly one entity at a time
(the housing test connected `housing-landscape.parquet` by hand-copying its URL
out of `manifest.json`). The ask: paste the MANIFEST URL, and Hermetic understands
the whole dataset — lists every entity warehouse-style (schema, row counts, sample
rows), and lets a question target any entity or span several, with the LLM forming
the query.

## 2. Research summary: there is no single manifest standard

Verified against live examples and current specs (2026-08):

| Format                                                          | Kind                                                        | Detection                                         | Carries                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| Frictionless **datapackage.json**                               | real standard (v2 supports parquet)                         | `resources[]` + `$schema`/`profile`               | paths, per-resource Table Schema incl. column descriptions    |
| **Croissant** / schema.org Dataset (JSON-LD)                    | real standard; auto-published for every HuggingFace dataset | `@context` schema.org + `@type Dataset`           | `distribution` (FileObject/FileSet), `recordSet` typed fields |
| **Generic `files[]`** convention                                | convention (OpenAlex; the housing manifest)                 | array of `{name,url,…}` objects with parquet URLs | urls, descriptions, row counts, bytes, sha256                 |
| Iceberg / Delta table metadata                                  | per-TABLE standard                                          | `metadata.json` / `_delta_log`                    | single table only; DuckDB extensions read them                |
| Catalog APIs (CKAN, Socrata, STAC, Delta Sharing, Iceberg REST) | protocols, not manifests                                    | —                                                 | out of scope for "paste a URL"                                |

Consequence: a small **adapter layer** normalizes any recognized format into ONE
internal shape; everything downstream is format-agnostic. V1 ships three adapters
(datapackage, croissant/schema.org, generic files[]). Iceberg/Delta and the
LLM-fallback adapter are V2 (§10).

On the LLM-fallback adapter being "super cheap": the CALL is cheap (one
structured-output invocation against a JSON blob). The real cost is the golden
record/replay surface (nondeterministic prompt input must be gated under
llmReplayConfig) plus adversarial-manifest testing. Not super cheap → V2. The
adapter interface (§4) is designed so it slots in as just another adapter.

## 3. What already exists (reuse — verified against code)

- **Multi-entity prompt context**: `buildWorkbookContext` (llm/prompts.ts) already
  renders N entities with per-entity schemas, row counts, file paths, and inferred
  relationships (`WorkbookManifest` in contracts/data-schema.ts; `detectRelationships`
  over sheets). A manifest dataset is structurally a workbook whose sheets are
  remote parquet entities.
- **Per-entity schema extraction, both runtimes**: `extractRemoteParquetSchema`
  (Docker, parquet/schema-extractor.ts) and the D27 worker flow
  (`/api/remote-parquet/schema` two-hop, parquet/wasm-schema-job.ts), both cached
  in schema-cache.
- **Per-entity storage**: `storeRemoteParquetRef` (csv/storage.ts) keys one remote
  entity per csvId; the entire query pipeline (run-ask-query.ts isRemoteFile path,
  Docker egress network, wasm materialize/aliases) hangs off it unchanged.
- **URL hygiene**: `isSafeParquetUrl`, `normalizeRemoteParquetUrl` (globs/hive),
  `deriveAllowedEgressHosts`, and the Rust egress core (GET-only, allowlist,
  resolve-and-reject, IP pinning, no-follow, byte caps).
- **Presentation**: warehouse sources already have a table-browser UX; per-entity
  `CSVSchema` carries `sample_rows`, which warehouse tables do not — entity display
  gets sample data for free.

**Anti-decision**: the virtual warehouse is a presentation + prompt-context
concept, NOT a `WarehouseConnector`. A connector whose `executeSQL` runs DuckDB
host-side would do network I/O from the host — forbidden (host DuckDB must stay
network-inert; remote reads go through the egress core / sandbox). The analysis
path for remote parquet already exists on both runtimes; we ride it.

## 4. Contracts

```ts
// lib/contracts/dataset-manifest.ts (new)
export interface ManifestEntity {
  /** Display + selection name, unique within the manifest (slugified). */
  name: string;
  /** One url (single parquet) or a prefix/glob (hive tree) — same host as manifest. */
  url: string;
  isHivePartitioned?: boolean;
  /** From the manifest itself — available BEFORE any parquet is touched. */
  description?: string;
  rowCountHint?: number;
  bytesHint?: number;
  sha256?: string;
  /** Column docs harvested from the adapter (datapackage/croissant), if present. */
  columnDocs?: { name: string; description: string }[];
}
export interface DatasetManifest {
  manifestUrl: string;
  format: "datapackage" | "croissant" | "files-array";
  title?: string;
  description?: string;
  license?: string;
  entities: ManifestEntity[]; // ≤ MAX_MANIFEST_ENTITIES (200)
}
```

Adapter signature: `(json: unknown, manifestUrl: string) => DatasetManifest | null`
— pure, throw-free, first-match-wins in a fixed order (datapackage, croissant,
files-array). A parse that matches no adapter fails the connect with a message
naming the three supported forms.

Stored state (in-memory, same lifecycle as csv storage; expensive artifacts live
in schema-cache): a `manifestId` → `{ manifest, entities: Map<name, {csvId?, status:
"pending"|"ready"|"failed", error?}> }`. A **ready** entity has been introspected
and registered via `storeRemoteParquetRef` under its own csvId — from that moment
every existing per-entity mechanism works on it untouched.

## 5. Connect flow

1. **Detection** — same cloud-URL dialog. Path ends `.json`/`.jsonld` → manifest
   flow. (Everything else keeps today's behavior.)
2. **Fetch the manifest through the egress core** — `fetchRemoteRange` GET, cap
   8 MB, after `isSafeParquetUrl`-style validation of the manifest URL itself.
   Never a plain host-side fetch.
3. **Adapt + gate**: run adapters; then per entity: normalize the url
   (`normalizeRemoteParquetUrl`), and enforce **same-host strictly** — the
   entity's normalized https vhost must be byte-equal to the manifest's host
   (`s3://bucket/…` entries resolve to their vhost first). Any violating entry is
   DROPPED with a logged warning and surfaced in the UI as "excluded: cross-host";
   if ALL entries violate, the connect fails closed. No override in v1.
4. **Instant entity index**: the UI lists every entity immediately from manifest
   metadata alone (name, description, rowCountHint, bytes) — zero parquet reads.
5. **Eager-within-budget introspection**: `MANIFEST_EAGER_BUDGET_MS = 60_000`.
   Docker: ONE ephemeral egress container runs a combined script that loops
   entities (schema-extractor grows a multi-target mode — one container spin-up,
   not N); wasm: sequential D27 worker jobs. Entities finished inside the budget
   become **ready**; the rest stay **pending** and extract lazily on first touch
   (browser click or question selection). A small manifest (≈ a minute of work)
   is therefore fully eager, exactly per the decision.
6. **Fingerprint**: the schema-cache fingerprint for the whole source is the
   manifest's content hash (`manifest:<sha256(bytes)>`) — cheaper and stricter
   than any listing. Per-entity artifacts keep their existing per-URL cache keys.
7. **Recent sources**: one entry (kind "manifest"), so re-connect is one click.

## 6. Entity browser (the "virtual warehouse" view)

Warehouse-style listing, backed by per-entity `CSVSchema`:

- table list: name, description (from manifest), row count (hint until ready,
  exact when ready), status chip (pending/ready/failed);
- detail: columns with dtype + meta, `sample_rows`, columnDocs merged in when the
  adapter carried them (rendered like dbt docs on warehouse columns);
- relationships: `detectRelationships` across ready entities' schemas, displayed
  like workbook relationships.
  MCP parity: `connect_source` accepts the manifest URL through its existing `url`
  input (detection is server-side); `get_schema` returns the entity list + ready
  schemas.

## 7. Question flow — the selection pre-step (decided)

A 28-entity manifest cannot ship 28 full schemas to code-gen. Two-level context:

1. **Pre-step** (new, before code-gen): cheap-tier model, low effort, strict JSON
   output. Input: the question + a one-line-per-entity index (name, truncated
   description, rowCountHint, yearsCovered when known). Output:
   `{ entities: string[] }`, 1..K names (K = 4 default, hard cap 6).
   - Deterministic fallback on parse failure/empty: keyword-overlap between
     question and entity name/description; still capped at K.
   - NOT cached across questions (scanWindow lesson: a cached pick serves a wrong
     scope to a different question). Retries within a run REUSE the run's pick.
   - An entity named explicitly in the question is always included.
2. **Selected entities**: any still-pending selected entity is introspected now
   (lazy materialization of the schema, not the data).
3. **Code-gen context**: workbook-shaped section — per selected entity: name, read
   expression (`read_parquet('<url>')` / hive glob form), full schema in metadata
   mode, columnDocs, plus cross-entity relationships. Primary entity = first
   selected; its csvId drives the existing pipeline plumbing (isRemoteFile path).
4. **Execution** — nothing new on Docker: the egress allowlist is the single
   manifest host; generated DuckDB reads N urls, joins freely.
   WASM v1: each selected entity is materialized host-side through the existing
   parquet→CSV bridge (remote-fetch.ts) and delivered like workbook sheets
   (`/data/entities/<name>.csv`), under the existing size ceilings — over-ceiling
   entities fail with the existing "switch to Docker" guidance. Ranged multi-entity
   DuckDB-in-worker (alias fan-out per entity) is the V2 upgrade that removes the
   ceiling; the D21 machinery already supports N aliases, so this is wiring, not
   architecture.

## 8. Security & trust notes

- **A manifest is untrusted remote content that names other URLs.** Adapters are
  pure parsers; every entry re-passes URL validation; the strict same-host rule
  means a hostile manifest cannot point Hermetic at ANY other origin — and the
  egress proxy's resolve-and-reject remains the boundary beneath even that.
- **Caps**: manifest ≤ 8 MB; ≤ 200 entities; name/description lengths clamped.
- **Prompt-injection surface (new, must be stated)**: entity descriptions and
  columnDocs flow from the manifest into LLM prompts. Mitigations: length clamps,
  control-character stripping, and — the real bound — generated code still executes
  inside the sandbox with allowlist-only egress to the manifest's own host, so a
  hostile description cannot exfiltrate beyond the host that supplied it.
- **Credentials**: v1 supports public manifests and the existing creds dialog for
  the (same) host. Per-file presigned manifests / Delta Sharing tokens: V2.
- sha256 hints, when present, MAY be verified on wasm-tier materialization
  (cheap integrity win; optional, logged-not-fatal on mismatch).

## 9. Phasing

- **P0 — contracts + adapters** (pure, fast tests): dataset-manifest.ts, three
  adapters, same-host gate, caps. Gate: adversarial fixture suite (cross-host,
  oversized, malformed, entity-name collisions).
- **P1 — connect (Docker)**: egress-core fetch, store, multi-target extraction
  script, eager-budget loop, entity browser, recent-sources, fingerprint.
  Gate: housing manifest connects end-to-end; eager completes inside budget.
- **P2 — question flow**: selection pre-step (+ replay gating for goldens),
  manifest prompt context, relationship inference, MCP parity.
  Gate: cross-entity JOIN question on the housing dataset produces a correct
  dashboard on Docker.
- **P3 — wasm tier**: lazy D27 introspection wiring + materialize-selected
  delivery. Gate: same question on built-in runtime (within ceilings).
- **V2 (explicitly deferred)**: LLM-fallback adapter; Iceberg/Delta single-table
  (Docker first — extensions must land in the image); ranged multi-entity worker
  reads; cross-host opt-in; catalog APIs; presigned/tokened manifests.

## 10. Settled vs open

Settled: adapter-layer architecture; ride the file-source pipeline, not
WarehouseConnector; strict same-host; 60 s eager budget then lazy; selection
pre-step (uncached across questions, reused within a run); V1 adapter set.

Settled in review (2026-08-30, author): **K = 4, hard cap 6.** Entity browser is
master-detail — a list of entities; clicking one shows its schema, sample rows,
and any description carried by the manifest or the dataset, with the dataset-level
description displayed too. **Ships straight in, no flag.** The selection pre-step
runs on the **code-gen model tier** (not the suggest/title tier): the pick decides
what the expensive step sees, so it gets the better model.

## 11. Build log

**P0 — DONE** (#178): contracts (`lib/contracts/dataset-manifest.ts`), three
adapters + fixed order, strict same-host gate on storage identity, caps/clamps.
27 tests.

**P1 — BUILT** (this PR): connect flow on Docker.

- `lib/manifest/fetch.ts` — manifest fetched through the egress core (8 MB cap,
  oversize named by size, not by a JSON-parse error).
- `lib/manifest/connect.ts` — deps-injected orchestration: cache pass (per-entity
  sourceKey IDENTICAL to the single-URL route, so both doors share cache lines;
  fingerprint = entity sha256 when the manifest carries one, else the manifest
  hash), then eager batch inside the 60 s budget, then pending for the rest.
- `parquet/schema-extractor.ts extractRemoteParquetSchemaBatch` — ONE container +
  ONE egress network for N entities (per-call setup measured ~1.5–2 s; N
  containers would eat the whole budget), each entity running the UNCHANGED
  single-entity script so profiling cannot fork. Budget checked before each
  entity; per-entity failures recorded, never fatal to the batch.
- Routes: `POST /api/manifest/connect`, `GET /api/manifest/[id][?entity=]`,
  `POST /api/manifest/attach` (lazy-extraction report-back; refuses a csvId
  whose stored URL is not exactly the entity's normalized URL).
- Lazy = the EXISTING per-entity flow: the client extracts a pending entity as
  if its URL had been pasted directly (works on both runtimes today, including
  the wasm two-hop), then attaches the csvId. P3 only improves ergonomics.
- UI: `.json` detection in the remote dialog → `EntityBrowser` (master-detail
  per review; "Analyze this entity" makes it the active source — single-entity
  questions work NOW, ahead of P2).

P1 shortcuts, deliberate: recent-sources entry reuses kind "remote-parquet"
(re-open flows back through .json detection; proper kind is P2 polish); no MCP
surface yet (P2); the D28 parquet coverage ratchet caught the batch extractor
untested and forced the docker-mocked orchestration tests — the ratchet doing
its job on the code of the person who added it.

**P1 gate NOT yet verified live**: the housing manifest end-to-end connect needs
the running app (author-driven, like every live gate in this project).
Remaining: P2 (selection pre-step + manifest prompt context + MCP), P3 (wasm).

**P1 revision (author review, 2026-08-31): entities live IN the Data Explorer,
not a separate panel.** The author's screenshot made the argument: the explorer
already IS the master-detail this feature wants, proven at 66 warehouse tables.
The separate `EntityBrowser` modal is deleted. Implementation insight that made
it small: manifest mode reuses the warehouse LAYOUT (entity list + detail) but
the csv DATA path — selecting an entity makes it the page's ACTIVE SOURCE
(`handleUpload`), so the explorer's schema/profile/sample sections feed
themselves through the ordinary csv props. No second data path, no sample
fetching; selection is external (`activeItem`/`onSheetSelect`). Connect
auto-selects the first READY entity (else lazily extracts the first) so the rail
opens with a real schema immediately. Pending entities show "not read yet" and
extract on click.
