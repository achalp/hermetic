# Competitive Feature Gaps & Prioritization

_Last updated: 2026-04-25_

Source: extracted from the four April 2026 comparison documents
(`comparisons/hermetic-vs-{hex,julius-vizly,powerbi,thoughtspot}-2026-04-25.md`).
A "gap" here is a feature present in **two or more** competitors but absent
from Hermetic. Tiers reflect fit-with-Hermetic-philosophy × user value ×
implementation cost — not raw competitor count.

---

## Tier 1 — Highest priority

Natural extensions of the current product. Preserve the local-first,
single-user, AI-first identity. Ship next.

| #   | Feature                                                                  | Where competitors have it                  | Why prioritize                                                                                                            |
| --- | ------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Snowflake + Databricks connectors**                                    | Hex, Power BI, Julius, ThoughtSpot         | Single biggest connector gap; warehouse-only path, no architectural compromise                                            |
| 2   | **Edit-and-rerun on generated code**                                     | Julius (inline edit), Hex (Magic Edit)     | Artifacts panel already exposes the Python/SQL — letting users tweak and re-execute is a tiny lift, huge transparency win |
| 3   | **Suggested follow-up questions after each analysis**                    | Hex, Power BI Copilot, ThoughtSpot Spotter | Pure AI feature, fits "give me the answer" model; existing schema-load suggestion flow is the reuse point                 |
| 4   | **Pivot tables**                                                         | Hex, Power BI, ThoughtSpot                 | Most-requested missing display type; pure UI work on existing DataTable                                                   |
| 5   | **Scheduled local re-runs** (cron with new file)                         | Hex, Power BI, ThoughtSpot                 | Single-user-friendly version of "scheduled reports"; runs locally, exports to PDF / PPTX / DOCX                           |
| 6   | **dbt metadata enrichment** (read `.yml` schemas → enrich LLM context)   | Hex, ThoughtSpot                           | Read-only, no SaaS dependency; sharpens AI accuracy on warehouse questions                                                |
| 7   | **More input widgets** (date picker, multi-select, slider, color, range) | Hex, Power BI, all interactive tools       | DataController is already in place; these are component additions                                                         |

---

## Tier 2 — High value, larger lifts but still local-first compatible

Worthwhile next quarter. Each preserves the privacy / zero-cost story.

| #   | Feature                                                                | Where                                                 | Notes                                                                                                                                     |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | **Static shareable export** (single-file HTML snapshot of a dashboard) | Hex links, Power BI Publish-to-web, ThoughtSpot share | Self-contained `.html` with embedded JSON-Render, no server. Closes the "I can't show this to a colleague" gap without becoming SaaS      |
| 9   | **Anomaly / outlier auto-surfacing**                                   | Power BI Explain, ThoughtSpot SpotIQ                  | Compute-side post-pass; surface "things you didn't ask but should know" — fits the schema-aware data-domain detection that already exists |
| 10  | **Bookmarks** (saved filter states within an analysis)                 | Power BI                                              | Lets analysts capture "the version with these slicers" without re-running the LLM                                                         |
| 11  | **Conditional visibility** for components                              | Hex, Power BI                                         | Reactive state already exists via DataController; this is a render-time predicate                                                         |
| 12  | **R support in sandbox**                                               | Hex, ThoughtSpot Analyst Studio                       | Adds a Docker layer; meaningful for statistical workflows                                                                                 |
| 13  | **Custom pip package install**                                         | Hex (Team+)                                           | Sandbox already runs Python; expose a UI to add packages to the warm container                                                            |
| 14  | **Google Sheets ingestion**                                            | Julius, ThoughtSpot                                   | OAuth-once; common analyst data source                                                                                                    |
| 15  | **API / HTTP / REST as a source**                                      | Hex, Power BI                                         | Generated Python can already do `requests.get`; surface it as a first-class source type                                                   |
| 16  | **Smart narrative / explain-this-chart**                               | Power BI Smart Narrative, Copilot summaries           | LLM call on chart data; reuses existing pipeline                                                                                          |
| 17  | **Drill-through to detail rows**                                       | Power BI, ThoughtSpot                                 | Different from current drill-down (re-analysis): show the underlying rows for a clicked segment                                           |

