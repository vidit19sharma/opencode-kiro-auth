#!/usr/bin/env bash
set -u
CLI="$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cli-setup.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
unset OPENCODE_CONFIG
export HOME="$ROOT/home" XDG_CONFIG_HOME="$ROOT/xdg" XDG_CACHE_HOME="$ROOT/xdg-cache"
# never probe the real kiro-cli: default to a missing binary, case 13 swaps in a fake
export KIRO_CLI="$ROOT/no-such-kiro-cli"
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
run() { OUT="$(node "$CLI" "$@" 2>&1)"; CODE=$?; }

echo "== 1. no config -> creates opencode.json"
export OPENCODE_CONFIG_DIR="$ROOT/c1/nested"
run setup
check "exit 0" '[ $CODE -eq 0 ]'
cat >"$ROOT/c1.expected" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@vidit19sharma/opencode-kiro-auth@latest"
  ]
}
EOF
check "file content (exact, trailing newline)" 'cmp -s "$OPENCODE_CONFIG_DIR/opencode.json" "$ROOT/c1.expected"'
check "no .bak" '[ ! -e "$OPENCODE_CONFIG_DIR/opencode.json.bak-kiro-auth" ]'
check "next steps" 'grep -q "kiro-cli login" <<<"$OUT" && grep -q "grep kiro/" <<<"$OUT"'
check "install step when kiro-cli missing" 'grep -q "1. Install kiro-cli: curl -fsSL https://cli.kiro.dev/install | bash" <<<"$OUT"'

echo "== 2. existing opencode.json with other plugins -> appended"
export OPENCODE_CONFIG_DIR="$ROOT/c2"; mkdir -p "$OPENCODE_CONFIG_DIR"; F="$OPENCODE_CONFIG_DIR/opencode.json"
printf '{"theme":"dark","plugin":["foo@1"],"model":"x/y"}' >"$F"
cp "$F" "$ROOT/c2.orig"
echo "-- 4. --dry-run first"
run setup --dry-run
check "dry-run exit 0" '[ $CODE -eq 0 ]'
check "dry-run no write" 'cmp -s "$F" "$ROOT/c2.orig"'
check "dry-run no bak/tmp" '[ ! -e "$F.bak-kiro-auth" ] && [ ! -e "$F.tmp" ]'
check "dry-run shows plan" 'grep -q "Dry run: would update" <<<"$OUT"'
run
check "exit 0 (no args = setup)" '[ $CODE -eq 0 ]'
check "plugins + key order" '[ "$(node -e "const c=require(process.argv[1]);console.log(Object.keys(c).join()+\"|\"+c.plugin.join())" "$F")" = "theme,plugin,model|foo@1,@vidit19sharma/opencode-kiro-auth@latest" ]'
check ".bak is original" 'cmp -s "$F.bak-kiro-auth" "$ROOT/c2.orig"'
check "no .tmp left" '[ ! -e "$F.tmp" ]'

echo "== 3. run again -> already installed, untouched"
cp "$F" "$ROOT/c2.after"; rm "$F.bak-kiro-auth"
run setup
check "exit 0" '[ $CODE -eq 0 ]'
check "says already installed" 'grep -q "Already installed" <<<"$OUT"'
check "byte-identical" 'cmp -s "$F" "$ROOT/c2.after"'
check "no new .bak" '[ ! -e "$F.bak-kiro-auth" ]'

echo "== 5. opencode.jsonc with comment + trailing comma -> exit 2, untouched"
export OPENCODE_CONFIG_DIR="$ROOT/c5"; mkdir -p "$OPENCODE_CONFIG_DIR"; F="$OPENCODE_CONFIG_DIR/opencode.jsonc"
printf '{\n  // my theme\n  "theme": "a//b",\n  "plugin": ["foo@1",],\n}\n' >"$F"; cp "$F" "$ROOT/c5.orig"
printf '{}' >"$OPENCODE_CONFIG_DIR/opencode.json"
run setup
check "exit 2" '[ $CODE -eq 2 ]'
check "picked .jsonc over .json" 'grep -q "opencode.jsonc" <<<"$OUT"'
check "manual instruction" 'grep -q "\"plugin\": \[\"@vidit19sharma/opencode-kiro-auth@latest\"\]" <<<"$OUT"'
check "untouched" 'cmp -s "$F" "$ROOT/c5.orig" && [ ! -e "$F.bak-kiro-auth" ]'
printf '{\n  // c\n  "plugin": ["@vidit19sharma/opencode-kiro-auth@0.3.1",],\n}\n' >"$F"; cp "$F" "$ROOT/c5b.orig"
run setup
check "jsonc already installed -> exit 0" '[ $CODE -eq 0 ] && grep -q "Already installed" <<<"$OUT" && cmp -s "$F" "$ROOT/c5b.orig"'
printf '{ "plugin": [ oops' >"$F"
run setup
check "garbage -> exit 2" '[ $CODE -eq 2 ] && grep -q "Cannot parse" <<<"$OUT"'

