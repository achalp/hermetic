# Output Styles — Critical Analysis & Proposed Alternates

> Created: 2026-06-14
> Scope: the user-selectable "styles" in the query bar (Dashboard / Narrative / Summary / Deep dive / Slides / Report) and their backing `PURPOSE_MODES`.
> Companion: `prototypes.html` (open in a browser) renders concrete design options for each proposed style so you can choose.

---

## TL;DR verdict

The styles are **differentiated on paper (six distinct prompt blocks) but not in the artifact**, and **two of the six names lie about what they produce**. Specifically:

1. **"Dashboard" is mislabeled.** Picking "Dashboard" runs the **`infographic`** prompt — _"a data infographic that flows top-to-bottom as a narrative."_ That is the opposite of a dashboard. A dashboard is a **scannable grid you monitor at a glance**; an infographic is a **vertical story you read**. Users selecting "Dashboard" do not get a dashboard.
2. **Three of the six are near-duplicates.** `narrative` and `report` are both "prose paragraphs with charts as evidence." `infographic` (shown as "Dashboard") and `presentation` ("Slides") are both "visual, top-to-bottom, section-separated." The genuinely distinct poles are only **Summary (short)** and **Deep dive (long)**.
3. **The frame isn't enforced.** Every style is a _suggestion_ appended to the LLM prompt — and it suggests the wrong axis (often nudging chart counts) rather than the reading frame. There's no guarantee the rendered _container/density_ differs, so toggling Infographic → Report can produce a visually identical artifact. (The fix is to enforce the **frame**, not to cap content — see the principle below. The LLM choosing chart count/type/volume from the question is correct and must stay.)
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

### Principle: a style governs FORM, never CONTENT

This is the load-bearing constraint, and the thing my first draft got wrong (see "What a style must NOT do" below). The whole point of the tool is that **the LLM decides how many visuals, which types, and how much to show — driven by the question and the shape of the answer.** A style must not touch that. A style only sets the **frame** the answer is poured into:

- **Reading mode / container** — scan-grid vs linear document vs one-screen vs paged.
- **Narrative density** — terse labels vs interleaved one-line insights vs full prose paragraphs.
- **Framing / order** — bottom-line-first vs build-up vs numbered sections.
- **Tone** — formal vs journalistic vs neutral.
- **Depth of exploration** — expressed as judgment ("answer as minimally as the question allows" ⟷ "explore exhaustively from multiple angles"), so chart count _emerges_ from how much the model explores. Never a cap.

Two styles with the _same_ number of charts should still look obviously different because the container and density differ. That difference is the product, and it's name-honest without ever dictating content.

### Option A — **Tighten to 4** (recommended)

Collapse to the four consumption contexts above. Each fixes a **frame** (container + density + framing + depth-instruction); the LLM fills it with whatever visuals the answer needs.

- **Dashboard** — _scan frame._ A grid-oriented container (KPI stat cards + a chart grid), terse. The LLM picks how many cards/charts and which; the style guarantees the **grid/scan layout**, not a count. Fixes the mislabel.
- **Brief** (was "Summary") — _one-screen frame._ Bottom-line-up-front, terse, fits a screen. The LLM still chooses whether the answer is one hero chart or two small ones — the style enforces "lead with the answer, keep it scannable," not "exactly 1 chart."
- **Report** — _document frame._ Sectioned, prose-led, captioned visuals, tables where precise. Absorbs "Narrative" (formal vs journalistic is a tone knob, not a separate button). Section count and visual count are the LLM's.
- **Deep dive** — _exploration frame._ Multi-angle and exhaustive with methodology/caveats surfaced; the **depth instruction** ("examine from every useful angle, flag what wasn't asked") drives breadth — the model decides what those angles and visuals are.

Dropped: **Narrative** (→ Report), **Infographic** (an aesthetic, not a consumption context), **Slides** (→ a _Report export format_, not a compose style — any artifact can export to PPTX).

**Why recommended:** four buttons, four genuinely different _frames_, every name true to its reading mode, zero overlap — and the LLM keeps full authority over content.

### Option B — **Keep 6, fix names + enforce**

If you want the broader palette, the minimum to make it honest:

- Rename so UI label = behavior: the current "Dashboard" becomes **"Infographic"** (or **"Visual story"**), and a **new true "Dashboard"** (grid) is added.
- Merge **Narrative** into **Report** (one prose mode with a formal/journalistic tone toggle) _or_ keep both but sharpen Narrative to "single-thread blog-style, no sections" vs Report "formal numbered doc."
- Keep **Slides** only if it produces a real deck (paged, one-idea-per-page) distinct from a sectioned Report.
- Everything still needs the enforced skeletons below.

This is more surface area to maintain and still risks overlap; Option A is cleaner.

---

## The real fix (independent of taxonomy): **enforce FORM, not content**

Prompt text alone won't guarantee a visible difference between styles. But the enforcement must stay strictly on the **frame** — the things the user explicitly asked for by picking the style — and never on the **content budget**, which is the LLM's call.

**What a style MAY enforce (form the user requested):**

- **Container / reading mode.** If the user picked Dashboard, honor the grid/scan container; if Report, honor sectioned-document flow; if Brief, one-screen/BLUF order. This is _obeying the user's stated intent_, not overriding the model. A post-compose check can repair an obvious frame violation (e.g. a "Dashboard" that came back as a single prose column → wrap into the grid container) without touching what's inside.
- **Narrative density & tone.** Strip/condense prose for Dashboard; require prose paragraphs for Report. Density is form, not content.
- **Depth instruction.** Pass the explore-minimally ⟷ explore-exhaustively signal so breadth tracks the style. The model still decides the angles.

**What a style must NOT do (this was the error in my first draft):**

- ❌ Cap or require a number of charts ("exactly 1", "≥4").
- ❌ Require/forbid specific component types ("must include a DataTable", "no charts").
- ❌ Cap total component count.

Those are content decisions the tool exists to make from the question and the shape of the answer — hard-coding them fights the product's core value. The differentiation comes from the **frame**, and two styles with the same charts will still read very differently because the container and density differ.

> Where guardrails are still useful, make them about the _frame_ and keep them generous: a "Brief" that returns 30 components has broken the one-screen frame (worth a nudge); a "Brief" that picks 2 charts instead of 1 has not. Judge frame violations, not content counts.

This is the same proposer/checker posture used elsewhere (result-validator, grounding pass) — but pointed only at form.

Two more, regardless of option chosen:

- **Make Investigate honor the style** (or explicitly scope styles to Ask and hide the selector in Investigate — today it's silently ignored, which is the worst of both).
- **Surface the description on hover.** The good one-line descriptions in `purpose-prompts.ts` never reach the UI; the selector is bare labels. Show them.

---

## What's in `prototypes.html`

For each proposed style, the prototype renders **two concrete design options (A/B)** over the _same_ sample dataset (regional revenue), so the only thing varying is the **frame** — making the differentiation (or lack of it) visually obvious. Use it to choose:

1. Which **taxonomy** (the tight 4, or the fixed 6).
2. For each style you keep, which **frame option** (A or B) reads best.

> **Read the mockups as frames, not recipes.** The specific chart counts and types shown (a 2×2 grid here, five angles there) are _illustrative placeholders_ for the container and density — not prescriptions. In the real product the LLM chooses the number, type, and volume of visuals per question; the style only fixes the frame they're poured into.

Open it, click through the styles in the top nav, and note your A/B pick per style. I'll turn the chosen **frames** into composer contracts (container + density + depth instruction, with content left to the model) plus the renamed/trimmed selector.
