# Hermetic

Upload CSV, Excel, or GeoJSON files, ask questions in natural language, and get interactive dashboards. Works with cloud LLM providers (Anthropic, AWS Bedrock, Google Vertex, OpenAI-compatible) or local models via Ollama.

![Dashboard with stat cards, filters, trend lines, bar charts, and pie chart](docs/dashboard-top.png)
![Dashboard with box plots, heatmap, and scatter chart](docs/dashboard-bottom.png)

## Philosophy

Hermetic explores the idea that LLMs can generate correct data analysis code **without seeing the data itself**.

**Shape over samples.** Instead of sending rows to the LLM, Hermetic extracts the schema (column names, types, distributions, ranges, cardinality, correlations) and shares only that metadata as context. The LLM never sees actual data rows by default. This keeps data private, reduces token usage, and forces the model to reason about structure rather than memorize values.

**Blind execution.** The LLM generates Python code but never sees the results. Code runs in an isolated sandbox (Docker, microVM, or cloud), and the execution output (scalars, chart data, datasets) flows directly to the UI composition step. The LLM composing the dashboard works from result schemas and placeholders, not raw numbers. Every number displayed comes from actual computation on the real data.

**Sandboxed execution.** Code runs in containers or microVMs with no network access and no access to the host filesystem. Data is passed in via stdin and results are read from stdout. Warm sandbox modes (Docker, Microsandbox) reuse the underlying container across queries for speed but clear working data between runs. E2B creates a fresh sandbox each time.

**Adaptive UI.** The LLM composes a JSON-Render spec, a declarative layout of charts, stat cards, tables, annotations, and filters, tailored to each question. A bar chart for comparisons, a line chart for trends, stat cards for KPIs, a treemap for composition. The UI adapts to the question rather than using a fixed template.

## Features

- **Natural language queries.** Ask questions about your data and get visual answers.
- **Interactive dashboards.** Auto-generated charts, tables, stat cards, and insights.
- **Multiple LLM providers.** Anthropic, AWS Bedrock, Google Vertex AI, OpenAI-compatible endpoints.
- **Local models via Ollama.** Run offline with Qwen, Llama, DeepSeek, or any Ollama-supported model. Detect, pull, and activate models from the Settings UI.
- **30+ chart types.** Bar, line, area, pie, scatter, histogram, box plot, violin, heatmap, candlestick, sankey, treemap, sunburst, radar, bump, chord, waterfall, calendar, stream, ridgeline, dumbbell, slope, beeswarm, marimekko, bullet, parallel coordinates, confusion matrix, ROC curve, SHAP beeswarm, decision tree.
- **3D visualizations.** Scatter3D, Surface3D, Globe3D, deck.gl maps.
- **Geographic maps.** Pigeon-maps markers and GeoJSON polygons, deck.gl layers (hexagon, column, arc, scatterplot, heatmap).
- **Multiple file formats.** CSV, Excel (multi-sheet workbooks), GeoJSON, JSON.
- **Drill-down navigation.** Click chart segments to explore deeper.
- **Client-side filtering.** DataController enables instant cross-filtering across dashboards.
- **Save and update data.** Persist visualizations and re-run them with new data files. Schema-compatible updates skip LLM calls.
- **Export.** PDF, DOCX, PPTX. Individual charts can be downloaded as PNG.
- **Themes.** Vanilla, Stamen, Info is Beautiful, Pentagram (light and dark).
- **Model selection.** Choose models for code generation and UI composition.
- **Sandbox runtimes.** Docker (local), E2B (cloud), Microsandbox (microVM).

## Quick Start

```bash
git clone https://github.com/achalp/hermetic.git
cd hermetic
./start.sh
```

The setup script checks prerequisites, installs dependencies, sets up your chosen sandbox runtime, and starts the dev server. It will prompt you for an API key and let you choose between Docker and Microsandbox.

### Manual Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env.local
   ```

   Add credentials for your LLM provider (Anthropic API key, AWS credentials, or GCP project). See [Configuration](#configuration). For local-only usage with Ollama, no `.env.local` changes are needed. Configure it from the Settings UI instead.

3. **Set up a sandbox runtime** (pick one):

   **Option A: Docker** (default)

   ```bash
   docker build -t csv-sandbox docker/sandbox
   ```

   Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/).

   **Option B: Microsandbox** (lightweight microVMs)

   ```bash
   # Install the microsandbox server
   curl -sSL https://get.microsandbox.dev | sh

   # Start the server (dev mode, no API key required)
   msb server start --dev
   ```

   Then set in `.env.local`:

   ```
   SANDBOX_RUNTIME=microsandbox
   MICROSANDBOX_URL=http://127.0.0.1:5555
   ```

   Requires macOS Apple Silicon (M1+) or Linux with KVM.

   **Option C: E2B** (cloud sandbox)

   ```
   SANDBOX_RUNTIME=e2b
   E2B_API_KEY=your-e2b-key
   ```

   Sign up at [e2b.dev](https://e2b.dev).

4. **Start the dev server**

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000)

## Architecture

```
src/
  app/                  Next.js App Router
    api/
      query/            LLM query endpoint (streaming)
      upload/           File upload endpoint
      vizs/             Saved visualization CRUD
      artifacts/        Execution artifacts viewer
  components/
    app/                Application shell (upload, query, response, settings)
    charts/             Chart components (Nivo, Plotly, deck.gl, pigeon-maps)
    controllers/        DataController for client-side filtering
    inputs/             Form inputs (Select, NumberInput, Toggle)
  lib/
    csv/                CSV parsing and schema extraction
    excel/              Excel file handling
    geojson/            GeoJSON parsing
    llm/                LLM integration and prompt generation
    pipeline/           Query orchestration (code-gen, sandbox, UI compose)
    sandbox/            Code execution (Docker / E2B / Microsandbox)
    saved/              Saved visualization storage and versioning
