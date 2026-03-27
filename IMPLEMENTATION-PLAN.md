# Hermetic UI Redesign — Implementation Plan

> Reference: `DESIGN-SPEC.md` · Prototype: `~/Downloads/hermetic-prototypes/v6-focus.html`
> Codebase audit completed 2026-03-24. All line counts and exports verified.

---

## Guiding Rules

1. **One concern per commit.** Each commit touches one logical change. If a commit message needs "and", split it.
2. **Never break the build.** Every commit must pass `tsc --noEmit` and `npm run build`.
3. **Preserve existing behavior first.** Refactor structure before changing behavior. Move code before rewriting it.
4. **CSS variables are law.** No hardcoded colors, radii, or font-weights in component code. Everything through `var()`.
5. **Accessibility is not a phase.** ARIA attributes, keyboard nav, and focus management ship with each component, not as a later pass.

---

## Phase 0: Foundation — CSS Variable System & Z-Index Stack

_Establish the design token contract before touching any components._

### Commit 0.1: Define z-index scale in globals.css

**Files**: `src/app/globals.css`
**What**: Add a z-index scale as CSS custom properties in `:root`:

```css
--z-base: 1;
--z-rail: 180;
--z-topbar: 250;
--z-drawer-overlay: 200;
--z-drawer: 210;
--z-artifacts-overlay: 300;
--z-artifacts: 310;
--z-export-dropdown: 260;
```

**Why**: The current codebase uses only `z-50` with no system. The redesign has 7 z-index layers that must be precisely ordered for mutual exclusion to work.
**Verify**: `npm run build` passes. No visual changes.

### Commit 0.2: Add dark surface tokens to each theme

**Files**: `src/app/globals.css`
**What**: Add `--color-surface-dark`, `--color-surface-dark-2`, `--color-surface-dark-3`, `--color-surface-dark-text`, `--color-surface-dark-text2`, `--color-surface-dark-text3`, `--color-surface-dark-text4` to each theme's `@theme` block (vanilla, stamen, iib, pentagram). These are for drawers, rails, and panels that always render on dark surfaces regardless of light/dark mode.
**Values**:

- Vanilla: `#1e293b`, `#334155`, `#475569`, `#f1f5f9`, `#cbd5e1`, `#94a3b8`, `#64748b`
- Stamen: `#1c1917`, `#292524`, `#44403c`, `#fafaf9`, `#d6d3d1`, `#a8a29e`, `#78716c`
- IIB: `#1a1a2e`, `#2d2d4a`, `#45456a`, `#f0f0ff`, `#c8c8e0`, `#9b9bb5`, `#6b6b8a`
- Pentagram: `#111111`, `#222222`, `#444444`, `#ffffff`, `#cccccc`, `#999999`, `#666666`
  **Why**: Drawers and rails use dark surfaces. Currently no tokens exist for this.
  **Verify**: Build passes. No visual changes.

### Commit 0.3: Add hero, insight, and chart-bar-radius tokens

**Files**: `src/app/globals.css`
**What**: Add to `:root` and each theme:

- `--hero-bg` (accent-light tinted background for the hero stat row)
- `--insight-bg`, `--insight-text` (already partially exist — normalize across themes)
- `--chart-bar-radius` (per theme: vanilla `6px 6px 2px 2px`, stamen `0`, iib `8px 8px 2px 2px`, pentagram `0`)
  **Why**: Results page needs these. Chart bar radius varies by theme (round vs sharp).
  **Verify**: Build passes. Existing charts still render (no component changes yet).

### Commit 0.4: Add explicit light/dark/system mode support

**Files**: `src/lib/theme-context.tsx`, `src/app/globals.css`, `src/app/layout.tsx`
**What**:

1. In `theme-context.tsx`: add `mode` state (`"light" | "dark" | "system"`), `setMode` function, and `useMode` hook. Store in localStorage under `"gud-mode"`. Apply `data-mode="dark"` attribute on `<html>` when dark, remove when light, follow `prefers-color-scheme` when system. Listen for `matchMedia` changes.
2. In `globals.css`: add `[data-mode="dark"]` overrides that flip surface colors (`--bg`, `--card`, `--border`, `--text`, `--text2`) while preserving accent. This works alongside `data-theme` — both attributes coexist.
3. In `layout.tsx`: extend the inline FOUC-prevention script to also restore `data-mode` from localStorage.
   **Why**: Currently dark mode is only via `prefers-color-scheme` media queries. The design spec requires an explicit light/dark/system toggle.
   **Verify**: Build passes. Adding `data-mode="dark"` to `<html>` in DevTools flips surfaces to dark.

