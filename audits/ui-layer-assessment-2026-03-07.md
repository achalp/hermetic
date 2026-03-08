# UI Layer Quality Assessment — Principal Engineer Review

**Date:** 2026-03-07
**Scope:** 31 files across components, hooks, lib, and CSS layers
**Baseline:** 134 tests passing, zero TS errors, clean production build

---

## Overall Grade: **B+**

Up from B- pre-audit. The refactoring work (hooks extraction, useReducer, shared primitives, Tailwind v4 tokens, registry decomposition) addressed real architectural debt. What remains are consistency gaps and hardening issues, not structural problems.

---

## Critical Findings

### C1. Raw `fetch()` calls bypass `api.ts` abstraction

**Files:** `page.tsx`, `csv-upload-panel.tsx`, `sheet-picker.tsx`, `settings-panel.tsx`, `saved-vizs-panel.tsx`, `use-save-export.ts`, `use-artifacts.ts`
**Count:** ~10 instances

`api.ts` provides structured error handling with `ApiError`, consistent headers, and a single place to add auth/retry logic. But most components call `fetch()` directly with ad-hoc error handling. This is the single highest-leverage fix remaining — it's a consistency issue that compounds as endpoints grow.

**Recommendation:** Route all API calls through `api.ts`. Add `apiPost`, `apiDelete` if needed.

### C2. No `AbortController` on async effects

**Files:** `use-save-export.ts`, `use-artifacts.ts`, `page.tsx`

Hooks fire async operations (fetch, export) without abort signals. If the component unmounts mid-flight, the resolved callback calls `setState` on an unmounted component. React 18+ doesn't crash on this, but it masks bugs and wastes resources.

**Recommendation:** Add `AbortController` in `useEffect` cleanup, pass `signal` to fetch calls.

### C3. No file-size validation on upload

**File:** `csv-upload-panel.tsx`

The UI says "Max 100MB" but never checks `file.size` before uploading. A 500MB file will POST in full before the server rejects it.

**Recommendation:** Add client-side `file.size` check before `FormData` upload.

---

## Significant Findings

### S1. Inline focus styling via `onFocus`/`onBlur` DOM manipulation

**Files:** `registry-primitives.tsx` (SelectControl, NumberInput, ToggleSwitch), `settings-panel.tsx`

```tsx
onFocus={(e) => (e.currentTarget.style.boxShadow = "var(--ring-focus)")}
onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
```

Imperative DOM mutation in a declarative framework. Bypasses Tailwind, doesn't compose with other styles, repeated 4+ times.

**Recommendation:** Use `focus-visible:shadow-[var(--ring-focus)]` utility. Remove all `onFocus`/`onBlur` handlers.

### S2. `any` types on all registry primitive props

**File:** `registry-primitives.tsx`

Every exported component uses `{ props: any }`. The catalog already defines prop shapes — these should flow through as types.

**Recommendation:** Define interfaces per component or derive from catalog types.

### S3. Accessibility gaps

**Files:** Multiple

- Buttons with only icons (collapse toggles, export buttons) lack `aria-label`
- `DataTable` headers missing `scope="col"`
- Streaming response area has no `aria-live="polite"` region
- Collapse toggles missing `aria-expanded`

**Recommendation:** Audit each interactive element. The `ActionButton` primitive is the right place to enforce label requirements.

### S4. `setTimeout` without cleanup

**Files:** `page.tsx`, `response-panel.tsx`, `use-save-export.ts`

Several `setTimeout` calls for transient UI states (save confirmation, flash messages) don't clear on unmount.

**Recommendation:** Wrap in `useEffect` with `clearTimeout` in cleanup, or use a `useTimeout` hook.

---

## Moderate Findings

### M1. Repeated collapsed-section pattern

**Files:** `response-panel.tsx`, `settings-panel.tsx`, `saved-vizs-panel.tsx`

Three components independently implement collapsible sections with local `useState`, toggle handlers, and chevron rotation. Candidate for a shared `<CollapsibleSection>` component.

### M2. Theme config coupling

**File:** `registry-primitives.tsx`

`useThemeConfig()` is called inside StatCard, TextBlock, and Annotation — reading deeply nested config values. A thin adapter (e.g., `useStatCardTheme()`) would isolate this.

### M3. CSS variable / Tailwind hybrid in Card

**File:** `card.tsx`

Card uses Tailwind classes (`rounded-card`, `shadow-card`, `p-card`) but keeps `background: "var(--bg-panel)"` as an inline style. Last inline style holdout from the Tailwind migration.

**Recommendation:** Register `--bg-panel` in the `@theme` block or use `bg-[var(--bg-panel)]`.

### M4. Test coverage gaps

- No render tests for registry-primitives (only pure function tests)
- No integration test for the full registry render path
- Hooks tests mock everything — no test exercises actual fetch to state flow

---

## What's Done Well

| Area                    | Assessment                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `api.ts`                | Textbook abstraction — typed errors, consistent interface, single responsibility |
| `use-page-state.ts`     | Clean reducer, pure functions, excellent test coverage (10 tests)                |
| `syntax-highlight.ts`   | Pure function tokenizer, zero dependencies, correct edge cases                   |
| `use-click-outside.ts`  | Perfect cleanup pattern, correct ref handling                                    |
| `theme-context.tsx`     | Proper SSR guards, `useLayoutEffect` where needed                                |
| `types.ts`              | Discriminated unions, no `any` leakage                                           |
| `ActionButton` / `Card` | Good primitive extraction, `forwardRef` on Card, className merging               |
| Design token system     | `@theme` block with semantic tokens is the right Tailwind v4 approach            |
| Registry decomposition  | 565 to 310 lines, clean delegation, testable formatters extracted                |

---

## Path to A-

1. Route all fetch through `api.ts` (C1)
2. AbortController on all async hooks (C2)
3. File-size validation on upload (C3)
4. Replace inline focus handlers with Tailwind (S1)
5. Type the registry primitive props (S2)
6. Add `aria-label` to icon-only buttons (S3)
7. setTimeout cleanup (S4)
8. Extract CollapsibleSection (M1)
9. Theme config adapters (M2)
10. Card inline style elimination (M3)
11. Render tests for registry primitives (M4)
