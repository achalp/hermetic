#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
#  Hermetic — One-command setup & run
# ─────────────────────────────────────────────────────────

# Ensure common install locations are in PATH
# (microsandbox installs to ~/.local/bin, Homebrew to various locations)
for p in "$HOME/.local/bin" "$HOME/.msb/bin" "/usr/local/bin" "/opt/homebrew/bin"; do
  [[ -d "$p" ]] && [[ ":$PATH:" != *":$p:"* ]] && export PATH="$p:$PATH"
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

step=0
step() {
  step=$((step + 1))
  echo ""
  echo -e "${BLUE}[$step]${RESET} ${BOLD}$1${RESET}"
}

ok()   { echo -e "    ${GREEN}✓${RESET} $1"; }
warn() { echo -e "    ${YELLOW}!${RESET} $1"; }
fail() { echo -e "    ${RED}✗ $1${RESET}"; echo ""; exit 1; }

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Hermetic — Setup & Launch${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

# ── 1. Check Node.js ──────────────────────────────────────
step "Checking Node.js"

if ! command -v node &>/dev/null; then
  fail "Node.js is not installed.

    Please install Node.js 18 or later:
      • Mac:     brew install node
      • Or:      https://nodejs.org (download the LTS installer)

    Then re-run this script."
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  fail "Node.js $NODE_VERSION found, but version 18+ is required.

    Please update Node.js:
      • Mac:     brew upgrade node
      • Or:      https://nodejs.org (download the LTS installer)

    Then re-run this script."
fi

ok "Node.js $(node -v)"

# ── 2. Choose sandbox runtime ────────────────────────────
step "Choosing sandbox runtime"

# If .env.local already exists with a runtime, use it
RUNTIME=""
if [ -f .env.local ] && grep -q "^SANDBOX_RUNTIME=" .env.local 2>/dev/null; then
  RUNTIME=$(grep "^SANDBOX_RUNTIME=" .env.local | cut -d= -f2)
fi

if [ -z "$RUNTIME" ]; then
  HAS_DOCKER=false
  HAS_MSB=false
  command -v docker &>/dev/null && docker info &>/dev/null 2>&1 && HAS_DOCKER=true
  command -v msb &>/dev/null && HAS_MSB=true

  if $HAS_DOCKER && $HAS_MSB; then
    echo ""
    echo -e "    Both Docker and Microsandbox are available."
    echo -e "    ${BOLD}1)${RESET} Docker       ${DIM}— runs code in containers${RESET}"
    echo -e "    ${BOLD}2)${RESET} Microsandbox ${DIM}— runs code in lightweight microVMs${RESET}"
    echo ""
    echo -n "    Choose runtime [1]: "
    read -r CHOICE
    case "$CHOICE" in
      2) RUNTIME="microsandbox" ;;
      *) RUNTIME="docker" ;;
    esac
  elif $HAS_MSB; then
    RUNTIME="microsandbox"
    ok "Microsandbox detected — using microsandbox runtime"
  elif $HAS_DOCKER; then
    RUNTIME="docker"
    ok "Docker detected — using docker runtime"
  else
    echo ""
    echo -e "    ${BOLD}No sandbox runtime found.${RESET} You need one of:"
    echo ""
    echo -e "    ${BOLD}Option A: Docker${RESET}"
    echo -e "      Install Docker Desktop: ${BLUE}https://www.docker.com/products/docker-desktop/${RESET}"
    echo ""
    echo -e "    ${BOLD}Option B: Microsandbox${RESET} ${DIM}(macOS Apple Silicon or Linux with KVM)${RESET}"
    echo -e "      curl -sSL https://get.microsandbox.dev | sh"
    echo -e "      msb server start --dev"
    echo ""
    fail "Install Docker or Microsandbox, then re-run this script."
  fi
fi

ok "Using $RUNTIME runtime"

# ── 3. Validate sandbox runtime ──────────────────────────
step "Checking $RUNTIME"

if [ "$RUNTIME" = "docker" ]; then
  if ! command -v docker &>/dev/null; then
    fail "Docker is not installed.

    Please install Docker Desktop:
      • Mac:     https://www.docker.com/products/docker-desktop/
      • Linux:   https://docs.docker.com/engine/install/

    Install it, launch it, then re-run this script."
  fi

  if ! docker info &>/dev/null; then
    warn "Docker is installed but not running."
    echo ""
    echo -e "    ${BOLD}Please open Docker Desktop and wait for it to start,${RESET}"
    echo -e "    ${BOLD}then re-run this script.${RESET}"
    echo ""
    exit 1
  fi

  ok "Docker daemon is running"

