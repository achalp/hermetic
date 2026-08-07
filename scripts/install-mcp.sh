#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
#  Hermetic MCP installer — connect hermetic to Claude
#  Desktop and/or Claude Code: detect, prompt, install.
#
#  Standalone:      ./scripts/install-mcp.sh
#  From start.sh:   sourced helpers not required; called as a subprocess.
#
#  What it does per target:
#   - Claude Code:  the repo's project-scoped .mcp.json already auto-prompts
#     when `claude` is opened in this checkout; this script additionally
#     offers USER-scope registration so the tools work from any directory.
#   - Claude Desktop: merges the hermetic server into
#     claude_desktop_config.json (real JSON merge — other servers preserved,
#     timestamped backup written first, never clobbers on parse failure).
#  Plus the one build prerequisite the server needs: the embedded viewer.
# ─────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'
ok()   { echo -e "    ${GREEN}✓${RESET} $1"; }
warn() { echo -e "    ${YELLOW}!${RESET} $1"; }
fail() { echo -e "    ${RED}✗ $1${RESET}"; exit 1; }

command -v node &>/dev/null || fail "node is required (run ./start.sh first)"

# ── Prerequisites: deps + viewer bundle ───────────────────
if [ ! -d node_modules ]; then
  warn "node_modules missing — running pnpm install"
  PNPM="pnpm"; command -v pnpm &>/dev/null || PNPM="corepack pnpm"
  $PNPM install --frozen-lockfile || $PNPM install
fi
if [ ! -f src/mcp/viewer/dist/viewer.html ]; then
  echo -e "    ${DIM}Building the embedded dashboard viewer (one-time)…${RESET}"
  PNPM="pnpm"; command -v pnpm &>/dev/null || PNPM="corepack pnpm"
  $PNPM mcp:build-viewer >/dev/null 2>&1 && ok "Viewer bundle built" || warn "Viewer build failed — dashboard links won't render until 'pnpm mcp:build-viewer' succeeds"
else
  ok "Viewer bundle present"
fi

INSTALLED_ANY=false

# ── Claude Desktop ────────────────────────────────────────
desktop_config_path() {
  case "$(uname -s)" in
    Darwin) echo "$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
    Linux)  echo "${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json" ;;
    MINGW*|MSYS*|CYGWIN*) echo "${APPDATA:-}/Claude/claude_desktop_config.json" ;;
    *) echo "" ;;
  esac
}

DESKTOP_CONFIG="$(desktop_config_path)"
if [ -n "$DESKTOP_CONFIG" ] && [ -d "$(dirname "$DESKTOP_CONFIG")" ]; then
  echo ""
  echo -en "    Connect hermetic to ${BOLD}Claude Desktop${RESET}? [Y/n]: "
  read -r DESKTOP_ANSWER || DESKTOP_ANSWER="n"
  if [ -z "$DESKTOP_ANSWER" ] || [[ "$DESKTOP_ANSWER" =~ ^[Yy] ]]; then
    # Merge with node (guaranteed present): preserves every other key and
    # server in the file. A corrupt existing config aborts the merge rather
    # than being replaced — the same missing≠corrupt rule the app's stores
    # follow.
    if RESULT=$(node -e '
      const fs = require("fs");
      const [, cfgPath, root] = process.argv;
      let cfg = {};
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, "utf8");
        if (raw.trim() !== "") {
          try { cfg = JSON.parse(raw); }
          catch { console.error("CORRUPT"); process.exit(2); }
        }
        const backup = cfgPath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(cfgPath, backup);
      }
      cfg.mcpServers = cfg.mcpServers || {};
      const already = JSON.stringify(cfg.mcpServers.hermetic);
      // pnpm -C <root> pins the working directory in the COMMAND itself —
      // `claude mcp add-json` drops a cwd field, and Desktop support for it
      // varies; this form needs neither. --silent keeps the pnpm script
      // banner ("> tsx ...") off stdout, which is the MCP protocol channel —
      // Claude Desktop rejects those lines as invalid JSON.
      cfg.mcpServers.hermetic = { command: "pnpm", args: ["--silent", "-C", root, "mcp"] };
      fs.mkdirSync(require("path").dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
      console.log(already === JSON.stringify(cfg.mcpServers.hermetic) ? "UNCHANGED" : "WRITTEN");
    ' "$DESKTOP_CONFIG" "$ROOT" 2>&1); then
      case "$RESULT" in
        WRITTEN)   ok "Claude Desktop configured ${DIM}($DESKTOP_CONFIG)${RESET}"
                   warn "Restart Claude Desktop to pick it up" ;;
        UNCHANGED) ok "Claude Desktop already configured" ;;
      esac
      INSTALLED_ANY=true
    else
      warn "Existing Desktop config did not parse — left untouched. Fix it, then re-run: ./scripts/install-mcp.sh"
    fi
  else
    ok "Skipped Claude Desktop"
  fi
else
  echo -e "    ${DIM}Claude Desktop not detected — skipping.${RESET}"
fi

# ── Claude Code ───────────────────────────────────────────
# User scope is the default on purpose: the analysis room matters most in
# OTHER directories — where your data lives — and project scope evaporates
# outside this checkout. The repo's .mcp.json still covers demo/dev use
# here with zero config either way.
if command -v claude &>/dev/null; then
  echo ""
  echo -e "    ${DIM}Inside this checkout, Claude Code auto-prompts via the repo's .mcp.json.${RESET}"
  echo -en "    Register ${BOLD}user-wide${RESET} so the tools work from ${BOLD}any${RESET} directory? [Y/n]: "
  read -r CODE_ANSWER || CODE_ANSWER="n"
  if [ -z "$CODE_ANSWER" ] || [[ "$CODE_ANSWER" =~ ^[Yy] ]]; then
    if claude mcp add-json hermetic \
        "{\"command\":\"pnpm\",\"args\":[\"--silent\",\"-C\",\"$ROOT\",\"mcp\"]}" \
        --scope user >/dev/null 2>&1; then
      ok "Claude Code (user scope) configured — available in every directory"
    else
      warn "claude mcp add-json failed — register manually: claude mcp add-json hermetic '{\"command\":\"pnpm\",\"args\":[\"--silent\",\"-C\",\"$ROOT\",\"mcp\"]}' --scope user"
    fi
  else
    ok "Skipped — project scope still works inside this checkout"
  fi
  INSTALLED_ANY=true
else
  echo -e "    ${DIM}Claude Code (claude CLI) not detected — skipping.${RESET}"
fi

echo ""
if $INSTALLED_ANY; then
  echo -e "    ${GREEN}${BOLD}MCP setup done.${RESET} Your agent asks; your data stays home."
  echo -e "    ${DIM}Docs: docs/mcp.md — tools, trust model, observability.${RESET}"
else
  echo -e "    ${DIM}Neither Claude Desktop nor Claude Code found. Install one, then re-run:${RESET}"
  echo -e "    ${DIM}  ./scripts/install-mcp.sh${RESET}"
fi
