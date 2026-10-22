#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import process from "node:process"

const PKG = "@vidit19sharma/opencode-kiro-auth"
const ENTRY = `${PKG}@latest`

// Other Kiro plugins (exact package names, no version). The unscoped "opencode-kiro-auth" is a different package.
const OTHER_KIRO = ["opencode-kiro-auth", "@zhafron/opencode-kiro-auth", "opencode-kiro-q-auth"]

const HELP = `Usage: npx ${PKG} [setup] [--dry-run] [--config <path>]
       npx ${PKG} update [--dry-run]

setup (default): adds "${ENTRY}" to the "plugin" array of your opencode config.
Idempotent: does nothing if any ${PKG} entry is already present.

update: deletes opencode's cached copy of ${PKG} (opencode never re-resolves
"@latest" once installed), so the next opencode start installs the latest version.
Cache: $XDG_CACHE_HOME/opencode or ~/.cache/opencode.

  --dry-run        print what would change, write/delete nothing
  --config <path>  edit this file instead of the auto-detected one
  --help           show this help

Config lookup: --config, $OPENCODE_CONFIG, then opencode.jsonc / opencode.json in
$OPENCODE_CONFIG_DIR, $XDG_CONFIG_HOME/opencode or ~/.config/opencode.

Exit codes: 0 ok or already installed, 2 cannot edit safely (manual edit printed), 1 error.`

function hasKiroCli(): boolean {
  try {
    execFileSync(process.env.KIRO_CLI || "kiro-cli", ["--version"], { stdio: "ignore", timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

// the model list is read at opencode startup, so log in before restarting
function next(): string {
  const steps = [
    // Official install command: https://kiro.dev/docs/getting-started/installation/ (CLI tab;
    // https://kiro.dev/docs/cli/installation/ redirects there). Windows: irm 'https://cli.kiro.dev/install.ps1' | iex
    ...(hasKiroCli() ? [] : ["Install kiro-cli: curl -fsSL https://cli.kiro.dev/install | bash"]),
    "kiro-cli login",
    "Restart opencode",
    "opencode models | grep kiro/",
  ]
  return `Next steps:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
}

const MANUAL = `Add this to the top-level "plugin" array of your opencode config (create it if missing):
  "plugin": ["${ENTRY}"]`

// Strips // and /* */ comments and trailing commas outside double-quoted strings; does not handle single-quoted strings or other JSON5 syntax.
const stripJsonc = (s: string) =>
  s
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "")
    .replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (_m, str, close) => str ?? close)

// "@scope/name@1.2" -> "@scope/name", "name@latest" -> "name"
const pkgName = (spec: string) => spec.replace(/(?!^)@.*$/, "")

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

// opencode caches npm plugins in <cache>/packages/<name>@<spec>/ (older: <cache>/npm/) and never re-resolves @latest.
function update(dryRun: boolean): number {
  const xdg = process.env.XDG_CACHE_HOME
  const cache = join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "opencode")
  const [scope, name] = PKG.split("/")
  const dirs = ["packages", "npm"].flatMap((p) => {
    const parent = join(cache, p, scope)
    if (!existsSync(parent)) return []
    return readdirSync(parent)
      .filter((d) => d.startsWith(`${name}@`))
      .map((d) => join(parent, d))
  })
  if (!dirs.length) {
    console.log(`nothing to update: opencode has no cached copy of ${PKG} (it will install the latest version on next start)`)
    return 0
  }
  for (const d of dirs) {
    const pkg = tryParse(readFileSafe(join(d, "node_modules", PKG, "package.json"))) as { version?: unknown } | undefined
    const version = typeof pkg?.version === "string" ? pkg.version : "unknown version"
    if (!dryRun) rmSync(d, { recursive: true, force: true })
    console.log(`${dryRun ? "would remove" : "removed"} cached ${version} at ${d}`)
  }
  if (!dryRun) console.log(`restart opencode — it will install the latest ${PKG} from npm on start`)
  return 0
}

function readFileSafe(f: string): string {
  try {
    return readFileSync(f, "utf8")
  } catch {
    return ""
  }
}

function main(argv: string[]): number {
  let dryRun = false
  let explicit: string | undefined
  let cmd = "setup"
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") return console.log(HELP), 0
    else if (a === "--dry-run") dryRun = true
    else if (a === "--config") explicit = argv[++i]
    else if (a === "setup" || a === "update") cmd = a
    else return console.error(`Unknown argument: ${a}\n\n${HELP}`), 1
  }
  if (argv.includes("--config") && !explicit) return console.error("--config needs a path"), 1
  if (cmd === "update") return update(dryRun)

  const env = process.env
  const dir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  const file = resolve(
    explicit ||
      env.OPENCODE_CONFIG ||
      ["opencode.jsonc", "opencode.json"].map((f) => join(dir, f)).find((f) => existsSync(f)) ||
      join(dir, "opencode.json"),
  )

  const exists = existsSync(file)
  const original = exists ? readFileSync(file, "utf8") : ""
  const strict = exists ? tryParse(original) : { $schema: "https://opencode.ai/config.json" }
  const config = (strict ?? tryParse(stripJsonc(original))) as Record<string, unknown> | undefined
  console.log(`Config: ${file}${exists ? "" : " (will be created)"}`)

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    console.error(`Cannot parse ${file}; not editing it.\n${MANUAL}`)
    return 2
  }

  const plugins = config.plugin ?? []
  if (!Array.isArray(plugins)) {
    console.error(`"plugin" in ${file} is not an array; not editing it.\n${MANUAL}`)
    return 2
  }

  const others = plugins.filter((p): p is string => typeof p === "string" && OTHER_KIRO.includes(pkgName(p)))
  if (others.length)
    console.log(
      `Warning: other Kiro plugin(s) found in "plugin" (left in place). They call Kiro's private API with scraped tokens,\n` +
        `which risks breaking Kiro's terms and getting your account suspended, and may claim the same "kiro" provider.\n` +
        `To remove, delete these entries from "plugin" in ${file}:\n${others.map((p) => `  - ${JSON.stringify(p)}`).join("\n")}`,
    )

  if (plugins.some((p) => typeof p === "string" && pkgName(p) === PKG)) {
    console.log(`Already installed: ${PKG} is in "plugin". File left untouched.\n\n${next()}`)
    return 0
  }
  if (strict === undefined) {
    console.error(`${file} has comments or trailing commas; not rewriting it (that would drop them).\n${MANUAL}`)
    return 2
  }

  config.plugin = [...plugins, ENTRY]
  const json = JSON.stringify(config, null, 2) + "\n"
  if (dryRun) {
    console.log(`Dry run: would ${exists ? "update" : "create"} ${file} with:\n${json}`)
    return 0
  }
  mkdirSync(dirname(file), { recursive: true })
  // keep the file's perms (it may hold API keys) and edit a symlinked config at its target
  const target = exists ? realpathSync(file) : file
  const mode = exists ? statSync(target).mode & 0o777 : 0o600
  const write = (f: string, data: string) => (writeFileSync(f, data, { mode }), chmodSync(f, mode))
  if (exists) write(`${file}.bak-kiro-auth`, original)
  write(`${target}.tmp`, json)
  renameSync(`${target}.tmp`, target)
  console.log(`Added "${ENTRY}" to "plugin"${exists ? ` (backup: ${file}.bak-kiro-auth)` : ""}.\n\n${next()}`)
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  console.error(`Unexpected error: ${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
}