---

## Phase 1: Layout Shell — Top Bar, Main Content Wrapper

_Build the persistent chrome before rearranging content._

### Commit 1.1: Create TopBar component

**Files**: NEW `src/components/app/top-bar.tsx`
**What**: Extract a `TopBar` component with:

- Props: `logo: boolean`, `center?: ReactNode`, `right?: ReactNode`
- 56px height, fixed top, full width
- Uses `var(--card)` bg, `var(--border)` bottom border
- `z-index: var(--z-topbar)` (250)
- Logo: "hermetic" in `var(--accent)`, 16px, weight 700, lowercase
- Center: `position: absolute; left: 50%; transform: translateX(-50%)`
- Right: flex row with `gap: 12px`
- Gear icon button (SVG, 20px, `var(--text2)`, hover → `var(--text)`)
  **Why**: The persistent top bar is the backbone of the new layout. It doesn't exist yet — the current header is inline in `page.tsx`.
  **Verify**: Component renders in isolation. Build passes.

### Commit 1.2: Create SourcePill component

**Files**: NEW `src/components/app/source-pill.tsx`
**What**: Small pill showing "✓ {filename} · {rows} rows" with `var(--accent-light)` bg and `var(--accent)` text. Props: `label: string`. Uses `var(--radius-badge)`.
**Why**: Reused in top bar center across States 2, 3, and 4.
**Verify**: Build passes.

### Commit 1.3: Create main content wrapper with blur support

**Files**: NEW `src/components/app/main-content.tsx`
**What**: A wrapper `<div>` for main content with:

- `padding-top: 56px` (below top bar)
- `max-width: 1000px; margin: 0 auto; padding: 0 40px`
- CSS class `blurred` toggleable via prop: `filter: blur(6px); opacity: 0.6; pointer-events: none; transition: filter 0.3s ease, opacity 0.3s ease`
- `margin-right` adjustable via prop (for data rail)
- Props: `blurred?: boolean`, `railVisible?: boolean`, `children`
  **Why**: Bokeh blur effect is reused by data rail, settings drawer, and artifacts panel. Centralizing it prevents duplication.
  **Verify**: Build passes.

### Commit 1.4: Wire TopBar into page.tsx (non-breaking)

**Files**: `src/app/page.tsx`
**What**: Import and render `TopBar` at the top of the page. Keep all existing content below. Don't remove the old header yet — just add the new one. Conditionally render the old header if a feature flag is off (or just comment it out). The TopBar shows "hermetic" logo + gear icon that opens settings (keep existing `openRef` wiring).
**Why**: Incremental migration. The top bar is visible immediately. Old layout still works.
**Verify**: Build passes. Top bar renders. Gear icon opens existing settings panel.

---

## Phase 2: Settings Drawer

_Replace the dropdown settings panel with a right-side drawer._

### Commit 2.1: Create Drawer shell component

**Files**: NEW `src/components/app/drawer.tsx`
**What**: Generic reusable drawer with:

- Props: `open: boolean`, `onClose: () => void`, `title: string`, `width?: number`, `children`
- Fixed right, full height, dark surface (`var(--surface-dark)`)
- Slides in/out with `transform: translateX` + `0.3s ease`
- Overlay behind: `position: fixed; inset: 0; background: rgba(0,0,0,0.15); z-index: var(--z-drawer-overlay)`
- Drawer itself: `z-index: var(--z-drawer)`
- Header with title + close button (×)
- Body: overflow-y auto, flex-1
- Click overlay → onClose
- `Escape` key → onClose
- `aria-modal="true"`, `role="dialog"`, focus trap (first focusable element on open)
  **Why**: Both settings drawer and (in the future) any other drawer share this shell. DRY.
  **Verify**: Build passes. Drawer renders when triggered.

### Commit 2.2: Create CollapsibleSection component

**Files**: NEW `src/components/app/collapsible-section.tsx`
**What**: Reusable collapsible section for drawer/rail:

- Props: `title: string`, `defaultOpen?: boolean`, `children`
- 11px uppercase letter-spaced header with chevron toggle
- `max-height` transition for smooth open/close
- Dark-surface-aware (text uses `var(--surface-dark-text4)` for header)
- `aria-expanded` on trigger, `id`/`aria-labelledby` pairing
  **Why**: Used in settings drawer (4 sections), data rail (3-5 sections). Must be consistent.
  **Verify**: Build passes. Section toggles smoothly.

### Commit 2.3: Create AppearanceSection for settings drawer

**Files**: NEW `src/components/app/settings/appearance-section.tsx`
**What**: The "Appearance" section containing:

- **Mode toggle**: 3-segment button (☀ Light · ◐ System · ☾ Dark). Uses `useMode()` from theme-context.
- **Theme swatches**: Rendered from `THEMES` array. Each swatch: 40×40 colored square with the theme's accent color and border-radius. Active swatch has accent-colored border. Below: 10px label.
- Uses `useTheme()` and `useMode()` hooks
- Swatches rendered dynamically — extensible by adding to the THEMES array
  **Why**: Extracted as its own component because it's self-contained and has its own state interactions.
  **Verify**: Build passes. Switching themes and modes works.

### Commit 2.4: Create ConnectedSourcesSection for settings drawer

**Files**: NEW `src/components/app/settings/connected-sources-section.tsx`
**What**: Extract warehouse connection management from `warehouse-connect-panel.tsx` (lines 77-178 of current file). Shows:

- Current connection card (green dot + label + Disconnect button) if connected
- "Add connection" button → inline form with DB type selector + fields
- Saved connections list with delete button
- All styled for dark surface (dark inputs, light text)
- Props: receive warehouse hook state/actions
  **Why**: The 944-line warehouse-connect-panel does too much. This extracts just the connection management for the settings drawer.
  **Verify**: Build passes. Connecting/disconnecting works from the drawer.

### Commit 2.5: Create ModelsSection for settings drawer

**Files**: NEW `src/components/app/settings/models-section.tsx`
**What**: Extract model selection from current `settings-panel.tsx`. Two rows: Code Generation + UI Composition, each with a `<select>` dropdown. Dark-surface styled.
**Why**: Clean separation. Small, testable component.
**Verify**: Build passes.

### Commit 2.6: Create AnalysisDefaultsSection for settings drawer

**Files**: NEW `src/components/app/settings/analysis-defaults-section.tsx`
**What**: Extract default style pills and schema mode toggle from current `settings-panel.tsx`. Dark-surface styled pills and toggle.
**Why**: Clean separation.
**Verify**: Build passes.

### Commit 2.7: Assemble SettingsDrawer component

**Files**: NEW `src/components/app/settings-drawer.tsx`
**What**: Compose `Drawer` + `CollapsibleSection` + the 4 section components + an "About" footer. Props: all the settings state and callbacks currently on `SettingsPanelProps` + theme/mode hooks.
**Why**: The complete settings drawer, ready to replace the dropdown panel.
**Verify**: Build passes. All sections render and function.

### Commit 2.8: Wire SettingsDrawer into page.tsx, remove old settings panel

**Files**: `src/app/page.tsx`, `src/components/app/settings-panel.tsx` (mark deprecated)
**What**: Replace `SettingsPanel` usage with `SettingsDrawer`. State management: add `settingsOpen` boolean to page state. Gear icon toggles it. Drawer open → `MainContent` blurs. Close → unblurs. Remove the old dropdown settings panel import. Don't delete the file yet (may still be referenced elsewhere).
**Why**: The settings now live in a proper drawer. The old dropdown is gone.
**Verify**: Build passes. Settings open as a right-side drawer. All settings function identically. Blur effect works.

---

## Phase 3: Data Rail

_Build the collapsible data explorer rail._

### Commit 3.1: Create DataRail component shell

**Files**: NEW `src/components/app/data-rail.tsx`
**What**: The rail structure:

- Props: `visible: boolean`, `expanded: boolean`, `fullscreen: boolean`, `onExpand`, `onCollapse`, `onToggleFullscreen`, `children`
- Fixed right, below top bar, full height
- Collapsed: 48px wide, 3 icon buttons (schema/profile/sample SVGs) + expand arrow
- Expanded: 380px, hides icon strip, shows children
- Fullscreen: 100vw, hides icon strip
- Width transitions (`0.3s ease`)
- `z-index: var(--z-rail)` (180)
- Dark surface (`var(--surface-dark)`)
- Header (when expanded): "Data Explorer" + fullscreen toggle + collapse button
  **Why**: The structural shell, independent of content. Content is injected via children.
  **Verify**: Build passes. Rail expands/collapses with smooth transition.

### Commit 3.2: Create SchemaSection component

**Files**: NEW `src/components/app/data-explorer/schema-section.tsx`
**What**: Compact column table for the data rail:

- Props: `columns: {name: string, type: string, sample: string}[]`, `moreCount?: number`
- Table: Column | Type | Sample headers (12px uppercase)
- Type badges: colored pills — `text`=gray, `number`=blue `#60a5fa`, `date`=amber `#fbbf24`
- Show up to 8 rows, then "+N more" link
- Dark-surface aware (light text on dark bg)
- Wrapped in `CollapsibleSection` with `defaultOpen={true}`
  **Why**: Replaces `schema-preview.tsx` inside the rail. More compact, dark-themed.
  **Verify**: Build passes.

### Commit 3.3: Create ProfileSection component

**Files**: NEW `src/components/app/data-explorer/profile-section.tsx`
**What**: Quick stats + distribution bars:

- Props: `chips: string[]`, `distributions: {name: string, percent: number, range: string}[]`
- Chips as inline pills (12px, dark pill style)
- Distribution bars: column name + thin bar (accent fill on dark-2 bg, width = percent%) + range text. All inline, one line per distribution.
- Wrapped in `CollapsibleSection` with `defaultOpen={true}`
  **Why**: Visual data profiling in minimal space.
  **Verify**: Build passes.

### Commit 3.4: Create SampleSection component

**Files**: NEW `src/components/app/data-explorer/sample-section.tsx`
**What**: Mini data table:

- Props: `columns: string[]`, `rows: string[][]`
- 12px font, dark-themed table, show 3 rows, 5 columns max
- Wrapped in `CollapsibleSection` with `defaultOpen={false}`
  **Why**: Peek at actual data, collapsed by default.
  **Verify**: Build passes.

### Commit 3.5: Create SheetTabs component for Excel workbooks

**Files**: NEW `src/components/app/data-explorer/sheet-tabs.tsx`
**What**: Vertical tab list for Excel sheets:

- Props: `sheets: {name: string, rows: number}[]`, `active: string`, `onSelect: (name: string) => void`, `relationships?: {from: string, to: string}[]`
- Each tab: name + row count. Active: accent left border + lighter bg.
- Below tabs: "RELATIONSHIPS" section with "A.col → B.col" lines
  **Why**: Excel workbook navigation in the rail.
  **Verify**: Build passes.

### Commit 3.6: Create TableList component for warehouses

**Files**: NEW `src/components/app/data-explorer/table-list.tsx`
**What**: Vertical list of warehouse tables:

- Props: `tables: {name: string, rows: string}[]`, `active: string`, `onSelect: (name: string) => void`
- Same style as sheet tabs but without relationships section
  **Why**: Warehouse table navigation in the rail.
  **Verify**: Build passes.

### Commit 3.7: Assemble DataRailContent component

**Files**: NEW `src/components/app/data-rail-content.tsx`
**What**: Composes rail content based on data source type:

- Props: receives CSV schema, Excel sheets/relationships, or warehouse tables. Plus current selection state.
- For CSV: source pill + SchemaSection + ProfileSection + SampleSection
- For Excel: source pill + SheetTabs + SchemaSection + ProfileSection + SampleSection (switching per sheet)
- For Warehouse: source pill + TableList + SchemaSection + ProfileSection + SampleSection (switching per table)
- Derives schema/profile/sample data from the active sheet/table selection
  **Why**: Orchestrates the rail content switching logic.
  **Verify**: Build passes.

### Commit 3.8: Wire DataRail into page.tsx

**Files**: `src/app/page.tsx`
**What**: Add `railExpanded` and `railFullscreen` state. Render `DataRail` with `DataRailContent` when data is loaded (States 2-4). Wire expand/collapse/fullscreen callbacks. Wire mutual exclusion: expanding rail closes settings, opening settings collapses rail. `MainContent` gets `railVisible` prop (adds margin-right), `blurred` prop when rail is expanded or settings is open.
**Why**: The data rail is now live.
**Verify**: Build passes. Rail shows after data load. Expand/collapse/fullscreen work. Blur effect on main content. Mutual exclusion with settings.

