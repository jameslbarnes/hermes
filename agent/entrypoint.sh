#!/bin/bash
set -e

# Write secrets to .env (gateway reads from here)
cat > /root/.hermes/.env << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
GITHUB_TOKEN=${GITHUB_TOKEN}
GATEWAY_ALLOW_ALL_USERS=true
EOF

# Merge defaults with existing state — never overwrite agent-learned state
cp /app/defaults/config.yaml /root/.hermes/config.yaml

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

# Morning digest: Opus, daily at 13:00 UTC
hermes cron create "0 13 * * *" \
  --name "morning-digest" \
  --deliver telegram \
  --skill morning-digest \
  "Compose a morning digest of yesterday's notebook activity." 2>/dev/null || true

# Content moderation runs server-side (Haiku, inline in the staging pipeline).
# No cron job needed — every entry is evaluated before it enters the buffer.

# Start the gateway — blocks forever
exec hermes gateway run
