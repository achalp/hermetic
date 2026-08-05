/**
 * Response-size caps shared across MCP tools (review S15).
 *
 * `analyze` returns the artifacts behind the composed dashboard and
 * `run_analysis` returns the host-authored run's outputs — the SAME
 * boundary contract, so they must cap chart rows identically. Each tool
 * previously declared its own `CHART_ROW_CAP = 100` with a "same cap"
 * comment doing the sync; one constant means they cannot drift.
 */
export const CHART_ROW_CAP = 100;
