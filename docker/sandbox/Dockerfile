FROM python:3.11-slim

# Pin package versions for reproducible builds
RUN pip install --no-cache-dir \
    pandas==2.2.3 \
    numpy==2.2.4 \
    scipy==1.15.2 \
    matplotlib==3.10.1 \
    seaborn==0.13.2 \
    scikit-learn==1.6.1

# Create non-root user for sandbox execution
RUN groupadd -r sandbox && useradd -r -g sandbox -d /data -s /sbin/nologin sandbox
RUN mkdir -p /data && chown sandbox:sandbox /data

WORKDIR /data
USER sandbox
