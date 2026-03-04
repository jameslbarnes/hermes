#!/bin/sh
# Fix /data volume permissions if mounted as root
if [ -d /data ] && [ ! -w /data ]; then
  echo "[Entrypoint] Fixing /data permissions for node user..."
  # We need to be root to chown, so this script runs as root
  chown -R node:node /data
fi

# Drop to node user and start the server
exec su-exec node node dist/http.js
