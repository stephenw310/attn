#!/bin/bash
# SessionStart hook for Claude Code on the web: make the container able to
# build, test, and e2e-verify the app before the session begins.
#
# npm's postinstall runs scripts/ensure-electron-toolchain.mjs, which
# self-heals the two things restricted networks break (Electron binary
# download, better-sqlite3 build against Electron's ABI) and verifies the
# result by loading the module inside Electron. Idempotent; cached container
# state makes reruns fast.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

npm install --no-audit --no-fund

# Warm the production bundles so the first `npm run e2e` in-session is quick.
npm run build
