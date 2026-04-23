#!/bin/bash

echo "[entrypoint] Starting Hermes agent..."
echo "[entrypoint] ANTHROPIC_API_KEY set: $(test -n "$ANTHROPIC_API_KEY" && echo yes || echo no)"
echo "[entrypoint] TELEGRAM_BOT_TOKEN set: $(test -n "$TELEGRAM_BOT_TOKEN" && echo yes || echo no)"
echo "[entrypoint] HERMES_MCP_URL: ${HERMES_MCP_URL:-not set}"
echo "[entrypoint] GITHUB_TOKEN set: $(test -n "$GITHUB_TOKEN" && echo yes || echo no)"

# Use the shared persistent volume for agent state
HERMES_HOME=/data/hermes-agent
export HERMES_HOME
mkdir -p "$HERMES_HOME/skills" "$HERMES_HOME/sessions"

echo "[entrypoint] HERMES_HOME: $HERMES_HOME"
echo "[entrypoint] /data writable: $(test -w /data && echo yes || echo no)"
echo "[entrypoint] /data contents: $(ls /data 2>&1)"

if [ -f "$HERMES_HOME/config.yaml" ]; then
  echo "[entrypoint] config.yaml EXISTS — checking for persisted state"
  # Check if home channel is saved
  if grep -q "HOME_CHANNEL" "$HERMES_HOME/config.yaml" 2>/dev/null; then
    echo "[entrypoint] Home channel FOUND in config — will preserve it"
  fi
else
  echo "[entrypoint] config.yaml NOT FOUND — fresh install"
fi

if [ -f "$HERMES_HOME/state.db" ]; then
  echo "[entrypoint] state.db EXISTS — memory persisted"
else
  echo "[entrypoint] state.db NOT FOUND — fresh state"
fi
echo "[entrypoint] Existing skills: $(ls $HERMES_HOME/skills 2>/dev/null || echo none)"

# Bootstrap a stable Hermes notebook identity.
# Order of precedence:
#   1. HERMES_SECRET_KEY from env
#   2. persisted key in /data/hermes-agent/secret_key
#   3. generate once, register the configured handle, persist to disk
IDENTITY_ENV=$(mktemp)
if ! python3 /app/bootstrap_identity.py > "$IDENTITY_ENV"; then
  rm -f "$IDENTITY_ENV"
  exit 1
fi
# shellcheck disable=SC1090
. "$IDENTITY_ENV"
rm -f "$IDENTITY_ENV"

echo "[entrypoint] HERMES_SECRET_KEY set: $(test -n "$HERMES_SECRET_KEY" && echo yes || echo no)"
echo "[entrypoint] HERMES_SECRET_KEY source: ${HERMES_SECRET_KEY_SOURCE:-unknown}"
echo "[entrypoint] HERMES agent handle: ${HERMES_AGENT_HANDLE:-unknown}"
echo "[entrypoint] HERMES_ENABLE_GATEWAY: ${HERMES_ENABLE_GATEWAY:-auto}"

# Write secrets to .env
cat > "$HERMES_HOME/.env" << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
GITHUB_TOKEN=${GITHUB_TOKEN}
GH_TOKEN=${GITHUB_TOKEN}
GATEWAY_ALLOW_ALL_USERS=true
EOF

# Export secrets with _HERMES_FORCE_ prefix to bypass terminal sandbox sanitizer
export GITHUB_TOKEN
export GH_TOKEN="${GITHUB_TOKEN}"
export _HERMES_FORCE_GITHUB_TOKEN="${GITHUB_TOKEN}"
export _HERMES_FORCE_GH_TOKEN="${GITHUB_TOKEN}"
export _HERMES_FORCE_TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
echo "[entrypoint] Wrote .env"

# Merge MCP config into existing config.yaml (preserve gateway state like home channel)
MCP_URL="${HERMES_MCP_URL:-http://hermes:3000/mcp/http}?key=${HERMES_SECRET_KEY}"
python3 -c "
import yaml, os
config_path = os.path.join('$HERMES_HOME', 'config.yaml')
config = {}
if os.path.exists(config_path):
    with open(config_path) as f:
        config = yaml.safe_load(f) or {}

# Update model and MCP settings (we control these)
config['model'] = {'provider': 'anthropic', 'model': 'claude-opus-4-6', 'temperature': 0.7, 'max_turns': 90}
config['mcp_servers'] = {'hermes': {'url': '$MCP_URL'}}
config['skills_dir'] = '$HERMES_HOME/skills'

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
  if [ ! -d "$HERMES_HOME/skills/$skill_name" ]; then
    cp -r "$skill_dir" "$HERMES_HOME/skills/$skill_name"
    echo "[entrypoint] Installed default skill: $skill_name"
  fi
done

should_start_gateway() {
  local mode="${HERMES_ENABLE_GATEWAY:-auto}"
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
      echo "[entrypoint] Unknown HERMES_ENABLE_GATEWAY=$mode, defaulting to auto"
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
