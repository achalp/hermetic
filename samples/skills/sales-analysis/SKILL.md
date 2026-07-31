---
name: sales-analysis
description: Correctness rules for the bundled sales dataset — won-only revenue, ASP, win rate, monthly trends
order: 100
triggers:
  columns: ["^deal_stage$", "^customer_segment$"]
  question: ["win rate", "pipeline", "quota", "sales rep", "average selling price"]
reviewGate: false
reviewRules: |
  SALES-WON-ONLY — flag when a revenue/units metric (totals, trends, rankings, ASP) is computed WITHOUT filtering deal_stage = 'Won'. Pending and Lost rows carry revenue values but are not closed business; including them inflates every figure. (Explicit pipeline/forecast questions that ASK about open deals are the exception — then the stage split must be shown, not blended.)
  SALES-ASP-RATIO — flag when average selling price is computed as AVG(revenue/units) per row instead of SUM(revenue)/SUM(units); the per-row mean over-weights small deals.
failureHints:
  - pattern: "rep leaderboard|per-rep"
    hint: "Aggregate per sales_rep in DuckDB (GROUP BY sales_rep) and pull only the aggregated leaderboard into pandas — never the raw deal rows."
---

## Guidance

This is the bundled sales demo dataset ({{filename}}): one row per deal with
date, region, product, channel, revenue, units, customer_segment, deal_stage
(Won / Lost / Pending) and sales_rep.

- CLOSED BUSINESS ONLY: every revenue, units, growth, ranking, or share metric
  filters `deal_stage = 'Won'` unless the question explicitly asks about the
  open pipeline or losses. Pending and Lost rows carry revenue amounts — an
  unfiltered SUM silently inflates results (~6% of rows are not Won).
- WIN RATE = won deals / (won + lost) decided deals. Pending deals are
  undecided — exclude them from the denominator and say so in the result.
- AVERAGE SELLING PRICE = SUM(revenue) / SUM(units) over won deals — a ratio
  of sums. Never AVG(revenue/units): the per-row mean over-weights small deals.
- TRENDS: bucket by month with date_trunc('month', date). The data spans full
  months; if the last month is partial, label it partial rather than showing a
  fake drop.
- SEGMENT/CHANNEL MIX: customer_segment and channel are low-cardinality
  dimensions — prefer a share-of-total breakdown (with percentages) over raw
  counts, and keep segment names verbatim (SMB, Enterprise, ...).
- RESULTS should state the filter applied, e.g. results["analysis_scope"] =
  "475 won deals (Pending/Lost excluded)".
