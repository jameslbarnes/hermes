#!/bin/bash

echo "[entrypoint] Starting Hermes agent..."
echo "[entrypoint] ANTHROPIC_API_KEY set: $(test -n "$ANTHROPIC_API_KEY" && echo yes || echo no)"
echo "[entrypoint] TELEGRAM_BOT_TOKEN set: $(test -n "$TELEGRAM_BOT_TOKEN" && echo yes || echo no)"
echo "[entrypoint] HERMES_SECRET_KEY set: $(test -n "$HERMES_SECRET_KEY" && echo yes || echo no)"
echo "[entrypoint] HERMES_MCP_URL: ${HERMES_MCP_URL:-not set}"
echo "[entrypoint] GITHUB_TOKEN set: $(test -n "$GITHUB_TOKEN" && echo yes || echo no)"

# Use the shared persistent volume for agent state
# /data is the hermes-data volume that survives deploys
HERMES_HOME=/data/hermes-agent
export HERMES_HOME
mkdir -p "$HERMES_HOME/skills" "$HERMES_HOME/sessions"

echo "[entrypoint] HERMES_HOME: $HERMES_HOME"
echo "[entrypoint] /data writable: $(test -w /data && echo yes || echo no)"
echo "[entrypoint] /data contents: $(ls /data 2>&1)"
if [ -f "$HERMES_HOME/gateway.json" ]; then
  echo "[entrypoint] gateway.json EXISTS — state persisted from previous run"
else
  echo "[entrypoint] gateway.json NOT FOUND — fresh state"
fi
if [ -f "$HERMES_HOME/state.db" ]; then
  echo "[entrypoint] state.db EXISTS — memory persisted from previous run"
else
  echo "[entrypoint] state.db NOT FOUND — fresh state"
fi
echo "[entrypoint] Existing skills: $(ls $HERMES_HOME/skills 2>/dev/null || echo none)"

# Write secrets to .env
cat > "$HERMES_HOME/.env" << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
GITHUB_TOKEN=${GITHUB_TOKEN}
GATEWAY_ALLOW_ALL_USERS=true
EOF
echo "[entrypoint] Wrote .env"

# Write config with resolved env vars
MCP_URL="${HERMES_MCP_URL:-http://hermes:3000/mcp/http}?key=${HERMES_SECRET_KEY}"
cat > "$HERMES_HOME/config.yaml" << EOF
model:
  provider: anthropic
  model: claude-opus-4-6
  temperature: 0.7
  max_turns: 90

mcp_servers:
  hermes:
    url: "${MCP_URL}"

gateway:
  group_sessions_per_user: false
  default_reset_policy:
    mode: idle
    idle_minutes: 1440
  streaming:
    enabled: true

skills_dir: ${HERMES_HOME}/skills
EOF
echo "[entrypoint] Wrote config.yaml"

# Skills: copy defaults only if they don't already exist
for skill_dir in /app/defaults/skills/*/; do
  skill_name=$(basename "$skill_dir")
  if [ ! -d "$HERMES_HOME/skills/$skill_name" ]; then
    cp -r "$skill_dir" "$HERMES_HOME/skills/$skill_name"
    echo "[entrypoint] Installed default skill: $skill_name"
  fi
done

# Start the gateway
echo "[entrypoint] Starting gateway..."
exec hermes gateway run --verbose 2>&1
