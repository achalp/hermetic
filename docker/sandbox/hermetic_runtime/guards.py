"""Memory guards — the a-priori gate generated code calls before a large .df().

The container memory cap is discovered by the prelude (cgroup files), which
calls configure() with it; assert_fits() then fails FAST with the exact
strategy-switch guidance instead of letting a doomed pull balloon for 20+
minutes into a kernel OOM-kill.
"""

_mem_limit_bytes = None
_strategy_hint = ""

# Domain-NEUTRAL base message — the guard mechanism protects every large run
# (warehouse exports, wide CSVs, remote parquet), so it must not assume the
# spatial recipe. An active skill appends its own strategy pointer via
# set_strategy_hint() (e.g. planet-scale adds the DOESN'T-FIT recipe pointer).
INFEASIBLE_MSG = (
    "This approach does not fit the container memory cap ({limit}). You are pulling too "
    "many rows into pandas. Do NOT retry the same in-memory approach with fewer columns "
    "— at this scale the ROW COUNT is the problem, not the width. SWITCH STRATEGY: push "
    "the heavy work into DuckDB (filter/COUNT/GROUP BY/aggregate — it streams and spills "
    "to disk) and pull only a small aggregated result into pandas."
)


def configure(mem_limit_bytes):
    """Set the container memory cap (bytes) assert_fits gates against. None disables."""
    global _mem_limit_bytes
    _mem_limit_bytes = mem_limit_bytes if (mem_limit_bytes or 0) > 0 else None


def set_strategy_hint(text):
    """Append a domain strategy pointer to guard failures (called by skill preludes)."""
    global _strategy_hint
    _strategy_hint = text or ""


def get_strategy_hint():
    """The currently configured strategy pointer ("" when no skill set one)."""
    return _strategy_hint


def assert_fits(n_rows, cols=3, dtype_bytes=8, factor=3.0, what="this DataFrame"):
    """Raise MemoryError BEFORE a large .df() when the frame cannot fit the cap.

    Call after a cheap COUNT(*). factor covers pandas overhead + downstream
    arrays. No-op when the cap is unknown or n_rows is falsy.
    """
    if not _mem_limit_bytes or not n_rows:
        return
    need = int(n_rows) * int(cols) * int(dtype_bytes) * float(factor)
    if need > _mem_limit_bytes * 0.80:
        lim = "%.1f GB" % (_mem_limit_bytes / 1e9)
        raise MemoryError(
            "%s would need ~%.1f GB for %d rows, over the %s cap. "
            % (what, need / 1e9, int(n_rows), lim)
            + INFEASIBLE_MSG.format(limit=lim)
            + _strategy_hint
        )
