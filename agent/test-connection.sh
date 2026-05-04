#!/bin/bash
# End-to-end test: agent container connects to local notebook server
#
# Usage:
#   1. Start the notebook server: cd server && npm run dev
#   2. Run this script: bash agent/test-connection.sh
#
# What it does:
#   - Generates a secret key and registers a handle for the agent
#   - Runs the agent container with that key
#   - Agent tries to call router_poll_events via MCP
#   - Prints success or failure

set -e

PORT=${PORT:-3000}
SERVER_URL="http://host.docker.internal:${PORT}"

echo "=== Router Agent Connection Test ==="
echo "Server: ${SERVER_URL}"
echo ""

# 1. Generate a secret key
echo "1. Generating agent identity..."
KEY=$(node -e "const {generateSecretKey}=require('./server/dist/identity.js');console.log(generateSecretKey())")
HANDLE="agent_test_$(date +%s | tail -c 7)"
echo "   Key: ${KEY:0:8}..."
echo "   Handle: ${HANDLE}"

# 2. Register the handle
echo "2. Registering handle..."
REG_RESULT=$(curl -s -X POST "${SERVER_URL}/api/identity/register" \
  -H "Content-Type: application/json" \
  -d "{\"secret_key\": \"${KEY}\", \"handle\": \"${HANDLE}\"}")
echo "   ${REG_RESULT}"

# 3. Run the agent container with a simple query
echo "3. Testing agent MCP connection..."
echo "   Running: hermes chat -q 'Call router_poll_events with cursor 0' --provider anthropic -Q --yolo"
echo ""

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -e HERMES_HOME="/root/.router" \
  -e ROUTER_MCP_URL="${SERVER_URL}/mcp/http" \
  -e ROUTER_SECRET_KEY="${KEY}" \
  generalsemantics/teleport-router-agent:test \
  bash -c "
    mkdir -p /root/.router

    # Write the .env file
    echo 'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}' > /root/.router/.env

    # Update config with resolved URL
    cat > /root/.router/config.yaml << 'YAML'
model:
  provider: anthropic
  model: claude-opus-4-6
  temperature: 0.7

mcp_servers:
  router:
    url: \"${ROUTER_MCP_URL}?key=${ROUTER_SECRET_KEY}\"
YAML

    # Run a single query to test the connection
    hermes chat -q 'List available tools by calling list_tools, then call router_poll_events with cursor 0. Report what tools you see and what events you get.' \
      --provider anthropic \
      -Q --yolo
  "

echo ""
echo "=== Test Complete ==="