---

## Phase 4: State 1 Redesign — Source Cards + Saved Connections

_Replace the upload panel + warehouse toggle with sibling cards._

### Commit 4.1: Create SourceCards component

**Files**: NEW `src/components/app/source-cards.tsx`
**What**: Two sibling cards in a 2-column grid:

- Left: "Upload a file" — dashed border, upload icon, "CSV · Excel · JSON · GeoJSON". Accepts drag-drop and click-to-browse. Reuses file handling logic from `csv-upload-panel.tsx`.
- Right: "Connect a warehouse" — solid border, database icon, "PostgreSQL · BigQuery · ClickHouse · Trino". Click reveals inline connection form.
- Both: `var(--card)` bg, `var(--border)` border, `var(--radius-card)` radius, 40px 32px padding. Hover → accent border + accent-light bg.
- Props: `onFileUpload`, `onWarehouseConnect`, `onShowForm`
  **Why**: Replaces the tab toggle + CSVUploadPanel + WarehouseConnectPanel on the landing page.
  **Verify**: Build passes.

### Commit 4.2: Create SavedConnections component

**Files**: NEW `src/components/app/saved-connections.tsx`
**What**: Row of one-click pill buttons for saved warehouse connections:

- Props: `connections: SavedConnectionInfo[]`, `onConnect: (id: string) => void`
- Each pill: colored dot (by DB type) + emoji + name + host
- Click → `onConnect(id)` — no form, straight to State 2
- Label "Saved connections" in 12px uppercase, `var(--text3)`
- Hidden if `connections.length === 0`
  **Why**: One-click warehouse reconnect. Appears in State 1.
  **Verify**: Build passes.

### Commit 4.3: Create InlineConnectionForm component

**Files**: NEW `src/components/app/inline-connection-form.tsx`
**What**: Extract from warehouse-connect-panel: DB type selector (4 buttons) + 3 fields + Connect button. Light-themed (for State 1 surface). Slides in with height animation.

- Props: `onConnect: (config: WarehouseConnectionConfig) => void`, `visible: boolean`
  **Why**: Used in State 1 below the source cards. Separate from the settings drawer version (which is dark-themed).
  **Verify**: Build passes.

### Commit 4.4: Rewrite State 1 in page.tsx

**Files**: `src/app/page.tsx`
**What**: Replace the current data source mode toggle + CSVUploadPanel + WarehouseConnectPanel with:

1. Hero text: "What's hiding in your data?"
2. `SourceCards`
3. `SavedConnections` (from `useWarehouse().savedConnections`)
4. `InlineConnectionForm`
5. Sealed badge: "🔒 Sealed. Your data stays local."
   Remove the `[Upload File] [Connect Warehouse]` tab toggle. Remove `CSVUploadPanel` and `WarehouseConnectPanel` imports from the landing state.
   **Why**: State 1 now matches the design spec.
   **Verify**: Build passes. File upload works. Warehouse connection works. Saved connections work.

---

## Phase 5: State 2 Redesign — Ask Screen

_Reorder and restyle the question flow._

### Commit 5.1: Create ProfileStrip component

**Files**: NEW `src/components/app/profile-strip.tsx`
**What**: Single-line horizontal stat strip:

- Props: `items: string[]` (e.g., `["12,847 rows", "23 columns", "Jan '23 – Dec '25", ...]`)
- Renders items separated by `|` dividers
- 13px, `var(--text2)`, centered, flex-wrap
  **Why**: Compact data summary for State 2. Replaces the multi-line schema preview.
  **Verify**: Build passes.

### Commit 5.2: Create StyleSelector component

**Files**: NEW `src/components/app/style-selector.tsx`
**What**: Dot-separated text links:

- Props: `selected: string`, `onSelect: (id: string) => void`
- Items: Dashboard · Narrative · Summary · Deep dive · Slides · Report
- Maps display labels to purpose IDs: Dashboard→infographic, Narrative→narrative, etc.
- Active: `var(--accent)` + underline (2px, `text-underline-offset: 3px`). Others: `var(--text2)`.
- 13px, centered
- `role="radiogroup"`, each item `role="radio"` + `aria-checked`
  **Why**: Replaces the purpose pill buttons. More minimal, text-link style.
  **Verify**: Build passes.

