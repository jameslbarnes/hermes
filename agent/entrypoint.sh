#!/bin/bash

echo "[entrypoint] Starting Router agent..."
echo "[entrypoint] ANTHROPIC_API_KEY set: $(test -n "$ANTHROPIC_API_KEY" && echo yes || echo no)"
echo "[entrypoint] TELEGRAM_BOT_TOKEN set: $(test -n "$TELEGRAM_BOT_TOKEN" && echo yes || echo no)"
echo "[entrypoint] ROUTER_MCP_URL: ${ROUTER_MCP_URL:-not set}"
echo "[entrypoint] GITHUB_TOKEN set: $(test -n "$GITHUB_TOKEN" && echo yes || echo no)"

ROUTER_MCP_URL="${ROUTER_MCP_URL:-${HERMES_MCP_URL:-http://router:3000/mcp/http}}"
ROUTER_SECRET_KEY="${ROUTER_SECRET_KEY:-${HERMES_SECRET_KEY:-}}"
ROUTER_HANDLE="${ROUTER_HANDLE:-${HERMES_HANDLE:-router}}"
ROUTER_ENABLE_GATEWAY="${ROUTER_ENABLE_GATEWAY:-${HERMES_ENABLE_GATEWAY:-auto}}"
export ROUTER_MCP_URL ROUTER_SECRET_KEY ROUTER_HANDLE ROUTER_ENABLE_GATEWAY

# Use the shared persistent volume for agent state
ROUTER_HOME="${ROUTER_HOME:-${HERMES_HOME:-/data/router-agent}}"
# The upstream agent CLI still uses HERMES_HOME.
HERMES_HOME="$ROUTER_HOME"
export ROUTER_HOME HERMES_HOME
mkdir -p "$ROUTER_HOME/skills" "$ROUTER_HOME/sessions"

echo "[entrypoint] ROUTER_HOME: $ROUTER_HOME"
echo "[entrypoint] /data writable: $(test -w /data && echo yes || echo no)"
echo "[entrypoint] /data contents: $(ls /data 2>&1)"

if [ -f "$ROUTER_HOME/config.yaml" ]; then
  echo "[entrypoint] config.yaml EXISTS — checking for persisted state"
  # Check if home channel is saved
  if grep -q "HOME_CHANNEL" "$ROUTER_HOME/config.yaml" 2>/dev/null; then
    echo "[entrypoint] Home channel FOUND in config — will preserve it"
  fi
else
  echo "[entrypoint] config.yaml NOT FOUND — fresh install"
fi

if [ -f "$ROUTER_HOME/state.db" ]; then
  echo "[entrypoint] state.db EXISTS — memory persisted"
else
  echo "[entrypoint] state.db NOT FOUND — fresh state"
fi
echo "[entrypoint] Existing skills: $(ls $ROUTER_HOME/skills 2>/dev/null || echo none)"

# Bootstrap a stable Router notebook identity.
# Order of precedence:
#   1. ROUTER_SECRET_KEY from env
#   2. persisted key in /data/router-agent/secret_key
#   3. generate once, register the configured handle, persist to disk
IDENTITY_ENV=$(mktemp)
if ! python3 /app/bootstrap_identity.py > "$IDENTITY_ENV"; then
  rm -f "$IDENTITY_ENV"
  exit 1
fi
# shellcheck disable=SC1090
. "$IDENTITY_ENV"
rm -f "$IDENTITY_ENV"

echo "[entrypoint] ROUTER_SECRET_KEY set: $(test -n "$ROUTER_SECRET_KEY" && echo yes || echo no)"
echo "[entrypoint] ROUTER_SECRET_KEY source: ${ROUTER_SECRET_KEY_SOURCE:-unknown}"
echo "[entrypoint] Router agent handle: ${ROUTER_AGENT_HANDLE:-unknown}"
echo "[entrypoint] ROUTER_ENABLE_GATEWAY: ${ROUTER_ENABLE_GATEWAY:-auto}"

# Write secrets to .env
cat > "$ROUTER_HOME/.env" << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
GITHUB_TOKEN=${GITHUB_TOKEN}
GH_TOKEN=${GITHUB_TOKEN}
GATEWAY_ALLOW_ALL_USERS=true
EOF

