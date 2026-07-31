"""Sales-analysis skill helpers.

Auto-shipped with every run this skill activates for, as
/data/skill_lib/sales_analysis.py — import with
`from skill_lib.sales_analysis import win_rate, ...`. The skill guidance
advertises these automatically (signatures extracted from this file), so keep
each public function's first docstring line self-explanatory.

Every function takes/returns plain DuckDB-friendly values so the generated
code can stay engine-first and pull only small aggregates into pandas.
"""

import duckdb


def won_deals_view(source: str = "data") -> str:
    """Create/refresh the `won_deals` view (deal_stage = 'Won') and return its name.

    Every revenue/units metric should read from this view, not the raw table —
    the SALES-WON-ONLY rule as code instead of prose.
    """
    duckdb.sql(f"CREATE OR REPLACE VIEW won_deals AS SELECT * FROM {source} WHERE deal_stage = 'Won'")
    return "won_deals"


def win_rate(source: str = "data") -> dict:
    """Win rate over DECIDED deals only: won / (won + lost), pending excluded.

    Returns {"won": int, "lost": int, "pending": int, "win_rate": float} so the
    result can disclose exactly what the denominator was.
    """
    row = duckdb.sql(
        f"""
        SELECT
            count(*) FILTER (WHERE deal_stage = 'Won')     AS won,
            count(*) FILTER (WHERE deal_stage = 'Lost')    AS lost,
            count(*) FILTER (WHERE deal_stage = 'Pending') AS pending
        FROM {source}
        """
    ).fetchone()
    won, lost, pending = (int(v or 0) for v in row)
    decided = won + lost
    return {
        "won": won,
        "lost": lost,
        "pending": pending,
        "win_rate": (won / decided) if decided else None,
    }


def average_selling_price(source: str = "won_deals") -> float | None:
    """ASP as a RATIO OF SUMS — SUM(revenue)/SUM(units) — never AVG(revenue/units).

    The per-row mean over-weights small deals (SALES-ASP-RATIO rule as code).
    """
    revenue, units = duckdb.sql(
        f"SELECT SUM(revenue), SUM(units) FROM {source}"
    ).fetchone()
    return (float(revenue) / float(units)) if units else None


def monthly_revenue(source: str = "won_deals"):
    """Won revenue by month (date_trunc), returned as a small aggregated DataFrame.

    One row per month — safe to .df() at any data size, and the caller can
    label a trailing partial month rather than plotting a fake drop.
    """
    return duckdb.sql(
        f"""
        SELECT date_trunc('month', CAST(date AS DATE)) AS month,
               SUM(revenue) AS revenue,
               SUM(units)   AS units,
               count(*)     AS deals
        FROM {source}
        GROUP BY 1
        ORDER BY 1
        """
    ).df()