### Commit 5.3: Create QuestionInput component (redesigned)

**Files**: `src/components/app/query-input.tsx` (rewrite)
**What**: Redesigned input:

- 52px height, 18px font, `var(--radius-input)` radius
- Placeholder: "Ask anything..."
- Circular submit button (40px, `var(--accent)`, white arrow SVG) positioned inside the input's right edge (`position: absolute; right: 6px; top: 50%; transform: translateY(-50%)`)
- Focus: `var(--accent)` border with `transition: border-color 0.15s`
- Remove the separate "Ask" button
- Keep the existing `onSubmit`, `disabled`, `isLoading` props
- Add `suggestions?: string[]` prop — renders pill buttons below the input
- Add `onSuggestionClick` that fills the input and submits
  **Why**: Larger, cleaner input with inline submit. Suggestions are part of the same component.
  **Verify**: Build passes. Typing + Enter submits. Clicking suggestion fills and submits. Loading state shows.

### Commit 5.4: Rewrite State 2 in page.tsx

**Files**: `src/app/page.tsx`
**What**: Replace current State 2 content with (in this order):

1. `ProfileStrip` — from CSV schema or warehouse tables
2. `StyleSelector` — wired to purpose state
3. `QuestionInput` — with suggestion pills
   Remove `SchemaPreview` and `WorkbookPreview` from the main flow (they live in the data rail now). Center content vertically with `max-width: 700px`.
   **Why**: State 2 now matches the design spec. Data source → Output format → Question → Ask.
   **Verify**: Build passes. The ask flow works end-to-end. Data rail shows schema details.

---

## Phase 6: State 3 & 4 Redesign — Working + Results

_Restyle the loading and results states._

### Commit 6.1: Create WorkingIndicator component

**Files**: NEW `src/components/app/working-indicator.tsx`
**What**: Three pulsing dots + status text:

- Dots: 8px circles, `var(--accent)`, `pulse` animation (1.2s ease-in-out infinite, staggered 0.2s)
- Status text: 14px, `var(--text2)`
- Centered vertically in viewport
- Props: `status: string` (the parent controls the text)
  **Why**: Cleaner replacement for the current pipeline progress stepper.
  **Verify**: Build passes. Dots animate.

### Commit 6.2: Create HeroRow component

**Files**: NEW `src/components/app/results/hero-row.tsx`
**What**: Full-width stat row:

- Props: `value: string`, `label: string`, `trend?: string`, `sparkData?: number[]`
- Left (60%): large number (56px, `var(--font-heading-weight)`, `var(--accent)`) + label
- Right (40%): sparkline (8 thin bars from sparkData) + trend text
- Background: `var(--hero-bg)`, border-radius `var(--radius-card)`, 32px padding
- Animated counter: number counts up from 0 on mount using `requestAnimationFrame`
  **Why**: The hero stat with sparkline. New component, doesn't exist in current codebase.
  **Verify**: Build passes. Counter animates.

### Commit 6.3: Create ChartCard wrapper with per-chart export

**Files**: NEW `src/components/app/results/chart-card.tsx`
**What**: Card wrapper for any chart:

- Props: `title: string`, `onExport?: () => void`, `children`
- White card, border, radius
- Header row: title left, export button right (appears on hover, "↓ PNG")
- Export button: 11px, border, `opacity 0→1` on card `:hover`
- Children render the actual chart component below the header
  **Why**: Per-chart export is a new feature. Every chart in results gets this wrapper.
  **Verify**: Build passes.

### Commit 6.4: Create ResultsLayout component

**Files**: NEW `src/components/app/results/results-layout.tsx`
**What**: Two-column grid layout for results:

- Props: `question: string`, `children` (the actual rendered dashboard)
- `grid-template-columns: 3fr 2fr`, gap 20px
- Staggered fade-up animations on children (using CSS animation with `animation-delay`)
- Follow-up section at bottom with pill buttons
  **Why**: Wraps the existing Renderer output in the new two-column layout.
  **Verify**: Build passes.

### Commit 6.5: Create ArtifactsPanel component (bottom sheet)