```

### How It Works

1. **Upload.** CSV, Excel (multi-sheet), GeoJSON, or JSON file is parsed, schema extracted, and stored in memory.
2. **Query.** User question + schema sent to your configured LLM for Python code generation.
3. **Execute.** Generated code runs in a sandboxed Python environment with pandas, numpy, scipy, and scikit-learn.
4. **Compose.** Execution results sent to the LLM for UI composition as a JSON-Render spec.
5. **Render.** JSON-Render spec streamed to the browser and rendered as interactive React components.

Saved visualizations can be updated with new data files. If the schema matches, the saved code is re-executed directly without LLM calls.

## Development

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier format
npm run format:check # Prettier check
npm run type-check   # TypeScript check
npm test             # Run tests
npm run test:watch   # Tests in watch mode
npm run analyze      # Bundle analysis
```

## Sandbox Runtimes

Hermetic executes LLM-generated Python code in an isolated sandbox. Three runtimes are supported:

| Runtime              | How it works                          | Requirements                                                                                               |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Docker** (default) | Runs code in a local Docker container | [Docker Desktop](https://www.docker.com/products/docker-desktop/)                                          |
| **Microsandbox**     | Runs code in a lightweight microVM    | macOS Apple Silicon or Linux with KVM; [microsandbox server](https://github.com/microsandbox/microsandbox) |
| **E2B**              | Runs code in a cloud sandbox          | [E2B](https://e2b.dev) account and API key                                                                 |

Set `SANDBOX_RUNTIME` in `.env.local` to switch runtimes. The startup script (`start.sh`) lets you choose interactively.

## Configuration

### LLM Provider

Pick **one** provider. If `LLM_PROVIDER` is not set, the app auto-detects from available credentials. Ollama can be enabled from the Settings UI without any environment variables.

| Variable                 | Required                      | Default     | Description                                                                          |
| ------------------------ | ----------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `LLM_PROVIDER`           | No                            | auto-detect | Force a provider: `anthropic`, `bedrock`, `vertex`, `openai-compatible`, or `ollama` |
| `ANTHROPIC_API_KEY`      | If provider=anthropic         |             | Anthropic API key                                                                    |
| `AWS_ACCESS_KEY_ID`      | If provider=bedrock           |             | AWS access key (or use `AWS_PROFILE`)                                                |
| `AWS_SECRET_ACCESS_KEY`  | If provider=bedrock           |             | AWS secret key                                                                       |
| `AWS_REGION`             | No                            | `us-east-1` | AWS region for Bedrock                                                               |
| `GOOGLE_VERTEX_PROJECT`  | If provider=vertex            |             | GCP project ID                                                                       |
| `GOOGLE_VERTEX_LOCATION` | No                            | `us-east5`  | GCP region for Vertex AI                                                             |
| `OPENAI_BASE_URL`        | If provider=openai-compatible |             | OpenAI-compatible endpoint URL                                                       |
| `OPENAI_API_KEY`         | No                            |             | API key for the endpoint (not needed for Ollama)                                     |
| `OPENAI_MODEL`           | If provider=openai-compatible |             | Model name (e.g. `llama3.3`, `gpt-4o`)                                               |

### Ollama (Local Models)

No environment variables needed. Open **Settings > Local Models (Ollama)** to detect, pull, and activate models directly from the UI.

1. Install Ollama: `brew install ollama` (macOS) or see [ollama.com](https://ollama.com)
2. Start the server: `ollama serve`
3. Open Settings in Hermetic and activate a model

Recommended models for data analysis:

| Model                   | RAM    | Notes                             |
| ----------------------- | ------ | --------------------------------- |
| `qwen2.5-coder:14b`     | 16 GB+ | Best balance of quality and speed |
| `qwen2.5-coder:7b`      | 8 GB+  | Good for smaller machines         |
| `qwen2.5-coder:32b`     | 32 GB+ | Highest quality                   |
| `deepseek-coder-v2:16b` | 16 GB+ | Strong code and analysis          |
| `llama3.3:latest`       | 16 GB+ | General purpose                   |

When Ollama is activated in Settings, it takes priority over cloud providers. Deactivate it from Settings to switch back.

### Sandbox Runtime

| Variable               | Required                | Default                 | Description                                                      |
| ---------------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------- |
| `SANDBOX_RUNTIME`      | No                      | `docker`                | Sandbox runtime: `docker`, `e2b`, or `microsandbox`              |
| `E2B_API_KEY`          | If runtime=e2b          |                         | E2B API key                                                      |
| `MICROSANDBOX_URL`     | If runtime=microsandbox | `http://127.0.0.1:5555` | Microsandbox server URL                                          |
| `MICROSANDBOX_API_KEY` | No                      |                         | Microsandbox API key                                             |
| `MICROSANDBOX_IMAGE`   | No                      | `microsandbox/python`   | Docker Hub image for the sandbox (packages installed at startup) |

## Tech Stack

- [Next.js 16](https://nextjs.org/)
- [Vercel AI SDK](https://sdk.vercel.ai/) for multi-provider LLM integration
- [JSON-Render](https://json-render.com/) for streaming UI rendering from JSON specs
- [Nivo](https://nivo.rocks/) for declarative chart components
- [Plotly.js](https://plotly.com/javascript/) for 3D charts
- [deck.gl](https://deck.gl/) for geospatial visualization
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Docker](https://www.docker.com/) for sandboxed Python execution

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

[MIT](LICENSE)
