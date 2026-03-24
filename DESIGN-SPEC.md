# Hermetic UI Redesign — Design Specification

> Reference prototype: `~/Downloads/hermetic-prototypes/v6-focus.html`
> This spec describes the target UX to implement in the existing Next.js codebase.

---

## 1. Design Principles

1. **Google-simple** — one primary action per screen. Everything else is secondary.
2. **Joy through accomplishment** — the user should feel "I did that" when results appear.
3. **Sealed by default** — privacy is the brand, not a footnote. "hermetic = sealed."
4. **Visual over verbal** — IA, workflow, and visuals communicate. Minimize text/copy.
5. **Nothing intimidating** — non-technical users should never feel lost or overwhelmed.

---

## 2. Layout Shell

### Top Bar (persistent, all states)

- **Height**: 56px, fixed top, full width, z-index 250
- **Background**: `var(--card)`, bottom border `var(--border)`
- **Left**: "hermetic" logo — 16px, weight 700, `var(--accent)`, lowercase. Clicking resets to State 1.
- **Center**: contextual content per state (see state descriptions)
- **Right**: contextual action buttons + gear icon (always present)

### Main Content

- `max-width: 1000px`, centered, `padding: 0 40px`
- When data rail is visible: `margin-right: 48px` (rail collapsed width)

### Data Rail (right edge, States 2–4)

- Fixed, full height below top bar, right-aligned
- **Collapsed**: 48px wide, dark surface, 3 stacked icon buttons + expand arrow
- **Expanded**: 380px wide, full data explorer content
- **Fullscreen**: 100vw, covers everything below top bar
- Expansion triggers bokeh blur on main content (`filter: blur(6px); opacity: 0.6`)
- Hidden in State 1 (no data loaded)

### Settings Drawer (right overlay)

- 360px wide, dark surface, slides from right over everything
- Overlay + bokeh blur on main content
- Mutually exclusive with data rail expansion (only one open at a time)

### Artifacts Panel (bottom sheet, State 4 only)

- Slides up from bottom, 55vh default height
- **Fullscreen**: `calc(100vh - 56px)`
- Dark surface, tabbed content (SQL / Python / Data)
- Overlay + its own close mechanism
- Mutually exclusive with rail/settings

**Mutual exclusion rule**: only ONE panel/drawer can be open at a time. Opening one closes the other.

---

## 3. Theme System

### CSS Custom Properties

ALL colors, radii, font-weights, and spacing use CSS custom properties. Themes are applied via `data-theme` attribute on `<html>`.

### Available Themes

| Theme         | `--accent`        | `--radius-card` | `--font-heading-weight` | `--chart-bar-radius` | Character                             |
| ------------- | ----------------- | --------------- | ----------------------- | -------------------- | ------------------------------------- |
| **Default**   | `#059669` emerald | `12px`          | `800`                   | `6px 6px 2px 2px`    | Clean, confident                      |
| **Stamen**    | `#b45309` amber   | `2px`           | `700`                   | `0`                  | Sharp, cartographic, uppercase labels |
| **IIB**       | `#dc2626` red     | `16px`          | `900`                   | `8px 8px 2px 2px`    | Vivid, generous spacing, larger text  |
| **Pentagram** | `#000000` black   | `0`             | `900`                   | `0`                  | Stark, reductive, zero radii          |

### Theme-Specific Overrides

- **Stamen**: `.card-title`, `.stat-label`, `.bar-label`, `.followup-label` get `text-transform: uppercase; letter-spacing: 0.06em`. Dropzone uses `border-style: dashed`.
- **IIB**: `.drop-hero` → 42px, `.ask-input` → 58px height / 20px font, `.hero-number` → 64px, `.card` padding → 28px.
- **Pentagram**: No additional overrides beyond the zero-radius variables.

### Extensibility

New themes are added by defining a new `[data-theme="name"]` CSS block overriding the custom properties. The settings UI renders theme swatches dynamically from a configuration array.

### Light / Dark / System Mode