**Files**: NEW `src/components/app/artifacts-panel.tsx`, refactor from `src/components/app/artifacts-viewer.tsx`
**What**: Reposition artifacts as a bottom sheet:

- Props: `open: boolean`, `fullscreen: boolean`, `onClose`, `onToggleFullscreen`, `artifacts: CachedArtifacts`
- Fixed bottom, full width, 55vh default height
- Fullscreen: `calc(100vh - 56px)`, `border-radius: 0`
- Dark surface, overlay behind
- Tabs: SQL | Python | Data (reuse existing tab content from `artifacts-viewer.tsx`)
- Fullscreen toggle button in header
- `z-index: var(--z-artifacts)` / `var(--z-artifacts-overlay)`
- Slide-up transition (`transform: translateY`)
  **Why**: Artifacts move from an inline viewer to a bottom sheet with fullscreen.
  **Verify**: Build passes. All three tabs render correctly. Fullscreen toggle works.

### Commit 6.6: Wire top bar actions for State 4

**Files**: `src/app/page.tsx`, `src/components/app/top-bar.tsx`
**What**: When in State 4, top bar right shows: [Save] [Export ▾] [</>] [gear]

- Save: uses existing `useSaveExport().handleSave`, shows ✓ briefly
- Export ▾: dropdown with PDF, DOCX, PPTX, PNG. Uses existing export handlers.
- </>: toggles artifacts panel
- Export dropdown: `z-index: var(--z-export-dropdown)`, positioned below button, closes on outside click
  **Why**: Actions move from inline buttons to the persistent top bar.
  **Verify**: Build passes. All actions work from top bar.

### Commit 6.7: Wire State 3 and State 4 in page.tsx

**Files**: `src/app/page.tsx`
**What**: Replace current response-panel rendering with:

- State 3: `WorkingIndicator` centered, status text driven by pipeline progress
- State 4: `HeroRow` + two-column grid + follow-up pills. The existing `Renderer` still renders the dashboard inside the new layout wrapper.
- Artifacts panel open state + mutual exclusion with rail/settings
- Follow-up pill clicks → new query (loop to State 3)
  **Why**: States 3 and 4 now match the design spec.
  **Verify**: Build passes. Full flow works: drop → ask → working → results → follow-up.

---

## Phase 7: Cleanup & Polish

### Commit 7.1: Remove deprecated components

**Files**: Delete or mark as deprecated:

- `src/components/app/settings-panel.tsx` (replaced by settings-drawer)
- Old header code in `page.tsx` (replaced by TopBar)
- Unused CSS classes in `globals.css`
  **Why**: Dead code removal.
  **Verify**: Build passes. No runtime errors.

### Commit 7.2: Responsive breakpoints

**Files**: `src/app/globals.css`, various components
**What**:

- `< 768px`: source cards stack (1 column). Results grid stacks. Data rail hides collapsed icons, only expands as full overlay. Top bar actions collapse.
- `768–1024px`: tighter padding, narrower rail.
- `> 1024px`: full layout as spec'd.
  **Why**: Mobile and tablet support.
  **Verify**: Build passes. Resize browser through breakpoints — layout adapts gracefully.

### Commit 7.3: Keyboard navigation audit

**Files**: All new components
**What**: Verify and fix:

- Tab order through all interactive elements
- Enter/Space activates buttons and links
- Escape closes drawers/panels
- Focus trap in open drawers
- Focus-visible outlines using `var(--accent)`
- Arrow keys in style selector and theme swatches
  **Why**: Accessibility compliance.
  **Verify**: Navigate entire flow using only keyboard.

### Commit 7.4: Animation polish

**Files**: Various components
**What**: Fine-tune all transitions:

- Bar chart bars: `height 0→final%`, `0.8s ease`, staggered `60ms`
- Hero counter: `0.9s` cubic ease-out
- State transitions: `opacity + translateY`, `0.5s ease`, `100ms` stagger
- Drawer/panel: `0.3s ease` transforms
- Ensure `prefers-reduced-motion: reduce` disables all animations
  **Why**: Polish and accessibility.
  **Verify**: Animations are smooth. Reduced-motion users see no animation.

### Commit 7.5: Final integration test

**Files**: None (testing only)
**What**: Verify complete flow:

1. Land on State 1 → two source cards visible, saved connections visible
2. Drop CSV → State 2 with profile strip, style selector, question input, suggestions
3. Click data rail → schema, profile, sample visible. Fullscreen toggle works.
4. Open settings → drawer opens, rail collapses, blur on main. Switch theme. Switch mode.
5. Ask question → State 3 dots + status
6. Results → hero row with animated counter, chart, stats, insight, follow-ups
7. Click chart export → PNG download
8. Click Export ▾ → PDF/DOCX/PPTX/PNG dropdown
9. Click </> → artifacts panel slides up. Switch tabs. Fullscreen.
10. Click follow-up → loops to State 3 → new results
11. Click Save → ✓ confirmation
12. Switch themes (all 4) → entire UI transforms
13. Switch light/dark/system → surfaces flip
14. Test Excel workbook → sheets in data rail, relationships shown
15. Test warehouse → tables in data rail, schema per table
    **Verify**: All 15 scenarios pass. `npm run build` clean.

---

## Dependency Graph

```
Phase 0 (tokens) ─┬─► Phase 1 (shell) ─► Phase 2 (settings drawer)
                   │                    ─► Phase 3 (data rail)
                   │                    ─► Phase 4 (State 1)
                   │                    ─► Phase 5 (State 2)
                   │                    ─► Phase 6 (States 3+4)
                   │
                   └─► Phase 7 (cleanup) ◄── all phases complete
```

Phases 2–6 can be parallelized after Phase 1 is complete, but committing sequentially is recommended for clean git history and easier rollback.

---

## New Files Summary

```
src/components/app/
  top-bar.tsx                              # Persistent top bar
  source-pill.tsx                          # "✓ file.csv · N rows" pill
  main-content.tsx                         # Content wrapper with blur
  drawer.tsx                               # Generic slide-out drawer shell
  collapsible-section.tsx                  # Collapsible section for drawers/rail
  settings-drawer.tsx                      # Assembled settings drawer
  settings/
    appearance-section.tsx                 # Theme + mode controls
    connected-sources-section.tsx          # Warehouse management
    models-section.tsx                     # Model dropdowns
    analysis-defaults-section.tsx          # Style + schema defaults
  data-rail.tsx                            # Collapsible rail shell
  data-rail-content.tsx                    # Rail content orchestrator
  data-explorer/
    schema-section.tsx                     # Column table with type badges
    profile-section.tsx                    # Stat chips + distribution bars
    sample-section.tsx                     # Mini data table
    sheet-tabs.tsx                         # Excel sheet navigation
    table-list.tsx                         # Warehouse table navigation
  source-cards.tsx                         # File + warehouse sibling cards
  saved-connections.tsx                    # One-click saved connection pills
  inline-connection-form.tsx              # Light-themed warehouse form
  profile-strip.tsx                        # Single-line data summary
  style-selector.tsx                       # Purpose mode text links
  working-indicator.tsx                    # Pulsing dots + status
  artifacts-panel.tsx                      # Bottom-sheet artifacts viewer
  results/
    hero-row.tsx                           # Large stat + sparkline
    chart-card.tsx                         # Chart wrapper with export
    results-layout.tsx                     # Two-column results grid
```

**Total new files**: 24
**Files to significantly refactor**: `page.tsx`, `query-input.tsx`, `globals.css`, `theme-context.tsx`
**Files to deprecate**: `settings-panel.tsx` (replaced), `schema-preview.tsx` (moved to rail), `workbook-preview.tsx` (moved to rail)

---

## Estimated Commit Count

| Phase     | Commits | Description                                                                                                 |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| 0         | 4       | CSS tokens, z-index, dark mode                                                                              |
| 1         | 4       | Top bar, source pill, main wrapper                                                                          |
| 2         | 8       | Settings drawer (shell → sections → assembly → wiring)                                                      |
| 3         | 8       | Data rail (shell → sections → assembly → wiring)                                                            |
| 4         | 4       | Source cards, saved connections, State 1 rewrite                                                            |
| 5         | 4       | Profile strip, style selector, question input, State 2 rewrite                                              |
| 6         | 7       | Working indicator, hero row, chart card, results layout, artifacts panel, top bar actions, State 3+4 wiring |
| 7         | 5       | Cleanup, responsive, keyboard, animation, integration test                                                  |
| **Total** | **44**  |                                                                                                             |