# Export secrets with _ROUTER_FORCE_ prefix to bypass terminal sandbox sanitizer
export GITHUB_TOKEN
export GH_TOKEN="${GITHUB_TOKEN}"
export _ROUTER_FORCE_GITHUB_TOKEN="${GITHUB_TOKEN}"
export _ROUTER_FORCE_GH_TOKEN="${GITHUB_TOKEN}"
export _ROUTER_FORCE_TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
# Compatibility for the upstream CLI and existing terminal sandbox rules.
export HERMES_SECRET_KEY="${ROUTER_SECRET_KEY}"
export HERMES_MCP_URL="${ROUTER_MCP_URL}"
export _HERMES_FORCE_GITHUB_TOKEN="${GITHUB_TOKEN}"
export _HERMES_FORCE_GH_TOKEN="${GITHUB_TOKEN}"
export _HERMES_FORCE_TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
echo "[entrypoint] Wrote .env"

# Merge MCP config into existing config.yaml (preserve gateway state like home channel)
MCP_URL="${ROUTER_MCP_URL}?key=${ROUTER_SECRET_KEY}"
python3 -c "
import yaml, os
config_path = os.path.join('$ROUTER_HOME', 'config.yaml')
config = {}
if os.path.exists(config_path):
    with open(config_path) as f:
        config = yaml.safe_load(f) or {}

# Update model and MCP settings (we control these)
config['model'] = {'provider': 'anthropic', 'model': 'claude-opus-4-6', 'temperature': 0.7, 'max_turns': 90}
config['mcp_servers'] = {'router': {'url': '$MCP_URL'}}
config['skills_dir'] = '$ROUTER_HOME/skills'

# Hide tool use from Telegram messages
if 'display' not in config:
    config['display'] = {}
config['display']['tool_progress'] = 'off'

# Forward secrets into the terminal sandbox (Docker-in-Docker)
if 'terminal' not in config:
    config['terminal'] = {}
config['terminal']['docker_forward_env'] = ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']

# Set gateway defaults only if not already configured
if 'gateway' not in config:
    config['gateway'] = {}
gw = config['gateway']
if 'group_sessions_per_user' not in gw:
    gw['group_sessions_per_user'] = False
if 'default_reset_policy' not in gw:
    gw['default_reset_policy'] = {'mode': 'idle', 'idle_minutes': 1440}
if 'streaming' not in gw:
    gw['streaming'] = {'enabled': True}

with open(config_path, 'w') as f:
    yaml.dump(config, f, default_flow_style=False)
print('[entrypoint] Merged config.yaml (preserved existing gateway state)')
"

# Skills: copy defaults only if they don't already exist
for skill_dir in /app/defaults/skills/*/; do
  skill_name=$(basename "$skill_dir")
  if [ ! -d "$ROUTER_HOME/skills/$skill_name" ]; then
    cp -r "$skill_dir" "$ROUTER_HOME/skills/$skill_name"
    echo "[entrypoint] Installed default skill: $skill_name"
  fi
done

should_start_gateway() {
  local mode="${ROUTER_ENABLE_GATEWAY:-auto}"
  case "$mode" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    0|false|FALSE|no|NO|off|OFF)
      return 1
      ;;
    auto|AUTO|"")
      test -n "$TELEGRAM_BOT_TOKEN"
      return
      ;;
    *)
      echo "[entrypoint] Unknown ROUTER_ENABLE_GATEWAY=$mode, defaulting to auto"
      test -n "$TELEGRAM_BOT_TOKEN"
      return
      ;;
  esac
}

if should_start_gateway; then
  echo "[entrypoint] Starting gateway in background..."
  (
    hermes gateway run --verbose 2>&1 || \
      echo "[entrypoint] Gateway exited (continuing with direct MCP event worker)"
  ) &
else
  echo "[entrypoint] Gateway disabled for this deployment"
fi

echo "[entrypoint] Starting direct MCP event worker..."
exec node /app/router_event_worker.mjs
