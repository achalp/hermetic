# State Persistence Architecture

## Pattern: Document + Patch Bus + Sink Adapters

Components are heterogeneous (map polygon editors, sliders, text inputs, custom widgets from third parties) but mutations need a uniform shape so they can flow to arbitrary backends.

Three layers:

### 1. Addressable State Tree

All mutable state lives in a single normalized tree, addressed by paths:

```
/polygon/geometry    -> GeoJSON
/polygon/meta/name   -> "Zone A"
/polygon/meta/color  -> "#ff0000"
/threshold           -> 42
```

Components don't own state — they read from and write to paths. This is what `spec.state` and `$bindState` already provide. Any component, from any source, can participate as long as it accepts a `(value, setValue)` contract bound to a path.

### 2. Mutation Bus

Components never call APIs. They emit **patches** — small, uniform mutation descriptors:

```ts
{ path: "/polygon/geometry", op: "replace", value: geojson }
{ path: "/polygon/meta/name", op: "replace", value: "Zone A" }
```

This is JSON Patch (RFC 6902). The bus provides:

- **Batching** — debounce rapid mutations (e.g., dragging a polygon vertex)
- **Ordering** — patches are sequential, no race conditions
- **Undo** — invert patches for free
- **Optimistic UI** — apply to local state immediately, reconcile later

### 3. Sink Adapters

A configuration layer maps path patterns to persistence targets:

```ts
sinks: [
  { match: "/zones/*/geometry", endpoint: "/api/zones/:id/geometry", method: "PUT", debounce: 500 },
  { match: "/zones/*/meta/**", endpoint: "/api/zones/:id", method: "PATCH" },
  { match: "/filters/**", local: true }, // no persistence, state only
];
```

Sinks are decoupled from components. A slider doesn't know if its value goes to an API, localStorage, or nowhere. You can add/remove sinks without touching components.

---

## Who Knows What

The LLM picks state paths from documented conventions. The developer (or a config file) registers what those paths mean in terms of persistence.

| Concern                                        | LLM                               | Developer               |
| ---------------------------------------------- | --------------------------------- | ----------------------- |
| Layout, which components, how they're arranged | Yes                               | No                      |
| State paths (`/draft/row/name`, `/sync/error`) | Yes — from documented conventions | Defines the conventions |
| Action names (`commitRow`, `selectRow`)        | Yes — from catalog                | Implements them         |
| API endpoints, HTTP methods, auth              | No                                | Yes                     |
| Error shape, dup-check logic                   | No                                | Yes                     |
| Which fields are required, validation rules    | Partially (from schema)           | Enforces                |

### Option A: LLM declares sinks in the spec

The catalog has a `SyncController` component with a `sinks` prop. The LLM sees the API schema in its context and wires it up. Works when the LLM already knows the API surface (e.g., user uploaded an OpenAPI spec). Risk: LLM hallucinates endpoints.

### Option B: Developer registers sinks, LLM just uses paths

The sink mapping lives outside the spec — in app config. The LLM's catalog description says "bind polygon state to `/zones/{id}/geometry`" and the runtime matches against registered sinks. The LLM never sees endpoints. **This is the better default.**

In practice you'd do both: Option B for known domain APIs, Option A as an escape hatch for dynamic integrations.

---

## End-to-End Flow: CSV Append

Input: a CSV file. Persistence: append a new row to the CSV.

### State Shape

```
/datasets/main:  [ {name:"Alice", lat:40.7, lng:-74}, ... ]
/draft/row:      { name:"", lat:null, lng:null }
/sync/status:    "idle"
/sync/error:     null
```

### LLM-Generated Spec

```jsonl
{"op":"add","path":"/elements/map","value":{
  "type":"MapView",
  "props":{"markers":{"$state":"/datasets/main"},"title":"Locations"}
}}
{"op":"add","path":"/elements/nameInput","value":{
  "type":"TextInput",
  "props":{"label":"Name","value":{"$bindState":"/draft/row/name"}}
}}
{"op":"add","path":"/elements/latInput","value":{
  "type":"NumberInput",
  "props":{"label":"Latitude","value":{"$bindState":"/draft/row/lat"}}
}}
{"op":"add","path":"/elements/addBtn","value":{
  "type":"Button",
  "props":{"label":"Add Location"},
  "on":{"click":{"action":"commitRow"}}
}}
```

### Mutation Flow

User types name, lat, lng. Each keystroke is a local state mutation:

```
patch: { path: "/draft/row/name", op: "replace", value: "Bob" }
patch: { path: "/draft/row/lat",  op: "replace", value: 41.2 }
patch: { path: "/draft/row/lng",  op: "replace", value: -73.8 }
```

These are local-only — no sink matches `/draft/**`, so nothing persists. Then user clicks "Add Location", triggering the `commitRow` action.

### Action Handler (Developer-Defined)

