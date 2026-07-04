FROM python:3.11-slim

# Pin package versions for reproducible builds
RUN pip install --no-cache-dir \
    pandas==2.2.3 \
    numpy==2.2.4 \
    scipy==1.15.2 \
    matplotlib==3.10.1 \
    seaborn==0.13.2 \
    scikit-learn==1.6.1 \
    duckdb==1.2.2

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