---

## Tier 3 — Reconsider only if Hermetic adds an optional team mode

These break the single-user / local-first stance. Worth tracking but **do
not build unless the product strategy shifts** toward team / hosted
deployments. Building any of these without that shift dilutes the
privacy/zero-cost differentiation.

| Feature                                          | Why deferred                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Multiplayer editing                              | Fundamentally cloud                                                 |
| Comments / threads                               | Requires shared backend                                             |
| Real shareable links (server-hosted, not export) | Requires hosted infra                                               |
| RBAC / SSO / SAML / audit logs                   | Single-user product doesn't need them                               |
| Workspaces / collections                         | No team model                                                       |
| Slack / Teams / email subscriptions              | Need outbound integration + hosted scheduler                        |
| Embedded analytics / iframe / signed embed       | Requires hosted runtime                                             |
| Mobile app                                       | Large investment, low single-user value                             |
| Row-level / object-level security                | No multi-user identity model                                        |
| Git integration for analyses                     | Large architectural lift; static export covers most of the use case |
| Deployment pipelines / dev-test-prod             | Enterprise-only need                                                |
| Sensitivity labels (Purview-style)               | Enterprise governance                                               |
| Custom visuals marketplace (AppSource-style)     | Ecosystem play, not a single-tool feature                           |
| Verified-answer governance / Spotter Semantics   | Requires curated semantic layer                                     |

---

## Tier 4 — Watch list: the agentic gap

Every one of the four competitors has shipped or is shipping **agentic,
multi-step AI** in 2025–2026:

- **Hex Notebook Agent** — autonomous cell creation across SQL / Python / Markdown / Pivot / Chart
- **Julius Bloom agents + Custom Agents** — saved analytical workflows
- **Power BI Fabric Data Agents** — cross-source, RLS-aware, MCP-friendly
- **ThoughtSpot Spotter 3 + SpotterModel + SpotterViz + SpotterCode** — full lifecycle

Hermetic is single-shot. Possible directions, all compatible with
local-first execution:

- **Multi-step "deep-analysis" agent** that decomposes a complex question into sub-questions, runs each through the existing pipeline, then composes a final narrative — lives entirely within the existing local-first sandbox
- **"Investigate further" agent** that picks anomalies / outliers from a result, automatically generates follow-up questions, and stitches a multi-section investigation
- **Saved analytical "recipes"** (Julius Custom Agents equivalent) — re-runnable templates that bundle question + style + scope

This is a **directional gap**, not a feature gap. It needs a roadmap
conversation, not a backlog ticket. Either ship a local-first multi-step
agent, or commit to staying single-shot and lean harder into "the answer
in one prompt" as the differentiator.

---

## Recommended sequencing

If shipping in waves:

1. **Now (1–2 sprints):** items 1–4 and 7 — Snowflake/Databricks connectors, edit-and-rerun in artifacts, suggested follow-ups, pivot tables, more input widgets
2. **Next (1 quarter):** items 5, 6, 8, 9, 16 — scheduled local re-runs, dbt metadata, static HTML export, anomaly auto-surfacing, smart narrative
3. **Then (1–2 quarters):** items 10–15, 17 — bookmarks, conditional visibility, R support, custom pip, Google Sheets, REST sources, drill-through to rows
4. **Strategic decision:** pick a lane on Tier 4 (the agentic gap) — either ship a local-first multi-step agent, or double down on single-shot dashboards as the position

The Tier 3 list is intentionally large and intentionally deferred. Going
after those forces Hermetic toward a different product (hosted,
multi-tenant, governed) and erodes the privacy / zero-cost story that
the comparisons are built on.
