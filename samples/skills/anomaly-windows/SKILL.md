---
name: anomaly-windows
description: Anomaly/spike detection — robust MAD z-scores over aggregated series, windows reported with context
order: 220
triggers:
  question: ["anomal", "spike", "outlier", "unusual", "sudden drop", "sudden increase"]
failureHints:
  - pattern: "rolling|window|z-score|zscore"
    hint: "Compute rolling statistics over the AGGREGATED series (one row per time bucket, built with a DuckDB GROUP BY), never over raw event rows — a rolling window over millions of rows materializes the whole frame in pandas."
---

## Guidance

Anomaly/spike questions on {{filename}}:

- AGGREGATE FIRST: bucket to a sensible grain in DuckDB (GROUP BY
  date_trunc), then score the small series in pandas. Rolling ops on raw
  rows are the OOM/latency trap.
- Use ROBUST scoring: the preloaded mad_zscores (median absolute deviation)
  — a plain mean/std z-score lets one huge spike mask every other anomaly
  (the spike inflates std). Threshold ~3.5 is the standard default; say
  which threshold you used.
- Report anomalies as WINDOWS with context, not bare timestamps: the value,
  the expected level (rolling median), the deviation multiple, and the
  neighboring normal values so the chart shows why it is anomalous.
- A series with NO anomalies at the threshold is a valid answer — report the
  max |z| observed and show the series, never force a "top anomaly" that is
  within normal variation.
- Chart: the full series as context with anomalous points tagged
  (is_anomaly=True) so they render highlighted — the anomaly must be VISIBLE
  on the chart, not only in a table.
