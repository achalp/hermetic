"""Cohort/retention helpers — matrices built in DuckDB, only aggregates reach pandas."""

import duckdb


def cohort_matrix(id_col, date_col, source="data", period="month"):
    """Retention matrix (cohort_period x period_offset -> distinct users) as a small DataFrame.

    Assigns each id ONE cohort (its MIN date), buckets both sides with
    date_trunc(period), and counts DISTINCT ids per (cohort, offset). The
    event table never reaches pandas — only the months x months matrix.
    """
    return duckdb.sql(
        f"""
        WITH firsts AS (
            SELECT {id_col} AS uid,
                   date_trunc('{period}', MIN(CAST({date_col} AS DATE))) AS cohort
            FROM {source} GROUP BY 1
        ),
        events AS (
            SELECT s.{id_col} AS uid,
                   date_trunc('{period}', CAST(s.{date_col} AS DATE)) AS p
            FROM {source} s
        )
        SELECT f.cohort,
               date_diff('{period}', f.cohort, e.p) AS offset,
               COUNT(DISTINCT e.uid) AS users
        FROM events e JOIN firsts f USING (uid)
        WHERE e.p >= f.cohort
        GROUP BY 1, 2
        ORDER BY 1, 2
        """
    ).df()


def retention_rates(matrix_df):
    """Row-normalize a cohort_matrix() result: rate = users / cohort size (offset 0).

    Returns the same frame with a `rate` column and a `cohort_size` column so
    results can disclose small-cohort noise.
    """
    sizes = (
        matrix_df[matrix_df["offset"] == 0]
        .set_index("cohort")["users"]
        .rename("cohort_size")
    )
    out = matrix_df.join(sizes, on="cohort")
    out["rate"] = out["users"] / out["cohort_size"]
    return out
