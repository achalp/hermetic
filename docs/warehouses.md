# Warehouse connection reference

Per-engine connection fields and setup notes. How warehouse queries work, and how they are hardened, is in the [README](../README.md#data-warehouses). Connect with a **read-only role** — see the example there.

## PostgreSQL

Works with PostgreSQL, Amazon Redshift, Neon, Supabase, AlloyDB, CockroachDB, and any PostgreSQL wire-compatible database.

**Connection fields:**

| Field    | Example     | Notes                     |
| -------- | ----------- | ------------------------- |
| Host     | `localhost` | Hostname or IP            |
| Port     | `5432`      | Default: 5432             |
| Database | `mydb`      |                           |
| User     | `postgres`  |                           |
| Password |             |                           |
| Schema   | `public`    | Default: public           |
| SSL      | unchecked   | Check for cloud databases |

**Environment variables** (optional, for `start.sh` or `.env.local`):

```bash
WAREHOUSE_TYPE=postgresql
WAREHOUSE_PG_HOST=localhost
WAREHOUSE_PG_PORT=5432
WAREHOUSE_PG_DATABASE=mydb
WAREHOUSE_PG_USER=postgres
WAREHOUSE_PG_PASSWORD=secret
WAREHOUSE_PG_SCHEMA=public
WAREHOUSE_PG_SSL=false
```

**Sample dataset — Pagila (DVD rental):**

```bash
# Start a local PostgreSQL with the Pagila sample database
docker run -d --name pagila \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgresai/extended-postgres:16

# Load the Pagila dataset
docker exec -i pagila psql -U postgres -c "CREATE DATABASE pagila;"
curl -sL https://raw.githubusercontent.com/devrimgunduz/pagila/master/pagila-schema.sql | docker exec -i pagila psql -U postgres -d pagila
curl -sL https://raw.githubusercontent.com/devrimgunduz/pagila/master/pagila-data.sql | docker exec -i pagila psql -U postgres -d pagila
```

Then connect with: host `localhost`, port `5432`, database `pagila`, user `postgres`, password `postgres`.

Try asking: _"What are the top 10 most rented films and their total revenue?"_

## ClickHouse

**Connection fields:**

| Field    | Example               | Notes                      |
| -------- | --------------------- | -------------------------- |
| Host     | `play.clickhouse.com` | Hostname or IP             |
| Port     | `443`                 | 8123 (HTTP) or 443 (HTTPS) |
| Database | `default`             |                            |
| User     | `play`                |                            |
| Password |                       | Leave empty for playground |
| SSL      | checked               | Required for port 443      |

**Environment variables** (optional):

```bash
WAREHOUSE_TYPE=clickhouse
WAREHOUSE_CH_HOST=play.clickhouse.com
WAREHOUSE_CH_PORT=443
WAREHOUSE_CH_DATABASE=default
WAREHOUSE_CH_USER=play
WAREHOUSE_CH_PASSWORD=
WAREHOUSE_CH_SSL=true
```

**Free sample dataset — ClickHouse Playground:**

No setup needed. Connect to `play.clickhouse.com` (port `443`, user `play`, no password, SSL on). This public playground has dozens of pre-loaded datasets:

| Table                            | Description              | Rows   |
| -------------------------------- | ------------------------ | ------ |
| `uk_price_paid`                  | UK property transactions | 28M+   |
| `trips`                          | NYC taxi trips           | 3B+    |
| `cell_towers`                    | OpenCellID cell towers   | 43M+   |
| `dns`                            | DNS query logs           | 1M+    |
| `github_events`                  | GitHub event stream      | 200M+  |
| `stock`                          | Daily stock prices       | varies |
| `menu`, `menu_page`, `menu_item` | NYC restaurant menus     | varies |
| `opensky`                        | Flight tracking data     | 60M+   |

Try asking: _"Show the average property price trend by year in London"_ (against `uk_price_paid`)

## BigQuery

**Connection fields:**

| Field                | Example                              | Notes                                     |
| -------------------- | ------------------------------------ | ----------------------------------------- |
| Project ID           | `my-gcp-project`                     | Your GCP project (for billing)            |
| Dataset              | `bigquery-public-data.stackoverflow` | Use `project.dataset` for public datasets |
| Service Account JSON | `{ "type": "service_account", ... }` | Paste JSON key or path to `.json` file    |

**Environment variables** (optional):

```bash
WAREHOUSE_TYPE=bigquery
WAREHOUSE_BQ_PROJECT=my-gcp-project
WAREHOUSE_BQ_DATASET=bigquery-public-data.stackoverflow
WAREHOUSE_BQ_CREDENTIALS_JSON=/path/to/service-account.json
```

**Setup (5 minutes):**

1. Create a GCP project at [console.cloud.google.com](https://console.cloud.google.com) (free tier, no credit card for public datasets)
2. Go to **IAM & Admin > Service Accounts** > Create service account
3. Grant roles: **BigQuery Job User** + **BigQuery Data Viewer**
4. **Keys** > Add Key > Create new key > JSON — download the file
5. In Hermetic, enter your project ID, dataset, and paste the JSON key

**Free public datasets** (no data to load — already available):

| Dataset                                        | Description            |
| ---------------------------------------------- | ---------------------- |
| `bigquery-public-data.stackoverflow`           | Stack Overflow posts   |
| `bigquery-public-data.github_repos`            | GitHub repository data |
| `bigquery-public-data.austin_crime`            | Austin crime reports   |
| `bigquery-public-data.chicago_taxi_trips`      | Chicago taxi data      |
| `bigquery-public-data.usa_names`               | US baby names by year  |
| `bigquery-public-data.new_york_subway`         | NYC subway ridership   |
| `bigquery-public-data.google_analytics_sample` | GA web analytics       |

Enter the dataset as `bigquery-public-data.stackoverflow` (the `project.dataset` format tells Hermetic to query from that project while billing your project).

Try asking: _"What are the most popular programming language tags by year?"_

## Snowflake

**Connection fields:**

| Field     | Example             | Notes                             |
| --------- | ------------------- | --------------------------------- |
| Account   | `xy12345.us-east-1` | Your Snowflake account identifier |
| Username  | `analyst`           |                                   |
| Password  |                     | Or use key-pair auth              |
| Warehouse | `COMPUTE_WH`        |                                   |
| Database  | `ANALYTICS`         |                                   |
| Schema    | `PUBLIC`            |                                   |
| Role      | `ANALYST_ROLE`      | Optional                          |

## Databricks

**Connection fields:**

| Field           | Example                            | Notes                                     |
| --------------- | ---------------------------------- | ----------------------------------------- |
| Server hostname | `abc-1234.cloud.databricks.com`    | Your workspace host                       |
| HTTP path       | `/sql/1.0/warehouses/abc123def456` | From the SQL warehouse connection details |
| Access token    | `dapi…`                            | Personal access token                     |
| Catalog         | `main`                             |                                           |
| Schema          | `default`                          |                                           |

## Trino / Hive

Both have inline connection forms with host, port, catalog/database, and credentials. Trino works with Starburst and any Trino-compatible engine.
