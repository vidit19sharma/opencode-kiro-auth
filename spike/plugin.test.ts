import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Auth, Provider } from "@opencode-ai/sdk/v2"
import type { Bridge, BridgeOptions, Scope } from "../src/contracts.js"

const root = mkdtempSync(join(tmpdir(), "kiro-plugin-"))
const savedEnv = { ...process.env }
process.env.HOME = root
process.env.XDG_CACHE_HOME = join(root, "cache")
const executable = join(root, "fake-kiro")
writeFileSync(executable, `#!${process.execPath}
const mode = process.env.KIRO_TEST_MODE;
process.stdin.resume();
process.stdin.on('end', () => {
if (process.argv[2] === '--version') console.log('kiro-cli ' + (mode === 'old' ? '2.32.0' : '2.33.1'));
else if (mode === 'logout') process.exitCode = 1;
else if (mode === 'invalid-json') console.log('not-json private@example.invalid');
else console.log(JSON.stringify(mode === 'unknown' ? {secret:'never expose me'} : {accountType:'IamIdentityCenter',email:'private@example.invalid'}) + '\\nProfile: private');
});
`, { mode: 0o700 })
process.env.KIRO_CLI = executable
const catalog = [{ id: "catalog-id", name: "Catalog", description: "", context: 200000, multiplier: 1.3 }]
const models = await import("../src/models.js")
const calls: { body: unknown; scope: Scope; signal: AbortSignal }[] = []
const observed: unknown[] = []
let created = 0
let closed = 0
let upstreamStatus = 200
const bridge: Bridge = {
  async handle(body, scope, signal) { calls.push({ body, scope, signal }); return new Response("bridge", { status: upstreamStatus }) },
  observe(sessionID, status) { observed.push([sessionID, status]) },
  async close() { closed++ },
}
mock.module("../src/bridge.js", () => ({ createBridge: async (options: BridgeOptions): Promise<Bridge> => {
  expect(options).toEqual({ executable }); created++; return bridge
} }))
const entry = await import("../src/index.js")
const input: PluginInput = {
  directory: root, worktree: root,
  project: { id: "project", worktree: root, time: { created: 0 } },
  serverUrl: new URL("http://host.invalid"),
  get $(): PluginInput["$"] { throw new Error("shell use forbidden") },
  experimental_workspace: { register() { throw new Error("unexpected registration") } },
  client: createOpencodeClient({ baseUrl: "http://host.invalid", fetch: async () => { throw new Error("network/auth write forbidden") } }),
}
const provider: Provider = { id: "kiro", name: "Kiro", source: "api", env: [], options: {}, models: {} }
let hooks: Hooks
let auth: Auth = { type: "api", key: "kiro-cli-managed" }
let transport: typeof fetch
beforeEach(async () => {
  spyOn(models, "currentModels").mockResolvedValue(catalog)
  process.env.KIRO_CLI = executable
  process.env.KIRO_TEST_MODE = "ok"
  calls.length = 0; observed.length = 0; created = 0; closed = 0; upstreamStatus = 200
  auth = { type: "api", key: "kiro-cli-managed" }
  hooks = await entry.default(input)
  const options = await hooks.auth?.loader?.(async () => auth, provider)
  if (typeof options?.fetch !== "function") throw new Error("missing custom fetch")
  transport = options.fetch
})
afterAll(() => { mock.restore(); process.env = savedEnv; rmSync(root, { recursive: true, force: true }) })
afterEach(async () => { await hooks.dispose?.(); mock.restore() })
const headers = { "x-opencode-session": "session-a", "x-opencode-agent": encodeURIComponent("general / β") }
const request = (body: unknown = { model: "catalog-id", messages: [] }) => transport("http://kiro.invalid/v1/chat/completions", {
  method: "POST", headers, body: JSON.stringify(body),
})

