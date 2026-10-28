#!/usr/bin/env bash
set -euo pipefail
BUN="$(command -v bun)"
NODE="$(command -v node)"
BASE="$("$BUN" "$(dirname "$0")/qa-paths.ts")"
ROOT="$(mktemp -d "$BASE/kiro-offline.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
env -i PATH="$(dirname "$BUN"):$(dirname "$NODE"):/usr/bin:/bin" KIRO_QA_ARTIFACTS="$ROOT" \
  "$BUN" test spike/qa-paths.test.ts
for suite in models plugin bridge acp mcp; do
  mkdir -p "$ROOT/$suite/home" "$ROOT/$suite/tmp"
  env -i PATH="$(dirname "$BUN"):$(dirname "$NODE"):/usr/bin:/bin" \
    HOME="$ROOT/$suite/home" XDG_CONFIG_HOME="$ROOT/$suite/config" \
    XDG_DATA_HOME="$ROOT/$suite/data" XDG_CACHE_HOME="$ROOT/$suite/cache" \
    XDG_STATE_HOME="$ROOT/$suite/state" TMPDIR="$ROOT/$suite/tmp" \
    KIRO_CLI="$ROOT/missing-kiro-cli" "$BUN" test "spike/$suite.test.ts"
done
env -i PATH="$(dirname "$NODE"):/usr/bin:/bin" HOME="$ROOT/home" TMPDIR="$ROOT" \
  bash spike/cli-setup.test.sh
env -i PATH="$(dirname "$BUN"):$(dirname "$NODE"):/usr/bin:/bin" HOME="$ROOT/home" TMPDIR="$ROOT" \
  "$BUN" test spike/package-entry.test.ts
env -i PATH="$(dirname "$BUN"):$(dirname "$NODE"):/usr/bin:/bin" HOME="$ROOT/home" TMPDIR="$ROOT" KIRO_QA_ARTIFACTS="$ROOT" \
  "$BUN" test spike/package-flow.test.ts
env -i PATH="$(dirname "$BUN"):$(dirname "$NODE"):/usr/bin:/bin" HOME="$ROOT/home" TMPDIR="$ROOT" KIRO_QA_ARTIFACTS="$ROOT" \
  "$BUN" test spike/live-smoke.test.ts
