/**
 * Per-session budget for auto-routed sub-investigations (drill-as-sub-
 * investigation). A hard backstop against pathological drilling: even if the
 * lookup-vs-deep classifier keeps voting "deep", a data source can only spend
 * MAX_AUTO_INVESTIGATIONS_PER_SESSION full investigations on auto-routed
 * follow-ups before they degrade to the cheap lookup path. Explicit, user-
 * initiated Investigate runs are NOT counted — only classifier-promoted ones.
 *
 * In-memory, keyed by data-source id (csvId / warehouseId), with a TTL so a
 * session that goes quiet resets.
 */

const TTL_MS = 30 * 60 * 1000; // 30 min, matching the conversation cache

interface BudgetEntry {
  count: number;
  updatedAt: number;
}

const globalBudget = globalThis as unknown as {
  __autoInvestigationBudget?: Map<string, BudgetEntry>;
};
if (!globalBudget.__autoInvestigationBudget) {
  globalBudget.__autoInvestigationBudget = new Map();
}
const budget = globalBudget.__autoInvestigationBudget;

function getFresh(key: string, now: number): BudgetEntry {
  const entry = budget.get(key);
  if (!entry || now - entry.updatedAt > TTL_MS) {
    const fresh = { count: 0, updatedAt: now };
    budget.set(key, fresh);
    return fresh;
  }
  return entry;
}

/**
 * Try to spend one auto-investigation from the session budget. Returns true
 * (and increments) when under the cap; false when exhausted — the caller then
 * routes the follow-up to the cheap lookup path. `now` is injectable for tests.
 */
export function tryConsumeAutoInvestigation(key: string, max: number, now = Date.now()): boolean {
  const entry = getFresh(key, now);
  if (entry.count >= max) return false;
  entry.count += 1;
  entry.updatedAt = now;
  return true;
}

/** Test/reset helper. */
export function resetAutoInvestigationBudget(key?: string): void {
  if (key) budget.delete(key);
  else budget.clear();
}
