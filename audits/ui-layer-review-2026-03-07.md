# UI Layer Assessment — Principal Engineer Review

**Date:** 2026-03-07
**Reviewer:** PE-level automated audit
**Overall Grade:** B- (Solid functional code, but structural debt is accumulating)

---

## Critical Issues

### 1. Massive duplication between SheetPicker and WorkbookPreview

**Files:** `src/components/app/sheet-picker.tsx`, `src/components/app/workbook-preview.tsx`

~150 lines of identical code:

- `getColumnBadge()` function (verbatim copy)
- `relationshipMap`, `activeRelationships`, `sheetsWithRelationships` memos (verbatim)
- `MATCH_TYPE_LABELS` constant (duplicated)
- Entire table rendering JSX with PK/FK/link badges (verbatim)
- Relationship expandable panel (near-verbatim)

**Fix:** Extract `<SheetTable>` component and `useRelationshipAnnotations(relationships, activeSheet)` hook.

### 2. No shared component primitives

Every button, card, and badge is hand-styled with repeated class strings. ~30+ button instances across the app with slightly different but overlapping styling. No `<Button>`, `<Card>`, or `<Badge>` components exist.

**Fix:** Extract shared `Button`, `Card`, `Badge` primitives used across all components.

### 3. `page.tsx` is a god component

15 `useState` calls, 7 `useCallback` handlers, 1 `useEffect`. Related state transitions are spread across independent hooks (e.g., `setLoadedSpec(null)`, `setCurrentQuestion(question)`, `setQuestionSeq(s+1)`, `setIsAnalyzing(true)` always change together).

**Fix:** Consolidate with `useReducer` or extract domain-specific custom hooks.

### 4. Module-level mutable ref for cross-component communication

```typescript
// registry.tsx
export const drillDownCallbackRef: { current: ... | null } = { current: null };
```

ResponsePanel writes, registry components read. Breaks React data flow, untestable, fails with multiple instances.

**Fix:** Replace with React context provider.

---

## Significant Concerns

### 5. ResponsePanel has 4 responsibilities (550 lines)

Manages: stream lifecycle, drill-down navigation, save/export operations, artifacts fetching/display. 12+ state variables, 6+ useEffects.

**Fix:** Extract `useDrillDown()`, `useSaveExport()`, `useArtifacts()` hooks.

### 6. No React error boundaries

LLM-generated specs rendered via `<Renderer>` can crash the entire app if data is malformed. 40+ chart components with different data expectations, data from LLM-generated Python code.

**Fix:** Add error boundary around Renderer to catch and display graceful errors.

### 7. Tailwind + inline style mixing is verbose

Every component mixes Tailwind classes with `style={{}}` for CSS variables. With Tailwind v4, these can be defined as utilities.

**Fix:** Define Tailwind v4 `@utility` directives for common CSS variable patterns.

### 8. Registry file is 568 lines of inline component definitions

`StatCard`, `TextBlock`, `Annotation`, `TrendIndicator`, `SelectControl`, `NumberInput`, `ToggleSwitch` all defined inline. Should be separate files.

**Fix:** Extract inline registry components to individual files.

---

## Moderate Concerns

### 9. No API abstraction layer

Every component does raw `fetch()` with its own error handling. No shared error handling, no request deduplication.

**Fix:** Create thin `api.ts` module with typed methods.

### 10. Theme flash (FOUC) on load

`ThemeProvider` reads localStorage in `useEffect` — first render uses vanilla theme, then flashes to stored theme.

**Fix:** Add blocking `<script>` in `<head>` to set `data-theme` before first paint.

### 11. `eslint-disable react-hooks/exhaustive-deps` (2 instances)

Both in ResponsePanel. Signal that effects are doing too much or data flow is wrong.

**Fix:** Refactor effects to have correct dependency arrays (addressed by finding #5).

### 12. `dangerouslySetInnerHTML` in ArtifactsViewer

Used for Python syntax highlighting. Input is server-sourced, low XSS risk, but can be eliminated.

**Fix:** Return React elements from tokenizer instead of HTML strings.

### 13. Settings panel click-outside without Escape key

Manual `document.addEventListener("mousedown")`. No Escape key support. Should be reusable.

**Fix:** Extract `useClickOutside` hook with Escape key support.

---

## Strengths (no action needed)

- **Theming system**: 4 themes, full light/dark, comprehensive tokens, `:where()` catch-all
- **Accessibility basics**: ARIA roles, keyboard handlers, sr-only labels, skip-to-content
- **`useCSVUpload` hook**: Clean state machine pattern with atomic transitions
- **`useMemo` in SheetPicker**: Correct O(1) lookup optimization
- **Chart composition**: `ChartExpandWrapper` + `ChartSelectionBridge` pattern
