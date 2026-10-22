import { execFile } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"

const xdgCache = process.env.XDG_CACHE_HOME
const CACHE_DIR = join(xdgCache && isAbsolute(xdgCache) ? xdgCache : join(homedir(), ".cache"), "opencode-kiro-auth")
const MODELS_CACHE_PATH = join(CACHE_DIR, "models.json")
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MODELS_FETCH_TIMEOUT_MS = 20_000
const MODELS_RETRY_MS = 5 * 60 * 1000

export type KiroModel = { id: string; name: string; description: string; context: number; multiplier: number }
type ModelsCache = { version: 1; fetchedAt: number; models: KiroModel[] }

export const FALLBACK_MODELS: KiroModel[] = [
  { id: "auto", name: "auto", description: "Kiro picks the model", context: 1_000_000, multiplier: 1 },
]

const str = (v: unknown, d: string) => (typeof v === "string" ? v : d)
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)

// Parses `kiro-cli chat --list-models --format json`. The JSON object may be surrounded by
// non-JSON lines (banners, warnings), so try every line-start "{" against every line-end "}".
// context 0 = kiro-cli did not report a window.
export function parseModelList(stdout: string): KiroModel[] {
  const starts = [...stdout.matchAll(/^[ \t]*\{/gm)].map((m) => m.index!)
  const ends = [...stdout.matchAll(/\}[ \t]*\r?$/gm)].map((m) => m.index! + 1).reverse()
  for (const s of starts)
    for (const e of ends) {
      if (e <= s) break
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout.slice(s, e))
      } catch {
        continue
      }
      const list = (parsed as { models?: unknown })?.models
      if (!Array.isArray(list)) continue
      return list.flatMap((m) => {
        const id = m?.model_id
        if (typeof id !== "string" || !id) return []
        return [{ id, name: str(m.model_name, id), description: str(m.description, ""), context: num(m.context_window_tokens, 0), multiplier: num(m.rate_multiplier, 1) }]
      })
    }
  return []
}

function loadCache(): ModelsCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8")) as ModelsCache
    if (raw?.version === 1 && typeof raw.fetchedAt === "number" && Array.isArray(raw.models) && raw.models.length) return raw
  } catch {
    // no cache yet, or corrupt — ignore
  }
  return undefined
}

function saveCache(models: KiroModel[]) {
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${MODELS_CACHE_PATH}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, fetchedAt: Date.now(), models } satisfies ModelsCache), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, MODELS_CACHE_PATH)
}

let refreshing: Promise<KiroModel[] | undefined> | undefined
let lastFailure = 0

function refresh(): Promise<KiroModel[] | undefined> {
  return (refreshing ??= promisify(execFile)(process.env.KIRO_CLI || "kiro-cli", ["chat", "--list-models", "--format", "json"], {
    timeout: MODELS_FETCH_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
  })
    .then(({ stdout }) => {
      const models = parseModelList(stdout)
      if (!models.length) throw new Error("no models in kiro-cli output")
      try {
        saveCache(models)
      } catch {
        // cache dir unwritable — the fresh list still serves this call
      }
      return models
    })
    .catch(() => ((lastFailure = Date.now()), undefined))
    .finally(() => (refreshing = undefined)))
}

// Model list from kiro-cli, cached 24h. A stale cache is returned at once and refreshed in the
// background; only a first run with no cache waits on kiro-cli (max 20 s). Never throws:
// no cache and no kiro-cli (missing, logged out, offline) -> just "auto".
export async function currentModels(): Promise<KiroModel[]> {
  try {
    const cached = loadCache()
    if (cached) {
      if (Date.now() - cached.fetchedAt > MODELS_CACHE_TTL_MS && Date.now() - lastFailure > MODELS_RETRY_MS) void refresh()
      return cached.models
    }
    return (await refresh()) ?? FALLBACK_MODELS
  } catch {
    return FALLBACK_MODELS
  }
}
