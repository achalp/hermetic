# Output Styles — Critical Analysis & Proposed Alternates

> Created: 2026-06-14
> Scope: the user-selectable "styles" in the query bar (Dashboard / Narrative / Summary / Deep dive / Slides / Report) and their backing `PURPOSE_MODES`.
> Companion: `prototypes.html` (open in a browser) renders concrete design options for each proposed style so you can choose.

---

## TL;DR verdict

The styles are **differentiated on paper (six distinct prompt blocks) but not in the artifact**, and **two of the six names lie about what they produce**. Specifically:

1. **"Dashboard" is mislabeled.** Picking "Dashboard" runs the **`infographic`** prompt — _"a data infographic that flows top-to-bottom as a narrative."_ That is the opposite of a dashboard. A dashboard is a **scannable grid you monitor at a glance**; an infographic is a **vertical story you read**. Users selecting "Dashboard" do not get a dashboard.
2. **Three of the six are near-duplicates.** `narrative` and `report` are both "prose paragraphs with charts as evidence." `infographic` (shown as "Dashboard") and `presentation` ("Slides") are both "visual, top-to-bottom, section-separated." The genuinely distinct poles are only **Summary (short)** and **Deep dive (long)**.
3. **Nothing is enforced.** Every style is a _suggestion_ appended to the LLM prompt. There is no post-compose skeleton, no component cap, no validation, no test. A user toggling Infographic → Report can see _zero_ change because the model is free to compose the same spec for both.
4. **Investigate ignores style entirely.** The investigate composer is hardcoded; the style selector is dead in that path.

Net: six choices, ~3 real artifacts, two false labels, zero enforcement. This reads as _choice overload masking thin differentiation_ — the classic "settings that don't do anything" trust-killer.

---

## Current state (ground truth)

`src/components/app/style-selector.tsx` → `src/lib/purpose-prompts.ts`. The UI label and the internal mode **do not match**:

| UI label (what the user picks) | Internal id         | Internal label       | What the prompt actually asks for                                              |
| ------------------------------ | ------------------- | -------------------- | ------------------------------------------------------------------------------ |
| **Dashboard**                  | `infographic`       | "Infographic"        | Top-to-bottom **narrative** infographic, interleaved insights. **Not a grid.** |
| **Narrative**                  | `narrative`         | "Narrative Analysis" | Prose paragraphs lead; 2–4 charts as evidence; journalistic tone.              |
| **Summary**                    | `executive-summary` | "Executive Summary"  | BLUF sentence + 2–4 stat cards + ≤1 chart; <8 components.                      |
| **Deep dive**                  | `deep-analysis`     | "Deep Analysis"      | 4–6 charts, DataTable, methodology + caveats + outliers, SectionBreaks.        |
| **Slides**                     | `presentation`      | "Presentation"       | 3–5 slide-like sections; title + one viz + takeaway each.                      |
| **Report**                     | `report`            | "Report"             | Numbered sections, prose, DataTable-preferred, 2–3 captioned charts, formal.   |

Everything is injected as text via `getPurposePrompt()` into the Ask composer system prompt (`/api/query/route.ts`). No rendering-time consequence.

---

## Does each name deliver the artifact its name promises? (semantic test)

| Style (UI)    | Promise implied by the name          | Delivers it? | Why                                                                                             |
| ------------- | ------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------- |
| **Dashboard** | A scannable KPI **grid** you monitor | ❌ **No**    | Runs the infographic prompt — a vertical narrative, explicitly "flows top-to-bottom."           |
| **Narrative** | A written story                      | ✅ Yes-ish   | But near-identical to Report.                                                                   |
| **Summary**   | 30-second bottom line                | ✅ Yes       | Genuinely constrained (≤8 components, ≤1 chart). The best-defined style.                        |
| **Deep dive** | Exhaustive exploration               | ✅ Yes       | Genuinely expansive (4–6 charts + table + caveats). The other good pole.                        |
| **Slides**    | A deck                               | ⚠️ Partly    | Sections ≈ slides, but overlaps Infographic and isn't actually exportable as slides distinctly. |
| **Report**    | A formal document                    | ✅ Yes       | But overlaps Narrative.                                                                         |

**Two clear failures** (Dashboard mislabeled), **two redundant pairs** (Narrative≈Report, Infographic≈Slides), **two strong poles** (Summary, Deep dive).

---

## Market lens

Most data tools (Hex, Thoughtspot, Power BI, Julius) **don't offer output "styles" at all** — you get a notebook, or a dashboard canvas, full stop. So a _tight, enforced_ style system is a genuine differentiator: "ask once, get the artifact shaped for how it'll be consumed." But the current implementation undercuts that promise on three fronts a buyer would notice in the first session:

- **Labels that lie** (Dashboard isn't a dashboard) erode trust faster than having no styles at all.
- **Toggling with no visible effect** trains users to ignore the control.
- **Overlapping options** create decision friction with no payoff.

The fix is to make styles map to **consumption contexts** — _who reads this, where, and how much time they have_ — because that's the only axis a user can reason about, and it's the axis that should drive structure:

| Context                 | Reader             | Time                | Right artifact                            |
| ----------------------- | ------------------ | ------------------- | ----------------------------------------- |
| Monitor / self-serve    | You, repeatedly    | seconds, scanning   | **Dashboard** (grid of KPIs + charts)     |
| Decision / escalation   | Exec, once         | ~30 seconds         | **Brief** (one screen, BLUF)              |
| Deliverable / record    | Stakeholder, async | minutes, linear     | **Report** (sectioned doc, tables, prose) |
| Investigation / working | Analyst (you)      | as long as it takes | **Deep dive** (multi-angle + methodology) |

These four are mutually exclusive, individually defensible, and each implies a _structurally different_ skeleton — which is exactly what's missing today.

---

## Proposed taxonomy — two options (pick in `prototypes.html`)

### Option A — **Tighten to 4** (recommended)

Collapse to the four consumption contexts above. Each gets an **enforced structural skeleton** (see below), so the artifacts are guaranteed distinct.

- **Dashboard** — _true grid._ KPI stat-card row + a 2×N chart grid, minimal prose. The fix for the mislabel.
- **Brief** (was "Summary") — one screen: BLUF sentence + 3 KPIs + 1 hero chart + 1 caveat line.
- **Report** — numbered sections, prose, a data table, captioned charts. Absorbs "Narrative" (formal and journalistic prose are the same artifact with a tone knob, not separate buttons).
- **Deep dive** — multi-angle, 4–6 charts, methodology + caveats + outliers + table.

Dropped: **Narrative** (→ Report), **Infographic** (an aesthetic, not a consumption context), **Slides** (→ becomes a _Report export format_, not a compose style — any artifact can export to PPTX).

**Why recommended:** four buttons, four genuinely different artifacts, every name true to its output, zero overlap. Less is more — and it's enforceable.

### Option B — **Keep 6, fix names + enforce**

If you want the broader palette, the minimum to make it honest:

- Rename so UI label = behavior: the current "Dashboard" becomes **"Infographic"** (or **"Visual story"**), and a **new true "Dashboard"** (grid) is added.
- Merge **Narrative** into **Report** (one prose mode with a formal/journalistic tone toggle) _or_ keep both but sharpen Narrative to "single-thread blog-style, no sections" vs Report "formal numbered doc."
- Keep **Slides** only if it produces a real deck (paged, one-idea-per-page) distinct from a sectioned Report.
- Everything still needs the enforced skeletons below.

This is more surface area to maintain and still risks overlap; Option A is cleaner.

---

## The real fix (independent of taxonomy): **enforce structure**

Prompt text alone will never guarantee differentiation. Each style should have a **skeleton the composer must fill** and a **post-compose validation**:

- **Dashboard:** root MUST be a `LayoutGrid`/`LayoutColumn` of a `LayoutGrid` of StatCards (the KPI row) followed by a chart `LayoutGrid` (≥2 columns). Reject/repair specs that are a single column of prose.
- **Brief:** hard cap (≤8 components, exactly 1 chart, ≤4 stat cards). Trim or re-ask on violation.
- **Report:** require ≥2 `SectionBreak`s and ≥1 `DataTable`; headings numbered.
- **Deep dive:** require ≥4 charts and ≥1 `Annotation` (methodology/caveat).

This is the same posture already used elsewhere (the result-validator, the grounding pass): the composer proposes, a deterministic check enforces the contract. Cheap, and it's what turns "a prompt hint" into "a product guarantee."

Two more, regardless of option chosen:

- **Make Investigate honor the style** (or explicitly scope styles to Ask and hide the selector in Investigate — today it's silently ignored, which is the worst of both).
- **Surface the description on hover.** The good one-line descriptions in `purpose-prompts.ts` never reach the UI; the selector is bare labels. Show them.

---

## What's in `prototypes.html`

For each proposed style, the prototype renders **two concrete design options (A/B)** over the _same_ sample dataset (regional revenue), so the only thing varying is structure/style — making the differentiation (or lack of it) visually obvious. Use it to choose:

1. Which **taxonomy** (the tight 4, or the fixed 6).
2. For each style you keep, which **layout option** (A or B) becomes the enforced skeleton.

Open it, click through the styles in the top nav, and note your A/B pick per style. I'll turn the chosen skeletons into the enforced composer contracts + the renamed/trimmed selector.