- Applied via `data-mode` attribute on `<html>` (no attribute = light, `data-mode="dark"` = dark)
- **System mode** (default): respects `prefers-color-scheme` media query, listens for live changes
- Dark mode overrides surface colors while preserving each theme's accent:
  - `--bg: #0f1117`, `--card: #1a1d27`, `--border: #2a2d37`
  - `--text: #e5e7eb`, `--text2: #9ca3af`
  - Accent-derived colors adjust opacity for dark backgrounds
- All component surfaces that use `var(--card)`, `var(--bg)`, `var(--border)` automatically adapt

---

## 4. User Journey — State by State

### State 1: Connect Your Data

**Top bar center**: empty
**Top bar right**: gear icon only

**Layout**: centered vertically in viewport, max-width 700px

**Content** (top to bottom):

1. **Hero text**: "What's hiding in your data?" — 36px, `var(--font-heading-weight)`
2. **Two sibling source cards** — 2-column grid, equal weight:
   - **Left: "Upload a file"** — dashed border, upload icon (emerald circle + white arrow SVG), subtitle "CSV · Excel · JSON · GeoJSON". Click → State 2.
   - **Right: "Connect a warehouse"** — solid border, database icon (cylinder SVG), subtitle "PostgreSQL · BigQuery · ClickHouse · Trino". Click → reveals connection form.
   - Both cards: `var(--card)` background, `var(--border)` border, `var(--radius-card)` radius, 40px 32px padding. Hover: `var(--accent)` border + `var(--accent-light)` background.
3. **Saved connections** (if any exist):
   - Label: "Saved connections" — 12px uppercase, `var(--text3)`
   - Row of pill buttons, each showing: colored dot + DB-type emoji + name + host
   - Example: `🐘 analytics · company.com`
   - **One click → straight to State 2**. No form, no fields. Instant.
   - Styled as pills: `var(--radius-pill)`, `var(--card)` bg, `var(--border)` border, hover → accent
4. **New connection form** (hidden until warehouse card is clicked):
   - DB type selector: 4 equal buttons in a row (🐘 PostgreSQL | 📊 BigQuery | ⚡ ClickHouse | 🔷 Trino)
   - Click one → reveals 3 fields: Host, Database, Password + Connect button
   - Slides in with height animation
5. **Sealed badge**: "🔒 Sealed. Your data stays local." — 13px, `var(--text2)`, centered

### State 2: Ask

**Top bar center**: source pill — "✓ sales_data.csv · 12,847 rows" — `var(--accent-light)` bg, `var(--accent)` text, pill-shaped
**Top bar right**: gear icon
**Data rail**: appears (collapsed, 48px)

**Layout**: centered vertically, max-width 700px

**Content** (top to bottom, this order matters — it's the user's mental flow):

1. **Profile strip** — single horizontal line of stats separated by `|` dividers:
   - "12,847 rows | 23 columns | Jan '23 – Dec '25 | Revenue: $2.4M–$18.7M | Region · Product · Channel"
   - 13px, `var(--text2)`, centered
2. **Style selector** — what kind of output do you want?
   - Dot-separated text links: `Dashboard · Narrative · Summary · Deep dive · Slides · Report`
   - 13px. Active: `var(--accent)` + underline. Others: `var(--text2)`.
   - Default selection: "Dashboard"
3. **Suggestion pills** — question ideas:
   - "Revenue trends" "Compare regions" "Anomalies" "Breakdown by product"
   - `var(--radius-pill)`, `var(--card)` bg, `var(--border)` border. Hover → accent.
   - Click fills the input and submits.
4. **Question input** — the primary action:
   - 52px height, 18px font, `var(--radius-input)` radius
   - Placeholder: "Ask anything..."
   - Circular submit button (40px, `var(--accent)`, white arrow) positioned inside the input's right edge
   - Focus: `var(--accent)` border

**Information flow**: Data context → Output format → Question inspiration → Type + Ask

### State 3: Working

**Top bar center**: source pill (same as State 2)
**Data rail**: visible (collapsed), can still be opened

**Layout**: centered vertically

**Content**:

- Three dots pulsing in sequence (8px circles, `var(--accent)`, `animation: pulse 1.2s ease-in-out infinite` with staggered delays)
- Status text below: "Analyzing..." → "Composing..." → "Done" — 14px, `var(--text2)`
- Auto-advances to State 4 after ~3 seconds (in real app: driven by streaming completion)

### State 4: Results

**Top bar center**: the question asked — 14px, `var(--text2)`, truncated with ellipsis
**Top bar right**: [Save] [Export ▾] [</>] [gear] — all `btn-topbar` style
**Data rail**: visible (collapsed)

**Layout**: max-width 1000px, two-column grid for main content

**Content** (top to bottom):

1. **Hero row** — full width, `var(--hero-bg)` background, `var(--radius-card)` radius, 32px padding:
   - **Left (60%)**: Large stat number (56px, `var(--font-heading-weight)`, `var(--accent)`) + label (16px, `var(--text2)`)
   - **Right (40%)**: Mini sparkline (8 thin bars, `var(--accent)`) + trend text ("↑ 3× industry avg", `var(--accent)`, 14px)
   - The number animates from 0 to final value on reveal (requestAnimationFrame counter)

2. **Two-column grid** (`grid-template-columns: 3fr 2fr`, gap 20px):
   - **Left: Chart card** — `var(--card)` bg, `var(--border)` border, `var(--radius-card)` radius:
     - Header row: title left, per-chart export button right (appears on card hover, "↓ PNG")
     - Bar chart: bars use `var(--accent)`, `var(--chart-bar-radius)`, grow from 0 height with staggered animation
     - Hover on bar: tooltip with exact value
   - **Right: Stats + Insight** stacked:
     - **3 stat cards** (stacked vertically): value left (20px bold), label right (13px gray). `var(--card)` bg, `var(--border)`.
     - **Insight card**: `var(--insight-bg)` bg, `var(--insight-text)` text, `var(--radius-card)`. Terse — 3 sentences max.

3. **Follow-up row**: "Next:" label + suggestion pills (same style as State 2). Click → loops to State 3.

**Animations**: all result sections use staggered fade-up (opacity 0→1, translateY 16px→0, 0.5s ease, 100ms stagger between sections).

---

## 5. Panels & Drawers

### Settings Drawer

**Trigger**: gear icon in top bar (always accessible)
**Position**: fixed, right 0, full height, 360px wide, dark surface
**Sections** (collapsible, each with an 11px uppercase header):

1. **Appearance**
   - **Mode toggle**: `☀ Light · ◐ System · ☾ Dark` — 3-segment toggle button
   - **Theme swatches**: row of 40×40 color squares, each showing the theme's accent color and border-radius. Active swatch has a 2px accent-colored border. Below each: theme name in 10px. Extensible — the row wraps for additional themes.

2. **Connected Sources**
   - Shows current connection (if any) as a card with green dot + label + [Disconnect]
   - "Add connection" button → inline form (same as State 1 warehouse form but dark-themed)

3. **Models**
   - Two rows: "Code Generation" and "UI Composition" — each with a `<select>` dropdown
   - Options: Claude Opus 4, Claude Sonnet 4, GPT-4o, etc.

4. **Analysis Defaults**
   - Default style: 6 pills (Dashboard, Narrative, Summary, Deep dive, Slides, Report)
   - Schema mode: 2-segment toggle (Metadata | Sample)

5. **About**: "hermetic v1.0" + "Data stays sealed. Always." — dim text

### Data Rail (Data Explorer)

**Trigger**: clicking any icon on the collapsed rail, or the expand arrow
**Position**: fixed, right 0, below top bar, full height

**Collapsed state** (48px):

- 3 stacked icon buttons: Schema (table grid), Profile (bar chart), Sample (document)
- Expand arrow at bottom (‹)

**Expanded state** (380px):

- Header: "Data Explorer" + fullscreen toggle + collapse arrow (›)
- Content adapts to data source type:

**For CSV/JSON**:

- Source pill: "📄 sales_data.csv · 12,847 rows · 23 columns"
- SCHEMA section (collapsible, default open): compact column table (Column | Type | Sample). Type badges as colored pills — `text`=gray, `number`=blue `#60a5fa`, `date`=amber `#fbbf24`. Show 8 columns + "+N more" link.
- PROFILE section (collapsible, default open): stat chips in a row + inline distribution bars (column name + emerald fill bar + range text)
- SAMPLE section (collapsible, default closed): 3-row mini table

