#!/bin/bash

echo "[entrypoint] Starting Hermes agent..."
echo "[entrypoint] ANTHROPIC_API_KEY set: $(test -n "$ANTHROPIC_API_KEY" && echo yes || echo no)"
echo "[entrypoint] TELEGRAM_BOT_TOKEN set: $(test -n "$TELEGRAM_BOT_TOKEN" && echo yes || echo no)"
echo "[entrypoint] HERMES_SECRET_KEY set: $(test -n "$HERMES_SECRET_KEY" && echo yes || echo no)"
echo "[entrypoint] HERMES_MCP_URL: ${HERMES_MCP_URL:-not set}"
echo "[entrypoint] GITHUB_TOKEN set: $(test -n "$GITHUB_TOKEN" && echo yes || echo no)"

# Write secrets to .env (gateway reads from here)
cat > /root/.hermes/.env << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
GITHUB_TOKEN=${GITHUB_TOKEN}
GATEWAY_ALLOW_ALL_USERS=true
EOF
echo "[entrypoint] Wrote .env"

# Merge defaults with existing state
cp /app/defaults/config.yaml /root/.hermes/config.yaml
echo "[entrypoint] Copied config.yaml"

# Skills: copy ours only if they don't already exist on the volume
mkdir -p /root/.hermes/skills
for skill_dir in /app/defaults/skills/*/; do
  skill_name=$(basename "$skill_dir")
  if [ ! -d "/root/.hermes/skills/$skill_name" ]; then
    cp -r "$skill_dir" "/root/.hermes/skills/$skill_name"
    echo "[entrypoint] Installed default skill: $skill_name"
  fi
done

# Privacy: clear session logs
rm -rf /root/.hermes/sessions 2>/dev/null || true
mkdir -p /root/.hermes/sessions

# Skip cron setup for now — gateway is the priority
echo "[entrypoint] Starting gateway..."
exec hermes gateway run --verbose 2>&1