elif [ "$RUNTIME" = "microsandbox" ]; then
  if ! command -v msb &>/dev/null; then
    echo ""
    echo -e "    Microsandbox CLI (${BOLD}msb${RESET}) is not installed."
    echo ""
    echo -e "    Install it with:"
    echo -e "      ${BOLD}curl -sSL https://get.microsandbox.dev | sh${RESET}"
    echo ""
    echo -e "    Then start the server:"
    echo -e "      ${BOLD}msb server start --dev${RESET}"
    echo ""
    fail "Install microsandbox, then re-run this script."
  fi

  ok "msb CLI found"

  # Check if microsandbox server is responding
  MSB_URL="${MICROSANDBOX_URL:-http://127.0.0.1:5555}"

  msb_reachable() {
    # Server returns 404 on root — that's fine, it means it's up.
    # Use -o /dev/null -w to check HTTP status instead of -f.
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "${MSB_URL}" 2>/dev/null) || return 1
    [ "$status" != "000" ]
  }

  if msb_reachable; then
    ok "Microsandbox server is running at ${MSB_URL}"
  else
    warn "Microsandbox server is not running at ${MSB_URL}"
    echo ""
    echo -e "    Starting microsandbox server in the background..."

    # Try --detach first, fall back to backgrounding
    if msb server start --dev --detach 2>/dev/null; then
      ok "msb server start --dev --detach succeeded"
    else
      msb server start --dev &>/dev/null &
      MSB_PID=$!
      disown "$MSB_PID" 2>/dev/null || true
    fi

    # Wait up to 10 seconds for the server to come up
    echo -ne "    Waiting for server"
    for i in $(seq 1 10); do
      if msb_reachable; then
        echo ""
        ok "Microsandbox server started"
        break
      fi
      echo -n "."
      sleep 1
    done

    if ! msb_reachable; then
      echo ""
      echo ""
      echo -e "    ${BOLD}Could not auto-start the server.${RESET}"
      echo -e "    Please start it manually in another terminal:"
      echo -e "      ${BOLD}msb server start --dev${RESET}"
      echo ""
      fail "Microsandbox server not reachable at ${MSB_URL}"
    fi
  fi
fi

# ── 4. LLM Provider Credentials ──────────────────────────
step "Checking LLM provider"

HAS_LLM_CREDS=false

# Check if any provider credentials exist in .env.local or environment
if [ -f .env.local ]; then
  grep -q "^ANTHROPIC_API_KEY=sk-" .env.local 2>/dev/null && HAS_LLM_CREDS=true
  grep -q "^AWS_ACCESS_KEY_ID=" .env.local 2>/dev/null && HAS_LLM_CREDS=true
  grep -q "^GOOGLE_VERTEX_PROJECT=" .env.local 2>/dev/null && HAS_LLM_CREDS=true
  grep -q "^OPENAI_BASE_URL=" .env.local 2>/dev/null && HAS_LLM_CREDS=true
fi

# Also check env vars directly
[ -n "${ANTHROPIC_API_KEY:-}" ] && HAS_LLM_CREDS=true
[ -n "${AWS_ACCESS_KEY_ID:-}" ] && HAS_LLM_CREDS=true
[ -n "${AWS_PROFILE:-}" ] && HAS_LLM_CREDS=true
[ -n "${GOOGLE_VERTEX_PROJECT:-}" ] && HAS_LLM_CREDS=true
[ -n "${OPENAI_BASE_URL:-}" ] && HAS_LLM_CREDS=true

if $HAS_LLM_CREDS; then
  ok "LLM credentials found"