**For Excel workbook**:

- Source: "📊 Q4_Report.xlsx · 4 sheets"
- SHEETS section: vertical tabs (Revenue, Products, Regions, Channels). Active tab: emerald left border + lighter bg. Each shows row count. Click switches schema/profile/sample below.
- RELATIONSHIPS section: "Revenue.product_id → Products.id" etc. — small text, emerald arrows.
- Then SCHEMA, PROFILE, SAMPLE for the active sheet.

**For Warehouse**:

- Source: "🐘 PostgreSQL · analytics_db"
- TABLES section: vertical list (orders, customers, products, regions). Each with row count. Click switches detail below.
- Then SCHEMA, PROFILE, SAMPLE for selected table.

**Fullscreen state** (100vw): icon strip hides, content fills screen.

### Artifacts Panel

**Trigger**: `</>` button in top bar (State 4 only)
**Position**: fixed, bottom 0, full width, 55vh default

**Tabs**: SQL | Python | Data — tab bar with 2px bottom accent border on active
**Content per tab**:

- **SQL**: syntax-highlighted query (monospace, keywords purple `#c084fc`, strings green `#86efac`, comments gray italic)
- **Python**: syntax-highlighted code (functions blue `#93c5fd`, same keyword/string colors)
- **Data**: table showing computed results (column headers uppercase, 12px, borders)

**Fullscreen state**: `calc(100vh - 56px)`, border-radius 0

---

## 6. Export & Save

### Per-Chart Export

- Each chart card shows a small export button on hover (top-right of the chart header)
- Button: "↓ PNG" — 11px, border, appears with `opacity 0→1` on card hover
- Exports that specific chart as PNG at 2× pixel ratio

### Full Visualization Export

- **Top bar button**: "Export ▾" — dropdown with: PDF, DOCX, PPTX, PNG
- Dropdown: positioned below button, white card, shadow, 4 items with hover highlight
- Click outside dismisses

### Save

- **Top bar button**: "Save" — click → briefly shows "✓" with `var(--accent)` color, then reverts
- Saves the current spec + question + artifacts for later reload

---

## 7. Interaction Specifications

### Transitions

- All state changes: content fades in with `opacity 0→1, translateY 16→0, 0.5s ease`
- Results sections: staggered 100ms per section
- Drawers/panels: `transform: translateX/Y` with `0.3s ease`
- Bokeh blur: `filter` and `opacity` transition `0.3s ease`
- Bar chart bars: `height 0→final%`, `0.8s ease`, staggered `60ms` per bar
- Hero number: animated counter over `0.9s` with cubic ease-out

### Bokeh/Blur Effect

When any panel/drawer opens:

```css
.main.blurred {
  filter: blur(6px);
  opacity: 0.6;
  pointer-events: none;
  transition:
    filter 0.3s ease,
    opacity 0.3s ease;
}
```

Top bar stays sharp and interactive (z-index above overlay).

### Mutual Exclusion

- Rail expanded + settings click → rail collapses, settings opens
- Settings open + rail click → settings closes, rail expands
- Artifacts open + anything else → artifacts closes first
- Only ONE of {rail expanded, settings open, artifacts open} at any time

---

## 8. Component Mapping (Existing → New)

