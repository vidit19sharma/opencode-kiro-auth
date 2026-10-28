import { afterAll, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "kiro-models-"))
process.env.XDG_CACHE_HOME = join(ROOT, "cache")
process.env.KIRO_CLI = join(ROOT, "no-such-kiro-cli")
if (!process.env.XDG_CACHE_HOME.startsWith(ROOT) || !process.env.KIRO_CLI.startsWith(ROOT)) throw new Error("refusing to run unsandboxed")
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const { parseModelList, currentModels, FALLBACK_MODELS } = await import("../src/models.ts")
const CACHE = join(ROOT, "cache", "opencode-kiro-auth", "models.json")
const LOG = join(ROOT, "invocations.log")
const FAKE = join(ROOT, "fake-kiro-cli")

const FIXTURE = `Checking for updates...
{
  "models": [
    {"model_name": "Claude Sonnet 4.5", "description": "Balanced", "model_id": "claude-sonnet-4.5", "context_window_tokens": 200000, "rate_multiplier": 1.3, "rate_unit": "credit", "extra": {"x": 1}},
    {"model_name": "Auto", "description": "Kiro picks", "model_id": "auto", "context_window_tokens": 1000000, "rate_multiplier": 1, "rate_unit": "credit"},
    {"description": "no id, skipped"}
  ],
  "default_model": "auto"
}
{ trailing noise }
`
const EXPECTED = [
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", description: "Balanced", context: 200000, multiplier: 1.3 },
  { id: "auto", name: "Auto", description: "Kiro picks", context: 1000000, multiplier: 1 },
]

writeFileSync(FAKE, `#!/bin/sh\necho "$*" >> '${LOG}'\ncat <<'EOF'\n${FIXTURE}EOF\n`)
chmodSync(FAKE, 0o755)
const invocations = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) : [])
const writeCache = (fetchedAt: number, models = [{ ...FALLBACK_MODELS[0], id: "cached" }]) =>
  writeFileSync(CACHE, JSON.stringify({ version: 1, fetchedAt, models }))

beforeEach(() => {
  rmSync(LOG, { force: true })
  rmSync(CACHE, { force: true })
  mkdirSync(join(ROOT, "cache", "opencode-kiro-auth"), { recursive: true, mode: 0o700 })
  process.env.KIRO_CLI = FAKE
})

test("parses fixture with extra fields and noise lines", () => {
  expect(parseModelList(FIXTURE)).toEqual(EXPECTED)
  expect(parseModelList("not json at all")).toEqual([])
})

test("fake kiro-cli populates cache (0600), single-flight", async () => {
  const [a, b] = await Promise.all([currentModels(), currentModels()])
  expect(a).toEqual(EXPECTED)
  expect(b).toEqual(EXPECTED)
  expect(invocations()).toEqual(["chat --list-models --format json"])
  expect(statSync(CACHE).mode & 0o777).toBe(0o600)
  expect(statSync(join(ROOT, "cache", "opencode-kiro-auth")).mode & 0o777).toBe(0o700)
  const saved = JSON.parse(readFileSync(CACHE, "utf8"))
  expect(saved.version).toBe(1)
  expect(saved.models).toEqual(EXPECTED)
})

test("fresh cache served without exec", async () => {
  writeCache(Date.now())
  expect((await currentModels())[0].id).toBe("cached")
  await Bun.sleep(100)
  expect(invocations()).toEqual([])
})

test("stale cache returned while refreshing", async () => {
  writeCache(Date.now() - 25 * 60 * 60 * 1000)
  expect((await currentModels())[0].id).toBe("cached")
  for (let i = 0; i < 50 && JSON.parse(readFileSync(CACHE, "utf8")).models[0].id === "cached"; i++) await Bun.sleep(50)
  expect(invocations().length).toBe(1)
  expect(JSON.parse(readFileSync(CACHE, "utf8")).models).toEqual(EXPECTED)
})

test("missing binary -> auto fallback, no throw", async () => {
  process.env.KIRO_CLI = join(ROOT, "no-such-kiro-cli")
  expect(await currentModels()).toEqual(FALLBACK_MODELS)
  expect(existsSync(CACHE)).toBe(false)
})

test("corrupt cache JSON is ignored", async () => {
  writeFileSync(CACHE, "{not json")
  expect(await currentModels()).toEqual(EXPECTED)
  expect(invocations().length).toBe(1)
})

test.each([null, {}, { id: "bad", name: "Bad", description: "", context: "many", multiplier: 1 }, { id: "bad", name: "Bad", description: "", context: -1, multiplier: 1 }])("ignores malformed cached model members: %j", async (model: unknown) => {
  writeFileSync(CACHE, JSON.stringify({ version: 1, fetchedAt: Date.now(), models: [model] }))
  expect(await currentModels()).toEqual(EXPECTED)
})

test.each(["fetchedAt", "context", "multiplier"])("ignores non-finite cached %s", async (field: string) => {
  const valid = JSON.stringify({ version: 1, fetchedAt: Date.now(), models: [{ id: "bad", name: "Bad", description: "", context: 200000, multiplier: 1 }] })
  writeFileSync(CACHE, valid.replace(new RegExp(`"${field}":\\d+`), `"${field}":1e999`))
  expect(await currentModels()).toEqual(EXPECTED)
})