test("exports only the host default when importing entry", () => { expect(Object.keys(entry)).toEqual(["default"]) })
test("registers catalog metadata while preserving user deadline overrides", async () => {
  // Given a user override distinct from every plugin default.
  const config: Config = { provider: { kiro: { options: { timeout: 123, chunkTimeout: false, headerTimeout: 456 } } } }
  // When the host applies plugin defaults.
  await hooks.config?.(config)
  // Then the catalog is honest and override precedence survives.
  expect(config.provider?.kiro?.options).toMatchObject({ timeout: 123, chunkTimeout: false, headerTimeout: 456, baseURL: "http://kiro.invalid/v1" })
  expect(config.provider?.kiro?.models?.["catalog-id"]).toMatchObject({ limit: { context: 200000 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, reasoning: false })
  expect(created).toBe(0)
})
test("routes parsed body and scoped Request headers to a lazy bridge", async () => {
  // Given a Request carrying the fallback signal and URI-encoded agent.
  const controller = new AbortController()
  const req = new Request("http://kiro.invalid/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "catalog-id", messages: [] }), signal: controller.signal })
  // When it is dispatched without init.
  expect(await (await transport(req)).text()).toBe("bridge")
  controller.abort()
  // Then scope comes from this request/project, and cancellation propagates.
  expect(calls[0]?.scope).toEqual({ sessionID: "session-a", agent: "general / β", directory: root })
  expect(calls[0]?.signal.aborted).toBe(true)
  expect(created).toBe(1)
})
test.each(["", "pasted-secret"])("rejects unsupported stored key %s without launching bridge", async (key: string) => {
  auth = { type: "api", key }
  const response = await request()
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: { code: "registration_required" } })
  expect(created).toBe(0)
})
test("rejects OAuth credentials instead of treating them as CLI registration", async () => {
  auth = { type: "oauth", access: "never-a-CLI-key", refresh: "private", expires: 999999 }
  expect((await request()).status).toBe(401)
  expect(created).toBe(0)
})
test.each([null, [], {}, { model: "catalog-id" }])("rejects structurally invalid body %j locally", async (body: unknown) => {
  expect((await request(body)).status).toBe(400)
  expect(created).toBe(0)
})
test("applies long default deadlines and refreshes dynamic catalog without invented metadata", async () => {
  const config: Config = {}
  await hooks.config?.(config)
  expect(config.provider?.kiro?.options).toMatchObject({ timeout: false, headerTimeout: 7260000, chunkTimeout: 7260000 })
  const dynamic = await hooks.provider?.models?.(provider, {})
  expect(dynamic?.["catalog-id"]).toMatchObject({ limit: { context: 200000, output: 8192 }, capabilities: { reasoning: false, attachment: true, input: { text: true, image: true, audio: false, video: false, pdf: false }, output: { text: true, image: false, audio: false, video: false, pdf: false } } })
  expect(dynamic?.["catalog-id"]?.variants).toBeUndefined()
  expect(dynamic?.["catalog-id"]?.release_date).toBe("")
  spyOn(models, "currentModels").mockResolvedValue([{ ...catalog[0], id: "changed", context: 9000 }])
  const response = await transport("http://kiro.invalid/v1/models")
  expect(await response.json()).toMatchObject({ data: [{ id: "changed" }] })
  expect(created).toBe(0)
})
test("stamps only kiro headers using each request's identity", async () => {
  const model = (await hooks.provider?.models?.(provider, {}))?.["catalog-id"]
  if (!model || !hooks["chat.headers"]) throw new Error("missing hooks")
  const message = { id: "m", sessionID: "s", role: "user", time: { created: 0 }, agent: "general", model: { providerID: "kiro", modelID: model.id } } satisfies Parameters<NonNullable<Hooks["chat.headers"]>>[0]["message"]
  const output: Parameters<NonNullable<Hooks["chat.headers"]>>[1] = { headers: { existing: "preserved" } }
  await hooks["chat.headers"]({ model, message, provider: { info: provider, options: {}, source: "api" }, agent: "worker β", sessionID: "s2" }, output)
  expect(output.headers).toEqual({ existing: "preserved", "x-opencode-session": "s2", "x-opencode-agent": encodeURIComponent("worker β") })
  const other = { headers: {} }
  await hooks["chat.headers"]({ model: { ...model, providerID: "other" }, message, provider: { info: provider, options: {}, source: "api" }, agent: "other", sessionID: "s3" }, other)
  expect(other.headers).toEqual({})
})
test.each([{}, { ...headers, "x-opencode-agent": "%GG" }, { ...headers, "x-opencode-agent": "%0A" }, { ...headers, "x-opencode-agent": "raw space" }, { ...headers, "x-opencode-session": "" }])("rejects malformed scope %j", async (badHeaders: HeadersInit) => {
  const response = await transport("http://kiro.invalid/v1/chat/completions", { method: "POST", headers: badHeaders, body: '{"model":"catalog-id","messages":[]}' })
  expect(response.status).toBe(400)
  expect(created).toBe(0)
})
test("rejects malformed JSON and unknown routes without fallback network", async () => {
  const response = await transport("http://kiro.invalid/v1/chat/completions", { method: "POST", headers, body: "{" })
  expect(response.status).toBe(400)
  expect((await transport("https://other.invalid/v1/embeddings")).status).toBe(404)
})
test.each([["logout", 401, "login_required"], ["old", 503, "cli_unsupported"], ["unknown", 503, "identity_unsupported"], ["invalid-json", 503, "identity_unsupported"]] as const)("fails CLI health safely when %s", async (mode: string, status: number, code: string) => {
  process.env.KIRO_TEST_MODE = mode
  const response = await request()
  expect(response.status).toBe(status)
  const error = await response.json()
  expect(error).toMatchObject({ error: { code } })
  expect(JSON.stringify(error)).not.toContain("private@example.invalid")
  expect(created).toBe(0)
})
test("returns 503 when the configured executable is missing", async () => {
  process.env.KIRO_CLI = join(root, "absent")
  const missing = await entry.default(input)
  const config: Config = {}
  await missing.config?.(config)
  const fetcher = config.provider?.kiro?.options?.fetch
  if (typeof fetcher !== "function") throw new Error("missing transport")
  await missing.auth?.loader?.(async () => auth, provider)
  expect((await fetcher("http://kiro.invalid/v1/chat/completions", { method: "POST", headers, body: '{"model":"auto","messages":[]}' })).status).toBe(503)
  await missing.dispose?.()
})
test("custom API authorize checks CLI before issuing only a non-secret marker", async () => {
  const method = hooks.auth?.methods[0]
  if (method?.type !== "api" || !method.authorize) throw new Error("missing CLI method")
  expect(await method.authorize({ registration: "pasted-secret" })).toEqual({ type: "failed" })
  expect(await method.authorize({ registration: "kiro-cli-managed" })).toEqual({ type: "success", key: "kiro-cli-managed" })
  process.env.KIRO_TEST_MODE = "unknown"
  await expect(method.authorize({ registration: "kiro-cli-managed" })).rejects.toMatchObject({ code: "identity_unsupported" })
})
test("caches successful health but invalidates it on an upstream 401", async () => {
  const exec = spyOn(childProcess, "execFile")
  await request(); await request()
  expect(exec.mock.calls.length).toBe(2)
  upstreamStatus = 401
  await request()
  process.env.KIRO_TEST_MODE = "logout"
  expect((await request()).status).toBe(401)
  expect(exec.mock.calls.length).toBe(4)
})
test("honors init body/header overrides and isolates session scopes", async () => {
  const original = new Request("http://kiro.invalid/v1/chat/completions", { method: "POST", headers, body: "{}" })
  await transport(original, { body: '{"model":"catalog-id","messages":[]}', headers: { ...headers, "x-opencode-session": "session-b" } })
  await request()
  expect(calls.map((call) => call.scope.sessionID)).toEqual(["session-b", "session-a"])
  expect(calls[0]?.body).toEqual({ model: "catalog-id", messages: [] })
})
test("preserves abort reason during a CLI check", async () => {
  const exec = spyOn(childProcess, "execFile")
  const controller = new AbortController()
  const reason = new DOMException("cancelled", "AbortError")
  const pending = transport("http://kiro.invalid/v1/chat/completions", { method: "POST", headers, body: '{"model":"auto","messages":[]}', signal: controller.signal })
  setImmediate(() => { expect(exec.mock.calls.length).toBeGreaterThan(0); controller.abort(reason) })
  await expect(pending).rejects.toBe(reason)
  expect(created).toBe(0)
})
test("forwards exact lifecycle statuses and closes a lazy bridge only once", async () => {
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "unused" } } })
  expect(created).toBe(0)
  await request()
  for (const status of [{ type: "busy" }, { type: "retry", attempt: 1, message: "retry", next: 0 }, { type: "idle" }] as const)
    await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-a", status } } })
  await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-a", projectID: "p", directory: root, title: "test", version: "1", time: { created: 0, updated: 0 } } } } })
  await Promise.all([hooks.dispose?.(), hooks.dispose?.()])
  expect(observed).toEqual([["session-a", "busy"], ["session-a", "retry"], ["session-a", "idle"], ["session-a", "deleted"]])
  expect(closed).toBe(1)
  await expect(request()).rejects.toMatchObject({ name: "AbortError" })
})
test("requires deliberate registration in a fresh plugin instance", async () => {
  const fresh = await entry.default(input)
  const config: Config = {}
  await fresh.config?.(config)
  const fetcher = config.provider?.kiro?.options?.fetch
  if (typeof fetcher !== "function") throw new Error("missing local transport")
  const response = await fetcher("http://kiro.invalid/v1/chat/completions", { method: "POST", headers, body: '{"model":"auto","messages":[]}' })
  expect(response.status).toBe(401)
  expect(created).toBe(0)
  await fresh.dispose?.()
})
test("expires successful auth health after sixty seconds", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(100000)
  const exec = spyOn(childProcess, "execFile")
  await request()
  clock.mockReturnValue(159999)
  await request()
  expect(exec.mock.calls.length).toBe(2)
  clock.mockReturnValue(160000)
  process.env.KIRO_TEST_MODE = "logout"
  expect((await request()).status).toBe(401)
  expect(exec.mock.calls.length).toBe(4)
})