echo "== 6. other Kiro plugins -> warning, never removed"
export OPENCODE_CONFIG_DIR="$ROOT/c6"; mkdir -p "$OPENCODE_CONFIG_DIR"; F="$OPENCODE_CONFIG_DIR/opencode.json"
printf '{"plugin":["opencode-kiro-auth@1.2.3","@zhafron/opencode-kiro-auth","opencode-kiro-q-auth@latest","opencode-kiro-authx","foo@1"]}' >"$F"
run setup
check "exit 0" '[ $CODE -eq 0 ]'
check "warns about private API / ToS" 'grep -q "Warning: other Kiro plugin" <<<"$OUT" && grep -q "scraped tokens" <<<"$OUT" && grep -q "suspended" <<<"$OUT"'
check "lists all three exact matches" 'grep -q "  - \"opencode-kiro-auth@1.2.3\"" <<<"$OUT" && grep -q "  - \"@zhafron/opencode-kiro-auth\"" <<<"$OUT" && grep -q "  - \"opencode-kiro-q-auth@latest\"" <<<"$OUT"'
check "near-miss names not listed" '! grep -q "opencode-kiro-authx" <<<"$OUT" && ! grep -q "\"foo@1\"" <<<"$OUT"'
check "unscoped name is not ours: ours added, others kept" '[ "$(node -e "console.log(require(process.argv[1]).plugin.join())" "$F")" = "opencode-kiro-auth@1.2.3,@zhafron/opencode-kiro-auth,opencode-kiro-q-auth@latest,opencode-kiro-authx,foo@1,@vidit19sharma/opencode-kiro-auth@latest" ]'
export OPENCODE_CONFIG_DIR="$ROOT/c6b"; mkdir -p "$OPENCODE_CONFIG_DIR"; F="$OPENCODE_CONFIG_DIR/opencode.json"
printf '{"plugin":["@vidit19sharma/opencode-kiro-auth@0.1.0"]}' >"$F"
run setup
check "ours alone -> no warning, already installed" '[ $CODE -eq 0 ] && ! grep -q "Warning" <<<"$OUT" && grep -q "Already installed" <<<"$OUT"'
printf '{"plugin":["@vidit19sharma/opencode-kiro-auth-extra"]}' >"$F"
run setup --dry-run
check "prefix-only name is not ours" '[ $CODE -eq 0 ] && grep -q "Dry run: would update" <<<"$OUT"'

echo "== 7. --config <explicit path>"
export OPENCODE_CONFIG_DIR="$ROOT/c7dir"; E="$ROOT/c7/custom.json"; mkdir -p "$ROOT/c7"
printf '{"plugin":[]}' >"$E"
run setup --config "$E"
check "exit 0" '[ $CODE -eq 0 ]'
check "explicit file edited" 'grep -q "opencode-kiro-auth@latest" "$E"'
check "default dir untouched" '[ ! -e "$OPENCODE_CONFIG_DIR" ]'
OPENCODE_CONFIG="$ROOT/c7/env.json" run setup
check "\$OPENCODE_CONFIG honoured" '[ $CODE -eq 0 ] && grep -q "opencode-kiro-auth@latest" "$ROOT/c7/env.json"'

mkcache() { # $1 = cache root, $2 = layout dir (packages|npm), $3 = version
  local D="$1/$2/@vidit19sharma/opencode-kiro-auth@latest"
  mkdir -p "$D/node_modules/@vidit19sharma/opencode-kiro-auth"
  printf '{"dependencies":{"@vidit19sharma/opencode-kiro-auth":"%s"}}' "$3" >"$D/package.json"
  printf '{"name":"@vidit19sharma/opencode-kiro-auth","version":"%s"}' "$3" >"$D/node_modules/@vidit19sharma/opencode-kiro-auth/package.json"
}

echo "== 8. update, no cache dir -> nothing to update"
export XDG_CACHE_HOME="$ROOT/u8/cache"
run update
check "exit 0" '[ $CODE -eq 0 ] && grep -q "nothing to update" <<<"$OUT"'
check "cache not created" '[ ! -e "$XDG_CACHE_HOME" ]'