| Current Component                                     | Change Required                                                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page.tsx`                                            | Restructure to 4-state flow. Add data rail, replace settings panel trigger, move warehouse connection to settings. Add saved connections to State 1. Reorder State 2 (style selector before input).       |
| `query-input.tsx`                                     | Enlarge to 52px. Add inline circular submit button. Add suggestion pills below. Remove the separate Ask button.                                                                                           |
| `csv-upload-panel.tsx`                                | Replace with sibling source cards (file + warehouse). File card retains drag-drop.                                                                                                                        |
| `warehouse-connect-panel.tsx`                         | Move to settings drawer "Connected Sources" section. Also render inline form in State 1 when warehouse card is clicked.                                                                                   |
| `schema-preview.tsx`                                  | Move into data rail's SCHEMA section. Make it more compact (column/type/sample table with colored type badges).                                                                                           |
| `workbook-preview.tsx`                                | Move into data rail's SHEETS section (vertical tabs + relationships).                                                                                                                                     |
| `settings-panel.tsx`                                  | Restructure as a right-side drawer with sections: Appearance (mode + themes), Connected Sources, Models, Analysis Defaults, About.                                                                        |
| `response-panel.tsx`                                  | Restructure results layout to two-column grid. Add hero row with sparkline. Add per-chart export. Move save/export to top bar. Add artifacts button.                                                      |
| `artifacts-viewer.tsx`                                | Reposition as bottom sheet panel with fullscreen toggle. Keep SQL/Python/Data tabs.                                                                                                                       |
| `saved-vizs-panel.tsx`                                | TBD — could remain as a separate view or integrate into the flow.                                                                                                                                         |
| Theme system (`theme-context.tsx`, `theme-config.ts`) | Add light/dark/system mode support. Ensure all theme variables include dark-mode overrides. Add `data-mode` attribute handling alongside existing `data-theme`.                                           |
| Purpose prompts (`purpose-prompts.ts`)                | Already implemented. Wire "style selector" text links to purpose IDs: Dashboard→infographic, Narrative→narrative, Summary→executive-summary, Deep dive→deep-analysis, Slides→presentation, Report→report. |

---

## 9. CSS Variable Contract

Every visual property must use a CSS variable. Components must NEVER use hardcoded colors.

```css
/* Surfaces */
--bg                    /* page background */
--card                  /* card/panel background */
--border                /* borders and dividers */

/* Text */
--text                  /* primary text */
--text2                 /* secondary text */
--text3                 /* tertiary/placeholder text */

/* Accent */
--accent                /* primary action color */
--accent-hover          /* hover state */
--accent-light          /* tinted backgrounds */
--accent-light2         /* very subtle tints */

/* Dark surfaces (drawers, rails, panels) */
--surface-dark          /* primary dark bg */
--surface-dark-2        /* secondary dark bg */
--surface-dark-3        /* tertiary dark bg */
--surface-dark-text     /* text on dark surfaces */
--surface-dark-text2    /* secondary text on dark */
--surface-dark-text3    /* tertiary text on dark */
--surface-dark-text4    /* quaternary text on dark */

/* Shape */
--radius-card           /* cards, containers */
--radius-button         /* buttons, inputs */
--radius-pill           /* pills, badges */
--radius-input          /* text inputs */

/* Typography */
--font-heading-weight   /* hero and section headings */

/* Charts */
--chart-bar-radius      /* bar chart top corners */

/* Semantic */
--insight-bg            /* insight card background */
--insight-text          /* insight card text */
--hero-bg               /* hero stat row background */
```

---

## 10. Saved Warehouse Connections

Saved connections appear in TWO places:

1. **State 1** — as one-click pill buttons below the source cards
2. **Settings drawer** — in the "Connected Sources" section for management (edit/delete)

Each saved connection stores: `{ id, type, name, host, database, savedAt }`.

One-click pills show: colored dot (by DB type) + emoji + display name + host. Click → immediately load the connection and advance to State 2.

---

## 11. Responsive Considerations

- **< 768px**: source cards stack vertically (1 column). Two-column results stack. Data rail hides collapsed icons, only expands as full overlay. Top bar actions collapse into a menu.
- **768–1024px**: layout works as designed but with tighter padding.
- **> 1024px**: full layout as spec'd.

---

## 12. Accessibility

- `role="radiogroup"` on style selector
- `role="radio"` + `aria-checked` on style options
- `aria-label` on icon buttons (gear, rail icons, expand, fullscreen)
- `aria-expanded` on collapsible sections
- Keyboard navigation: Tab through all interactive elements, Enter/Space to activate
- Focus-visible outlines using `var(--accent)`
- Screen reader live regions for status messages ("Analyzing...", "Saved!")
- Skip-to-content link in the layout