else
  echo ""
  echo -e "    Choose your ${BOLD}LLM provider${RESET}:"
  echo ""
  echo -e "    ${BOLD}1)${RESET} Anthropic ${DIM}— direct API key${RESET}"
  echo -e "    ${BOLD}2)${RESET} Amazon Bedrock ${DIM}— AWS credentials${RESET}"
  echo -e "    ${BOLD}3)${RESET} Google Vertex AI ${DIM}— GCP project${RESET}"
  echo -e "    ${BOLD}4)${RESET} OpenAI-compatible ${DIM}— custom endpoint${RESET}"
  echo -e "    ${BOLD}5)${RESET} Local models ${DIM}— MLX, llama.cpp, or Ollama (configure in Settings)${RESET}"
  echo ""
  echo -n "    Choose provider [1]: "
  read -r PROVIDER_CHOICE

  # Ensure .env.local exists with runtime
  if [ ! -f .env.local ]; then
    echo "SANDBOX_RUNTIME=$RUNTIME" > .env.local
  fi

  case "$PROVIDER_CHOICE" in
    2)
      echo ""
      echo -n "    AWS Access Key ID: "
      read -r AWS_KEY_ID
      echo -n "    AWS Secret Access Key: "
      read -r AWS_SECRET
      echo -n "    AWS Region [us-east-1]: "
      read -r AWS_REG
      AWS_REG="${AWS_REG:-us-east-1}"

      if [ -z "$AWS_KEY_ID" ] || [ -z "$AWS_SECRET" ]; then
        fail "AWS credentials are required for Bedrock."
      fi

      echo "LLM_PROVIDER=bedrock" >> .env.local
      echo "AWS_ACCESS_KEY_ID=$AWS_KEY_ID" >> .env.local
      echo "AWS_SECRET_ACCESS_KEY=$AWS_SECRET" >> .env.local
      echo "AWS_REGION=$AWS_REG" >> .env.local
      ok "Bedrock credentials saved to .env.local"
      ;;
    3)
      echo ""
      echo -n "    GCP Project ID: "
      read -r GCP_PROJECT
      echo -n "    GCP Location [us-east5]: "
      read -r GCP_LOC
      GCP_LOC="${GCP_LOC:-us-east5}"

      if [ -z "$GCP_PROJECT" ]; then
        fail "GOOGLE_VERTEX_PROJECT is required for Vertex AI."
      fi

      echo "LLM_PROVIDER=vertex" >> .env.local
      echo "GOOGLE_VERTEX_PROJECT=$GCP_PROJECT" >> .env.local
      echo "GOOGLE_VERTEX_LOCATION=$GCP_LOC" >> .env.local
      ok "Vertex AI credentials saved to .env.local"
      ;;
    4)
      echo ""
      echo -n "    Base URL (e.g. http://localhost:11434/v1): "
      read -r OAI_BASE_URL
      echo -n "    API Key (press Enter to skip for Ollama): "
      read -r OAI_API_KEY
      echo -n "    Model name (e.g. llama3.3): "
      read -r OAI_MODEL

      if [ -z "$OAI_BASE_URL" ]; then
        fail "OPENAI_BASE_URL is required for OpenAI-compatible."
      fi
      if [ -z "$OAI_MODEL" ]; then
        fail "OPENAI_MODEL is required for OpenAI-compatible."
      fi

      echo "LLM_PROVIDER=openai-compatible" >> .env.local
      echo "OPENAI_BASE_URL=$OAI_BASE_URL" >> .env.local
      [ -n "$OAI_API_KEY" ] && echo "OPENAI_API_KEY=$OAI_API_KEY" >> .env.local
      echo "OPENAI_MODEL=$OAI_MODEL" >> .env.local
      ok "OpenAI-compatible credentials saved to .env.local"
      ;;
    5)
      # Detect platform and suggest the best local backend
      IS_APPLE_SILICON=false
      if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
        IS_APPLE_SILICON=true
      fi

      echo ""
      if $IS_APPLE_SILICON; then
        echo -e "    ${GREEN}Apple Silicon detected${RESET} — MLX is recommended for best performance."
        echo -e "    You can configure your local backend in ${BOLD}Settings → Local Models${RESET} after launch."
      else
        echo -e "    You can configure your local backend in ${BOLD}Settings → Local Models${RESET} after launch."
        echo -e "    Recommended: ${BOLD}Ollama${RESET} or ${BOLD}llama.cpp${RESET}"
      fi

      # Check for dependencies
      if $IS_APPLE_SILICON; then
        if command -v python3 &>/dev/null && python3 -c "import mlx" 2>/dev/null; then
          ok "MLX framework detected"
        else
          warn "MLX not installed — you can install it later from Settings"
          echo -e "      ${DIM}pip install mlx-lm${RESET}"
        fi
      fi

      if command -v ollama &>/dev/null; then
        ok "Ollama detected"
      fi

      # No env vars needed — provider is configured in-app via runtime config
      ok "Local models will be configured in Settings after launch"
      HAS_LLM_CREDS=true  # skip credential failure
      ;;
    *)
      echo ""
      echo -e "    Get an API key at: ${BLUE}https://console.anthropic.com/settings/keys${RESET}"
      echo ""
      API_KEY="${1:-${ANTHROPIC_API_KEY:-}}"
      if [ -z "$API_KEY" ]; then
        echo -n "    Paste your API key: "
        read -r API_KEY
        echo ""
      fi
      if [ -z "$API_KEY" ]; then
        fail "No API key provided. Cannot continue."
      fi
      echo "ANTHROPIC_API_KEY=$API_KEY" >> .env.local
      ok "Anthropic API key saved to .env.local"
      ;;
  esac