```ts
actions: {
  commitRow: async ({ state, mutate }) => {
    const row = state.get("/draft/row");

    // Optional dup check
    const existing = state.get("/datasets/main");
    if (existing.some(r => r.name === row.name)) {
      mutate("/sync/error", "Duplicate entry");
      return;
    }

    mutate("/sync/status", "saving");

    const res = await fetch("/api/csv/append", {
      method: "POST",
      body: JSON.stringify({ csv_id: "abc", row }),
    });

    if (!res.ok) {
      mutate("/sync/status", "error");
      mutate("/sync/error", await res.text());
      return;
    }

    // Success: append to local dataset, reset draft
    mutate("/datasets/main", [...existing, row]);
    mutate("/draft/row", { name: "", lat: null, lng: null });
    mutate("/sync/status", "idle");
    mutate("/sync/error", null);
  },
}
```

The map re-renders with the new marker. The form clears. One round-trip.

---

## End-to-End Flow: Upsert / Update

User clicks an existing marker to edit it. Two additions: a **selection** concept, and persistence becomes PUT instead of POST.

### Additional State

```
/selected/index:     2                                        <- which row is being edited
/draft/row:          { name:"Alice", lat:40.7, lng:-74.1 }   <- copy of row 2
/draft/dirty:        false                                    <- tracks if user changed anything
```

### Select Action

Clicking a marker triggers:

```ts
actions: {
  selectRow: ({ state, mutate, params }) => {
    const rows = state.get("/datasets/main");
    const idx = params.index;
    mutate("/selected/index", idx);
    mutate("/draft/row", { ...rows[idx] });
    mutate("/draft/dirty", false);
  },
}
```

### Dirty Tracking Middleware

Any mutation under `/draft/row/**` sets dirty:

```ts
bus.use("/draft/row/**", ({ mutate }) => {
  mutate("/draft/dirty", true);
});
```

### Commit Action (Insert vs Update)

```ts
actions: {
  commitRow: async ({ state, mutate }) => {
    const row = state.get("/draft/row");
    const idx = state.get("/selected/index");   // null = new, number = edit
    const existing = state.get("/datasets/main");

    mutate("/sync/status", "saving");

    if (idx != null) {
      // UPDATE — replace row in-place
      const res = await fetch("/api/csv/update", {
        method: "PUT",
        body: JSON.stringify({ csv_id: "abc", index: idx, row }),
      });
      if (!res.ok) { /* error path — see below */ return; }

      const updated = [...existing];
      updated[idx] = row;
      mutate("/datasets/main", updated);
    } else {
      // INSERT — append
      const res = await fetch("/api/csv/append", {
        method: "POST",
        body: JSON.stringify({ csv_id: "abc", row }),
      });
      if (!res.ok) { /* error path */ return; }

      mutate("/datasets/main", [...existing, row]);
    }

    // Reset
    mutate("/selected/index", null);
    mutate("/draft/row", { name: "", lat: null, lng: null });
    mutate("/draft/dirty", false);
    mutate("/sync/status", "idle");
  },
}
```

The LLM doesn't need to know this logic. It binds components to paths and puts `on.click: selectRow` on the map and `on.click: commitRow` on the save button. The action registry is developer-defined.

---

## Error Surfacing

Errors write to state. The UI reads state. No special error channel needed.

### Error State

```
/sync/status:        "error"
/sync/error:         "Row 3: duplicate value in 'name' column"
/sync/field_errors:  { "name": "Already exists" }
```

### LLM-Generated Error Display

```jsonl
{
  "op": "add",
  "path": "/elements/errorBanner",
  "value": {
    "type": "Annotation",
    "props": {
      "icon": "alert",
      "title": "Save failed",
      "content": {
        "$state": "/sync/error"
      },
      "severity": "error",
      "visible": {
        "$expr": "state('/sync/status') === 'error'"
      }
    }
  }
}
```

### Error Branch in Action Handler

```ts
if (!res.ok) {
  const body = await res.json();

  mutate("/sync/status", "error");
  mutate("/sync/error", body.message ?? "Failed to save");

  // Field-level errors (API returns { field_errors: { name: "..." } })
  if (body.field_errors) {
    mutate("/sync/field_errors", body.field_errors);
  }

  return; // don't clear the draft — user can fix and retry
}
```

### Field-Level Error Display

Individual inputs can show their specific error:

```jsonl
{
  "type": "TextInput",
  "props": {
    "label": "Name",
    "value": {
      "$bindState": "/draft/row/name"
    },
    "error": {
      "$state": "/sync/field_errors/name"
    }
  }
}
```

### Auto-Clear on Edit

When the user edits a field, clear its error:

```ts
bus.use("/draft/row/**", ({ mutate, path, state }) => {
  mutate("/draft/dirty", true);
  const field = path.split("/").pop();
  mutate(`/sync/field_errors/${field}`, null);
  if (state.get("/sync/status") === "error") {
    mutate("/sync/status", "idle");
    mutate("/sync/error", null);
  }
});
```

The user sees the error, fixes the field, the error clears, they retry. All through the same state tree.