echo "== 9. update with cached 0.1.0 + unrelated sibling"
export XDG_CACHE_HOME="$ROOT/u9/cache"; C="$XDG_CACHE_HOME/opencode"
mkcache "$C" packages 0.1.0
D="$C/packages/@vidit19sharma/opencode-kiro-auth@latest"; S="$C/packages/opencode-claude-auth@latest"
mkdir -p "$S"; printf '{}' >"$S/package.json"
run update --dry-run
check "dry-run exit 0 + message" '[ $CODE -eq 0 ] && grep -q "would remove cached 0.1.0" <<<"$OUT"'
check "dry-run kept dir" '[ -d "$D" ]'
run update
check "exit 0 + removed + restart" '[ $CODE -eq 0 ] && grep -q "removed cached 0.1.0" <<<"$OUT" && grep -q "restart opencode" <<<"$OUT"'
check "our dir gone" '[ ! -e "$D" ]'
check "sibling kept" '[ -f "$S/package.json" ]'

echo "== 10. update legacy npm/ layout"
export XDG_CACHE_HOME="$ROOT/u10/cache"; C="$XDG_CACHE_HOME/opencode"
mkcache "$C" npm 0.2.0
run update
check "exit 0 + removed legacy" '[ $CODE -eq 0 ] && grep -q "removed cached 0.2.0" <<<"$OUT" && [ ! -e "$C/npm/@vidit19sharma/opencode-kiro-auth@latest" ]'

perm() { node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }

echo "== 11. 0600 config keeps its perms, backup too"
export OPENCODE_CONFIG_DIR="$ROOT/c11"; mkdir -p "$OPENCODE_CONFIG_DIR"; F="$OPENCODE_CONFIG_DIR/opencode.json"
printf '{"provider":{"x":{"options":{"apiKey":"secret"}}}}' >"$F"; chmod 600 "$F"
run setup
check "exit 0" '[ $CODE -eq 0 ] && grep -q "opencode-kiro-auth@latest" "$F"'
check "config still 600" '[ "$(perm "$F")" = 600 ]'
check "backup 600" '[ "$(perm "$F.bak-kiro-auth")" = 600 ]'

echo "== 12. symlinked config edited at its target, link kept"
export OPENCODE_CONFIG_DIR="$ROOT/c12"; mkdir -p "$OPENCODE_CONFIG_DIR" "$ROOT/dotfiles"; F="$OPENCODE_CONFIG_DIR/opencode.json"
printf '{"plugin":[]}' >"$ROOT/dotfiles/opencode.json"; ln -s "$ROOT/dotfiles/opencode.json" "$F"
run setup
check "exit 0" '[ $CODE -eq 0 ]'
check "still a symlink" '[ -L "$F" ]'
check "target edited" 'grep -q "opencode-kiro-auth@latest" "$ROOT/dotfiles/opencode.json"'
check "no .tmp left" '[ ! -e "$ROOT/dotfiles/opencode.json.tmp" ] && [ ! -e "$F.tmp" ]'
check "next steps: install < login < restart < models" '[ "$(grep -n "Install kiro-cli" <<<"$OUT" | cut -d: -f1)" -lt "$(grep -n "kiro-cli login" <<<"$OUT" | cut -d: -f1)" ] && [ "$(grep -n "kiro-cli login" <<<"$OUT" | cut -d: -f1)" -lt "$(grep -n "Restart opencode" <<<"$OUT" | cut -d: -f1)" ] && [ "$(grep -n "Restart opencode" <<<"$OUT" | cut -d: -f1)" -lt "$(grep -n "grep kiro/" <<<"$OUT" | cut -d: -f1)" ]'

echo "== 13. kiro-cli present -> no install step"
export OPENCODE_CONFIG_DIR="$ROOT/c13"; mkdir -p "$OPENCODE_CONFIG_DIR"
printf '#!/bin/sh\necho "kiro-cli 9.9.9"\n' >"$ROOT/fake-kiro-cli"; chmod +x "$ROOT/fake-kiro-cli"
KIRO_CLI="$ROOT/fake-kiro-cli" run setup
check "exit 0" '[ $CODE -eq 0 ]'
check "no install step, login is step 1" '! grep -q "Install kiro-cli" <<<"$OUT" && grep -q "1. kiro-cli login" <<<"$OUT"'

echo "== misc"
run --help; check "--help exit 0" '[ $CODE -eq 0 ] && grep -q "Usage" <<<"$OUT"'
run --bogus; check "unknown arg exit 1" '[ $CODE -eq 1 ]'
check "real HOME/XDG untouched" '[ ! -e "$HOME" ] && [ ! -e "$XDG_CONFIG_HOME" ]'

echo; [ $fails -eq 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
