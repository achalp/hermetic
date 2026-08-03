# Pinned by digest (multi-arch manifest list, python 3.11.15-slim-trixie,
# 2026-07-14) so the "reproducible builds" claim below is actually true —
# a bare tag is a moving target. Update deliberately, with the pip pins.
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93

# Pin package versions for reproducible builds. pyflakes is a fast static
# undefined-name checker (F821): the pre-flight lint uses it to catch a missing
# import (e.g. `cKDTree` used without `from scipy.spatial import cKDTree`) in
# milliseconds — BEFORE a multi-minute remote scan runs and dies with a
# NameError on the last line. A conservative stdlib-AST fallback runs when this
# module is absent (older image), so the lint degrades gracefully.
RUN pip install --no-cache-dir \
    pandas==2.2.3 \
    numpy==2.2.4 \
    scipy==1.15.2 \
    matplotlib==3.10.1 \
    seaborn==0.13.2 \
    scikit-learn==1.6.1 \
    duckdb==1.2.2 \
    pyflakes==3.2.0

# Create non-root user for sandbox execution
RUN groupadd -r sandbox && useradd -r -g sandbox -d /data -s /sbin/nologin sandbox
RUN mkdir -p /data && chown sandbox:sandbox /data

WORKDIR /data
USER sandbox

# Pre-bundle the DuckDB extensions for reading cloud files directly (httpfs →
# s3://, https:// Parquet) and spatial/geo ops (spatial → ST_Distance, etc.).
# Installed as the sandbox user so they bake into its DuckDB home (/data/.duckdb),
# making runtime LOAD offline + instant. Runs at build time (build has network).
RUN python -c "import duckdb; c=duckdb.connect(); c.execute('INSTALL httpfs'); c.execute('INSTALL spatial')"
