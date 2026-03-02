# CSV Insight

Upload CSV or Excel files, ask questions in natural language, and get interactive dashboards — powered by Claude.

## Features

- **Natural Language Queries** — Ask questions about your data and get visual answers
- **Interactive Dashboards** — Auto-generated charts, tables, stat cards, and insights
- **10+ Chart Types** — Bar, line, area, pie, scatter, histogram, box plot, violin, heatmap, candlestick
- **3D Visualizations** — Scatter3D, Surface3D, Globe, deck.gl maps
- **Geographic Maps** — Pigeon-maps markers, deck.gl layers (hexagon, column, arc, heatmap)
- **Drill-Down Navigation** — Click chart segments to explore deeper
- **Client-Side Filtering** — DataController enables instant cross-filtering across dashboards
- **Export** — PDF, DOCX, PPTX, PNG, SVG
- **Save & Reload** — Persist and reload visualizations
- **Themes** — Vanilla, Stamen, Info is Beautiful, Pentagram (light + dark)
- **Model Selection** — Choose Claude model for code generation and UI composition
- **Sandbox Runtimes** — Docker (local), E2B (cloud), Microsandbox (MicroVM)

## Quick Start

```bash
git clone https://github.com/achalp/csv-insight.git
cd csv-insight
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

   Add credentials for your LLM provider (Anthropic API key, AWS credentials, or GCP project). See [Configuration](#configuration).

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

   # Start the server (dev mode — no API key required)
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
    csv/                CSV parsing & schema extraction
    excel/              Excel file handling
    llm/                LLM integration & prompt generation
    pipeline/           Query orchestration (code-gen → sandbox → UI compose)
    sandbox/            Code execution (Docker / E2B / Microsandbox)
    saved/              Saved visualization storage
```

### How It Works

1. **Upload** — CSV/Excel file is parsed, schema extracted, content stored in memory
2. **Query** — User question + schema sent to Claude for Python code generation
3. **Execute** — Generated code runs in a sandboxed Python environment with pandas/numpy/matplotlib
4. **Compose** — Execution results streamed to Claude for UI composition as JSON-Render spec
5. **Render** — JSON-Render spec streamed to the browser and rendered as interactive React components

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

CSV Insight executes AI-generated Python code in an isolated sandbox. Three runtimes are supported:

| Runtime              | How it works                          | Requirements                                                                                               |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Docker** (default) | Runs code in a local Docker container | [Docker Desktop](https://www.docker.com/products/docker-desktop/)                                          |
| **Microsandbox**     | Runs code in a lightweight microVM    | macOS Apple Silicon or Linux with KVM; [microsandbox server](https://github.com/microsandbox/microsandbox) |
| **E2B**              | Runs code in a cloud sandbox          | [E2B](https://e2b.dev) account and API key                                                                 |

Set `SANDBOX_RUNTIME` in `.env.local` to switch runtimes. The startup script (`start.sh`) lets you choose interactively.

## Configuration

### LLM Provider

Pick **one** provider. If `LLM_PROVIDER` is not set, the app auto-detects from available credentials.

| Variable                 | Required                      | Default     | Description                                                                |
| ------------------------ | ----------------------------- | ----------- | -------------------------------------------------------------------------- |
| `LLM_PROVIDER`           | No                            | auto-detect | Force a provider: `anthropic`, `bedrock`, `vertex`, or `openai-compatible` |
| `ANTHROPIC_API_KEY`      | If provider=anthropic         | —           | Anthropic API key                                                          |
| `AWS_ACCESS_KEY_ID`      | If provider=bedrock           | —           | AWS access key (or use `AWS_PROFILE`)                                      |
| `AWS_SECRET_ACCESS_KEY`  | If provider=bedrock           | —           | AWS secret key                                                             |
| `AWS_REGION`             | No                            | `us-east-1` | AWS region for Bedrock                                                     |
| `GOOGLE_VERTEX_PROJECT`  | If provider=vertex            | —           | GCP project ID                                                             |
| `GOOGLE_VERTEX_LOCATION` | No                            | `us-east5`  | GCP region for Vertex AI                                                   |
| `OPENAI_BASE_URL`        | If provider=openai-compatible | —           | OpenAI-compatible endpoint URL                                             |
| `OPENAI_API_KEY`         | No                            | —           | API key for the endpoint (not needed for Ollama)                           |
| `OPENAI_MODEL`           | If provider=openai-compatible | —           | Model name (e.g. `llama3.3`, `gpt-4o`)                                     |

### Sandbox Runtime

| Variable               | Required                | Default                 | Description                                                      |
| ---------------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------- |
| `SANDBOX_RUNTIME`      | No                      | `docker`                | Sandbox runtime: `docker`, `e2b`, or `microsandbox`              |
| `E2B_API_KEY`          | If runtime=e2b          | —                       | E2B API key                                                      |
| `MICROSANDBOX_URL`     | If runtime=microsandbox | `http://127.0.0.1:5555` | Microsandbox server URL                                          |
| `MICROSANDBOX_API_KEY` | No                      | —                       | Microsandbox API key                                             |
| `MICROSANDBOX_IMAGE`   | No                      | `microsandbox/python`   | Docker Hub image for the sandbox (packages installed at startup) |

## Tech Stack

- [Next.js 16](https://nextjs.org/) — React framework
- [Claude](https://docs.anthropic.com/) — LLM for code generation and UI composition
- [JSON-Render](https://json-render.com/) — Streaming UI rendering from JSON specs
- [Nivo](https://nivo.rocks/) — Declarative chart components
- [Plotly.js](https://plotly.com/javascript/) — 3D charts and advanced visualizations
- [deck.gl](https://deck.gl/) — Large-scale geospatial visualization
- [Tailwind CSS v4](https://tailwindcss.com/) — Utility-first CSS
- [Docker](https://www.docker.com/) — Sandboxed Python execution

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

[MIT](LICENSE)
