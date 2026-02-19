#!/bin/bash
set -e

DIST=/app/dist

# Dev mode: if host-mounted source is newer than the image build, recompile.
# This only happens when container-runner mounts /app/src from the host.
if [ -f /app/.build_stamp ]; then
  BUILD_TS=$(cat /app/.build_stamp)
  # Find newest .ts file under /app/src
  NEWEST_SRC=$(find /app/src -name '*.ts' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)
  if [ -n "$NEWEST_SRC" ] && [ "$NEWEST_SRC" -gt "$BUILD_TS" ]; then
    DIST=/tmp/dist
    cd /app && npx tsc --outDir "$DIST" 2>&1 >&2
    ln -s /app/node_modules "$DIST/node_modules"
    chmod -R a-w "$DIST"
  fi
fi

cat > /tmp/input.json
node "$DIST/index.js" < /tmp/input.json
