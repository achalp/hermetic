"""Memory guards — the a-priori gate generated code calls before a large .df().

The container memory cap is discovered by the prelude (cgroup files), which
calls configure() with it; assert_fits() then fails FAST with the exact
strategy-switch guidance instead of letting a doomed pull balloon for 20+
minutes into a kernel OOM-kill.
"""

_mem_limit_bytes = None

INFEASIBLE_MSG = (
    "This approach does not fit the container memory cap ({limit}). You are pulling too "
    "many rows into pandas. Do NOT retry the direct in-memory approach with fewer columns "
    "— at this scale even coordinates-only does NOT fit (cKDTree.query also allocates two "
    "more N-sized arrays). SWITCH STRATEGY: COUNT in DuckDB and go coarse-to-fine — bucket "
    "rows into grid cells with GROUP BY (nothing lands in pandas), branch-and-bound on the "
    "small cells table, then pull ONLY the tiny survivor set. Follow the PLANET-SCALE / "
    "DOESN'T-FIT recipe; do not materialize the tail."
)


def configure(mem_limit_bytes):
    """Set the container memory cap (bytes) assert_fits gates against. None disables."""
    global _mem_limit_bytes
    _mem_limit_bytes = mem_limit_bytes if (mem_limit_bytes or 0) > 0 else None


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
        )
