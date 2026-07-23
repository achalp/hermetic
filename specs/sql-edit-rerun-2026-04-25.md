# SQL Edit-and-Rerun Spec

_Last updated: 2026-04-25_

Extends Item #2 (Edit-and-Rerun) to support SQL editing alongside Python.
References [`tier-1-implementation-plan-2026-04-25.md`](./tier-1-implementation-plan-2026-04-25.md) §"Item #2".

---

## Goal

When the data source is a warehouse, the user can edit the generated SQL in the Artifacts panel and click Re-run to execute the edited SQL against the warehouse, producing a fresh CSV → fresh Python code-gen → fresh dashboard.

---

## Why this needs more than a copy of the Python edit-rerun

Python edit-rerun has a clean property: the CSV is unchanged, so the existing artifacts cache and downstream UI-compose have a stable schema to work against. We could even skip the UI-compose if we wanted, just refreshing computed values.

SQL edit-rerun is different. **Editing SQL fundamentally changes the result columns.** A SQL that produced `(region, revenue)` might be edited to produce `(region, quarter, revenue, units)`. The Python that worked on the old shape will fail on the new shape. So:

- ✅ Skip SQL generation (use the user's edited SQL)
- ✅ Execute SQL against the warehouse
- ❌ Cannot skip Python code-gen — the schema may have changed
- ❌ Cannot skip UI-compose — the components depend on the new shape

The flow: `editedSQL → execute → CSV → re-extract schema → Python code-gen → execute → UI compose`. This is identical to the standard warehouse pipeline except the first step.

---

## Server contract

Extend `/api/query` to accept an optional `context.sql`:

```ts
{
  prompt: "...",
  context: {
    csv_id: "...",          // optional — exists for repeat warehouse runs
    warehouse_id: "...",    // required for SQL editing
    question: "...",
    code: "...",            // existing — Python edit-rerun
    sql: "...",             // NEW — SQL edit-rerun
    // ... other existing fields
  }
}
```

Server-side branch logic:

| `context.sql` | `context.code` | Behavior                                                                                  |
| ------------- | -------------- | ----------------------------------------------------------------------------------------- |
| unset         | unset          | Standard flow: NL→SQL → exec → Python gen → exec → compose                                |
| set           | unset          | Skip NL→SQL, exec edited SQL, full Python gen path                                        |
| unset         | set            | Skip Python gen, run user's Python (existing edit-rerun)                                  |
| set           | set            | Skip both, exec edited SQL, run user's Python (advanced — user owns column compatibility) |

The "set, set" case lets a power-user edit both SQL and Python before re-running. If the columns don't match, the sandbox throws a normal error — no special handling.

---

## Client contract

The artifacts-viewer's `onRequestRerun` callback evolves from a string to an object:

```ts
// Before
onRequestRerun?: (code: string) => void;

// After
onRequestRerun?: (edits: { code?: string; sql?: string }) => void;
```

The viewer determines what changed:

- Python tab Re-run → `{ code: editedCode }`
- SQL tab Re-run → `{ sql: editedSql }`
- (Future: a "Re-run both" button could send `{ code, sql }` — out of scope for v1)

Page-level state action `RERUN_WITH_EDITED_CODE` is renamed `RERUN_WITH_EDITS` and accepts both:

```ts
| { type: "RERUN_WITH_EDITS"; question: string; code?: string; sql?: string }
```

Page state grows a `rerunSql: string | null` field alongside `rerunCode`. ResponsePanel sends both as `context.code` and `context.sql`. `STREAM_END` clears both.

---

## SQL tab UX

Currently read-only. Becomes editable for warehouse-sourced analyses (the SQL tab only appears when there's SQL to show, which means warehouse-only).

Toolbar gains the same Re-run / Discard buttons the Python tab has, mirroring the existing UX. A single "edited" indicator and rerun-state surface — exact same pattern.

The user is responsible for writing valid SQL for their warehouse dialect. Sandbox-style errors come back in the same toolbar status spot. Discard reverts to the server's stored SQL.

---

## Implementation files

| File                                         | Change                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/app/api/query/route.ts`                 | Accept `context.sql`, branch the SQL-gen step                                |
| `src/components/app/artifacts-viewer.tsx`    | Make SQL tab editable, add Re-run/Discard, update `onRequestRerun` signature |
| `src/components/app/artifacts-panel.tsx`     | Forward updated callback signature                                           |
| `src/hooks/use-page-state.ts`                | Rename action, add `rerunSql` field, extend STREAM_END                       |
| `src/components/app/response-panel.tsx`      | New `rerunSql` prop, send as `context.sql`                                   |
| `src/app/page.tsx`                           | Pass `rerunSql`, dispatch new action shape                                   |
| `src/lib/__tests__/edit-rerun.test.ts`       | New tests for SQL-edit branch                                                |
| `src/hooks/__tests__/use-page-state.test.ts` | Update tests for renamed action + new field                                  |

---

## Acceptance criteria

- [ ] SQL tab is editable in CodeMirror when the source is a warehouse
- [ ] Editing SQL surfaces a Re-run + Discard button toolbar (mirrors Python)
- [ ] Clicking Re-run on edited SQL closes the artifacts panel and rebuilds the full dashboard via the streaming pipeline
- [ ] Server logs show "SQL generation skipped (edited SQL provided)" when edited SQL is sent
- [ ] Type-check + lint stay clean
- [ ] All existing tests still pass; new SQL-edit tests pass
- [ ] Backwards compatibility: Python-only edit-rerun (existing) continues to work unchanged

---

## Out of scope

- Editing both SQL and Python in a single round-trip via UI (the data structure supports it; no UI for it in v1)
- SQL syntax validation client-side (rely on server-returned errors)
- SQL autocomplete / schema-aware completions (we have lang-sql syntax highlighting only)
- A different SQL dialect picker per warehouse — the editor uses generic SQL highlighting
