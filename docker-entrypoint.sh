#!/bin/sh
# Dispatch on MODE (research §17.1): one image, three roles. `exec` matters — it makes node
# the direct child of tini, so ECS's SIGTERM reaches the process that knows how to drain.
set -e

case "${MODE:-server}" in
  server)  entry="packages/mcp-server/src/main.ts" ;;
  worker)  entry="packages/mcp-server/src/main-worker.ts" ;;
  migrate) entry="packages/mcp-server/src/main-migrate.ts" ;;
  *)
    echo "unknown MODE '${MODE}' (expected server|worker|migrate)" >&2
    exit 64
    ;;
esac

exec node --import tsx "/app/${entry}" "$@"
