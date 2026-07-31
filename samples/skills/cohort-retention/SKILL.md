---
name: cohort-retention
description: Cohort and retention analyses — period-based cohorts built in DuckDB, row-normalized curves, decided-user denominators
order: 200
triggers:
  columns: ["^(signup|created|first_seen|joined)_?(date|at)?$"]
  question: ["retention", "cohort", "churn", "come back", "repeat"]
failureHints:
  - pattern: "cohort|retention matrix|pivot"
    hint: "Build the cohort matrix as a DuckDB GROUP BY (cohort_period x offset_period -> COUNT(DISTINCT id)) and pull ONLY the aggregated matrix into pandas — never pivot raw event rows in pandas."
---

## Guidance

Cohort/retention questions on {{filename}}:

- COHORT = the period of a user's FIRST event (their signup/created date),
  bucketed with date_trunc. Assign each user ONE cohort via a MIN(date)
  GROUP BY user — never per-event.
- Build the retention matrix in DuckDB: one row per (cohort_period,
  period_offset) with COUNT(DISTINCT user_id). The matrix is tiny (months x
  months); the event table may not be. Only the matrix reaches pandas.
- RETENTION RATE is row-normalized: cell / cohort size (offset 0). Report
  rates AND cohort sizes — a 90% rate over 10 users is noise, and the
  composer should be able to say so.
- The LAST cohort and the LAST period are usually PARTIAL — label them
  (e.g. "Jul (partial)") or exclude them, never let a fake cliff at the end
  read as churn.
- Chart: retention curves (one line per cohort, x = periods since start)
  beat heatmaps for "is retention improving" questions; use the heatmap for
  "where does drop-off happen".