fi

# Ensure SANDBOX_RUNTIME is set in .env.local
if ! grep -q "^SANDBOX_RUNTIME=" .env.local 2>/dev/null; then
  if [ ! -f .env.local ]; then
    echo "SANDBOX_RUNTIME=$RUNTIME" > .env.local
  else
    echo "SANDBOX_RUNTIME=$RUNTIME" >> .env.local
  fi
fi

# ── 5. Install dependencies ──────────────────────────────
step "Installing dependencies"

if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok "node_modules already exists — skipping (delete node_modules to force reinstall)"
else
  npm install --loglevel=error
  ok "Done"
fi

# ── 6. Build sandbox ─────────────────────────────────────
if [ "$RUNTIME" = "docker" ]; then
  step "Building Python sandbox"

  if docker image inspect hermetic-sandbox &>/dev/null; then
    ok "hermetic-sandbox image already exists"
  else
    echo -e "    ${DIM}(first time only — installs Python + data science libs)${RESET}"
    docker build -t hermetic-sandbox ./docker/sandbox/ -q
    ok "Built hermetic-sandbox image"
  fi
elif [ "$RUNTIME" = "microsandbox" ]; then
  step "Preparing microsandbox"

  # Pull custom image if set
  if grep -q "^MICROSANDBOX_IMAGE=" .env.local 2>/dev/null; then
    MSB_IMG=$(grep "^MICROSANDBOX_IMAGE=" .env.local | cut -d= -f2)
    echo -e "    ${DIM}Pulling $MSB_IMG...${RESET}"
    msb pull "$MSB_IMG" 2>/dev/null || true
  fi

  ok "Sandbox will be warmed up after server starts"
fi

# ── 7. Launch ─────────────────────────────────────────────
step "Starting app"

echo ""
echo -e "    ${DIM}Runtime: $RUNTIME${RESET}"

if [ "$RUNTIME" = "microsandbox" ]; then
  # Start dev server in background so we can warm up the sandbox
  npm run dev &
  DEV_PID=$!

  # Wait for server to be ready
  echo -ne "    Waiting for server"
  for i in $(seq 1 30); do
    if curl -s -o /dev/null http://localhost:3000 2>/dev/null; then
      echo ""
      ok "Server is up"
      break
    fi
    echo -n "."
    sleep 1
  done

  # Warm up the sandbox (downloads get-pip.py, installs packages)
  step "Installing Python packages"
  echo -e "    ${DIM}(first time only — installs pandas, numpy, scipy, etc.)${RESET}"

  WARMUP_RESULT=$(curl -s -X POST http://localhost:3000/api/runtimes/warmup 2>/dev/null || echo '{"status":"error"}')
  if echo "$WARMUP_RESULT" | grep -q '"status":"ok"'; then
    ok "Sandbox ready"
  else
    warn "Warmup failed — packages will be installed on first query"
    echo -e "    ${DIM}$WARMUP_RESULT${RESET}"
  fi

  echo ""
  echo -e "    ${GREEN}${BOLD}Ready!${RESET} Opening ${BLUE}http://localhost:3000${RESET}"
  echo -e "    ${DIM}Press Ctrl+C to stop.${RESET}"
  echo ""

  # Open browser
  (open "http://localhost:3000" 2>/dev/null || xdg-open "http://localhost:3000" 2>/dev/null || true) &

  # Forward signals to the dev server and wait
  trap "kill $DEV_PID 2>/dev/null" EXIT INT TERM
  wait $DEV_PID
else
  echo -e "    ${GREEN}${BOLD}Ready!${RESET} Opening ${BLUE}http://localhost:3000${RESET}"
  echo -e "    ${DIM}Press Ctrl+C to stop.${RESET}"
  echo ""

  # Open browser after a short delay (in background)
  (sleep 3 && open "http://localhost:3000" 2>/dev/null || xdg-open "http://localhost:3000" 2>/dev/null || true) &

  exec npm run dev
fi
