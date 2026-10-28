import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync, rmSync } from "node:fs"
import { createInterface } from "node:readline"
import { createConnection } from "node:net"
import { isAbsolute, relative } from "node:path"
import { z } from "zod"
import type { Bridge, Json } from "../src/contracts.js"
import { createQaRun } from "./qa-paths.ts"

const eventSchema = z.object({ event: z.string(), pid: z.number().optional(), cwd: z.string().optional(), origin: z.string().optional(), sessionID: z.string().optional(), requestID: z.union([z.string(), z.number()]).optional() })
const events = (root: string) => readFileSync(`${root}/trace.jsonl`, "utf8").split("\n").filter(Boolean).map(line => eventSchema.parse(JSON.parse(line)))
const record = (root: string, value: z.infer<typeof eventSchema>) => appendFileSync(`${root}/trace.jsonl`, JSON.stringify(value) + "\n")
async function shim() {
  assert.equal(process.env.KIRO_LIVE, "1", "Shim requires the same explicit live authorization")
  const root = realpathSync(z.string().parse(process.env.KIRO_SMOKE_ROOT))
  const cwd = realpathSync(process.cwd())
  assert(relative(`${root}/tmp`, cwd) && !relative(`${root}/tmp`, cwd).startsWith(".."))
  const executable = z.string().parse(process.env.KIRO_SMOKE_EXECUTABLE)
  assert(isAbsolute(executable))
  assert.deepEqual(process.argv.slice(3), ["acp", "--agent-engine", "v2", "--agent", "opencode", "--model", "claude-haiku-4.5"])
  const config = z.object({ mcpServers: z.object({ opencode: z.object({ url: z.string().url() }) }) }).parse(JSON.parse(readFileSync(".kiro/agents/opencode.json", "utf8")))
  const origin = new URL(config.mcpServers.opencode.url).origin
  assert.equal(new URL(origin).hostname, "127.0.0.1")
  record(root, { event: "shim", pid: process.pid, cwd, origin })
  const child = spawn(executable, process.argv.slice(3), { stdio: "pipe" })
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
  child.once("spawn", () => record(root, { event: "child", pid: child.pid, cwd, origin }))
  child.once("error", () => { process.exitCode = 1 })
  child.stderr.resume()
  const pending = new Map<string | number, string>()
  const rpcSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.object({ sessionId: z.string().optional() }).passthrough().optional(), result: z.object({ sessionId: z.string().optional() }).passthrough().optional() })
  let failed = false, killTimer: ReturnType<typeof setTimeout> | undefined
  const fail = () => { failed = true; process.exitCode = 1; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000) }
  const input = createInterface({ input: process.stdin })
  input.on("line", line => {
    if (failed) return
    try {
      const rpc = rpcSchema.parse(JSON.parse(line))
      if (rpc.method === "session/prompt") {
        let claimed = false
        for (const slot of [1, 2]) {
          try { writeFileSync(`${root}/prompt-${slot}`, "", { flag: "wx", mode: 0o600 }); claimed = true; break }
          catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error }
        }
        if (!claimed) { record(root, { event: "prompt-blocked" }); fail(); return }
        record(root, { event: "prompt-reserved", pid: process.pid, sessionID: rpc.params?.sessionId, requestID: rpc.id })
      }
      if (rpc.id !== undefined && rpc.method) pending.set(rpc.id, rpc.method)
      child.stdin.write(line + "\n", error => {
        if (error) { fail(); return }
        if (rpc.method === "session/prompt") record(root, { event: "prompt", pid: process.pid, sessionID: rpc.params?.sessionId, requestID: rpc.id })
        if (rpc.method === "session/load") record(root, { event: "load", pid: process.pid, sessionID: rpc.params?.sessionId })
      })
    } catch (error) { if (!(error instanceof Error)) throw error; record(root, { event: "shim-input-failure" }); fail() }
  })
  input.on("close", () => child.stdin.end())
  child.stdin.on("error", fail)
  const output = createInterface({ input: child.stdout })
  output.on("line", line => {
    try {
      const rpc = rpcSchema.parse(JSON.parse(line))
      if (rpc.id !== undefined && pending.get(rpc.id) === "session/new" && rpc.result?.sessionId) record(root, { event: "session", pid: process.pid, sessionID: rpc.result.sessionId })
      if (rpc.id !== undefined && !rpc.method) pending.delete(rpc.id)
      process.stdout.write(line + "\n")
    } catch (error) { if (!(error instanceof Error)) throw error; record(root, { event: "shim-output-failure" }); fail() }
  })
  await closed
  clearTimeout(killTimer)
  input.close(); output.close(); process.stdin.destroy()
  record(root, { event: "child-exit", pid: child.pid })
  if (child.exitCode !== 0) process.exitCode = 1
}

async function main() {
  if (process.env.KIRO_LIVE !== "1") { console.error("Refusing inference without KIRO_LIVE=1."); process.exitCode = 2; return }
  const root = createQaRun("kiro-live-")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException("Smoke deadline", "AbortError")), 90000)
  const stop = () => controller.abort(new DOMException("Smoke interrupted", "AbortError"))
  process.once("SIGINT", stop); process.once("SIGTERM", stop)
  let bridge: Bridge | undefined, stage = "setup", checkpoint = "setup", status = "failed", version = "", failure = ""
  type Observation = { readonly checkpoint: string; readonly status?: number; readonly finishReason?: string; readonly contentLength?: number; readonly toolCallCount?: number; readonly matches?: boolean }
  const observations: Observation[] = []
  const mark = (label: string, shape: Omit<Observation, "checkpoint"> = {}) => { checkpoint = label; observations.push({ checkpoint, ...shape }) }
  type Resource = { readonly kind: string; readonly value: string | number; readonly removed: boolean }
  const checks: string[] = [], resources: Resource[] = [], driverResources: Resource[] = []
  let cleanupCompleted = false, beforeRemovalCompleted = false, productCompleted = false, resourcesObservedBeforeDriverRemoval = false, driverTemporaryRemoval = false
  const cliTemporaryDirectories: string[] = []
  const model = "claude-haiku-4.5"
  try {
    mkdirSync(`${root}/tmp`); writeFileSync(`${root}/trace.jsonl`, "", { mode: 0o600 })
    const executable = z.string().min(1).parse(process.env.KIRO_CLI)
    assert(isAbsolute(executable), "Set an absolute native KIRO_CLI executable")
    assert.equal(process.env.KIRO_LIVE_MODEL ?? model, model, "Only Haiku 4.5 is permitted")
    process.env.TMPDIR = `${root}/tmp`; process.env.TMP = `${root}/tmp`; process.env.TEMP = `${root}/tmp`
    const command = (args: readonly string[]) => new Promise<string>((resolve, reject) => {
      const child = execFile(executable, [...args], { timeout: 20000, maxBuffer: 65536, encoding: "utf8", signal: controller.signal }, (error, stdout) => error ? reject(error) : resolve(stdout))
      child.once("spawn", () => record(root, { event: "preflight", pid: child.pid }))
      child.stdin?.end()
    })
    stage = "version"
    mark("preflight.version")
    version = (await command(["--version"])).trim()
    const match = version.match(/^kiro-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/u)
    const parts = z.array(z.coerce.number()).length(3).parse(match?.slice(1))
    version = `kiro-cli ${parts.join(".")}`
    const [major = 0, minor = 0, patch = 0] = parts
    assert(major > 2 || (major === 2 && (minor > 33 || (minor === 33 && patch >= 1))), "Kiro CLI 2.33.1 or newer is required")
    stage = "catalog"
    mark("preflight.catalog")
    const { parseModelList } = await import("../dist/models.js")
    const catalog = await command(["chat", "--list-models", "--format", "json"])
    assert(parseModelList(catalog).some(item => item.id === model), "Exact Haiku 4.5 model must be in catalog")
    const shimPath = `${root}/acp-shim`
    process.env.KIRO_SMOKE_ROOT = root; process.env.KIRO_SMOKE_EXECUTABLE = executable
    writeFileSync(shimPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.filename)} --acp-shim "$@"\n`, { mode: 0o700 })
    stage = "bridge"
    mark("bridge.create")
    const { createBridge } = await import("../dist/bridge.js")
    bridge = await createBridge({ executable: shimPath })
    const scope = { sessionID: `live-${randomUUID()}`, agent: "integration-qa", directory: root }
    const secret = randomBytes(16).toString("hex"), memory = randomBytes(8).toString("hex")
    const tools = [{ type: "function", function: { name: "qa_probe", description: "Return a hidden one-time QA result", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } }]
    const callSchema = z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.literal("qa_probe"), arguments: z.string() }) })
    const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({ role: z.literal("assistant"), content: z.string(), tool_calls: z.array(callSchema).optional() }), finish_reason: z.string() })).length(1) })
    const history: Json[] = [{ role: "user", content: `Remember code ${memory}. Call qa_probe with value "native-input" exactly once. Return its exact result and nothing else. Do not use other tools.` }]
    const active = bridge
    async function segment(currentTools: readonly Json[]) {
      mark(`${stage}.http`)
      const response = await active.handle({ model, stream: false, messages: history, tools: currentTools }, scope, controller.signal)
      mark(`${stage}.http`, { status: response.status })
      assert(response.ok, `Native segment failed (${response.status})`)
      mark(`${stage}.completion-shape`)
      const completion = completionSchema.parse(await response.json()).choices[0]; assert(completion, "completion.single-choice")
      const finishReason = ["stop", "tool_calls", "length", "content_filter"].includes(completion.finish_reason) ? completion.finish_reason : "other"
      mark(`${stage}.completion`, { finishReason, contentLength: completion.message.content.length, toolCallCount: completion.message.tool_calls?.length ?? 0 })
      return completion
    }
    stage = "secret-tool"
    const first = await segment(tools)
    mark("secret.first.finish-reason"); assert.equal(first.finish_reason, "tool_calls", checkpoint)
    mark("secret.first.single-call")
    const call = z.array(callSchema).length(1).parse(first.message.tool_calls)[0]; assert(call, checkpoint)
    mark("secret.first.arguments"); assert.deepEqual(JSON.parse(call.function.arguments), { value: "native-input" }, checkpoint)
    mark("secret.first.prompt-count"); assert.equal(events(root).filter(item => item.event === "prompt").length, 1, checkpoint)
    history.push(first.message, { role: "tool", tool_call_id: call.id, content: secret })
    const resumed = await segment(tools)
    mark("secret.resumed.finish-reason"); assert.equal(resumed.finish_reason, "stop", checkpoint)
    mark("secret.resumed.exact-result", { matches: resumed.message.content.trim() === secret }); assert.equal(resumed.message.content.trim(), secret, checkpoint)
    mark("secret.resumed.prompt-count"); assert.equal(events(root).filter(item => item.event === "prompt").length, 1, checkpoint)
    history.push(resumed.message); checks.push("secret result across HTTP segments; same actual ACP prompt")
    stage = "memory-reload"
    history.push({ role: "user", content: "Without calling any tool, return only the code I asked you to remember." })
    const second = await segment([{ type: "function", function: { name: "qa_probe", description: "Changed schema for reload QA", parameters: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"], additionalProperties: false } } }])
    mark("memory.finish-reason"); assert.equal(second.finish_reason, "stop", checkpoint)
    mark("memory.exact-result", { matches: second.message.content.trim() === memory }); assert.equal(second.message.content.trim(), memory, checkpoint)
    mark("memory.prompt-count"); assert.equal(events(root).filter(item => item.event === "prompt").length, 2, checkpoint)
    mark("memory.native-load"); assert(events(root).some(item => item.event === "load"), checkpoint)
    checks.push("continuation memory with changed schema and native reload"); status = "passed"
  } catch (error) {
    if (!(error instanceof Error)) throw error
    failure = error.name; process.exitCode = 1
  } finally {
    controller.abort(); clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop)
    try {
      try {
        const closing = bridge?.close()
        if (closing) await Promise.race([closing, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new DOMException("Cleanup deadline", "TimeoutError")), 6000); timer.unref(); void closing.then(() => clearTimeout(timer), () => clearTimeout(timer)) })])
      } catch (error) {
        if (!(error instanceof Error)) throw error
        failure = "CleanupError"; process.exitCode = 1
        for (const item of events(root)) if (item.event === "shim" && item.pid !== undefined) {
          try { process.kill(-item.pid, "SIGKILL") } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error }
        }
      }
      const observed = existsSync(`${root}/trace.jsonl`) ? events(root) : []
      for (const pid of new Set(observed.flatMap(item => item.pid === undefined ? [] : [item.pid]))) {
        let removed = false
        try { process.kill(pid, 0) } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; removed = true }
        resources.push({ kind: "process", value: pid, removed })
      }
      for (const pid of new Set(observed.flatMap(item => item.event === "shim" && item.pid !== undefined ? [item.pid] : []))) {
        let removed = false
        try { process.kill(-pid, 0) } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; removed = true }
        resources.push({ kind: "process-group", value: pid, removed })
      }
      for (const cwd of new Set(observed.flatMap(item => item.cwd ? [item.cwd] : []))) resources.push({ kind: "bridge-scratch", value: cwd, removed: !existsSync(cwd) })
      for (const origin of new Set(observed.flatMap(item => item.origin ? [item.origin] : []))) {
        const endpoint = new URL(origin)
        const removed = await new Promise<boolean>(resolve => {
          const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) })
          socket.once("error", error => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED") })
          socket.once("connect", () => { socket.destroy(); resolve(false) })
          socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
        })
        resources.push({ kind: "listener", value: origin, removed })
      }
      productCompleted = failure !== "CleanupError" && resources.every(item => item.removed)
      for (const name of existsSync(`${root}/tmp`) ? readdirSync(`${root}/tmp`).sort() : []) {
        const cliDirectory = (name === "kiro-log" || /^kiro-cli-updates-\d+$/u.test(name)) && lstatSync(`${root}/tmp/${name}`).isDirectory()
        if (cliDirectory) cliTemporaryDirectories.push(name)
        else productCompleted = false
        resources.push({ kind: "remaining-scratch", value: cliDirectory ? name : "unclassified-entry", removed: false })
      }
      beforeRemovalCompleted = failure !== "CleanupError" && resources.every(item => item.removed)
      resourcesObservedBeforeDriverRemoval = true
    } catch (error) { if (!(error instanceof Error)) throw error; failure = "CleanupError"; productCompleted = false; process.exitCode = 1 }
    finally {
      const observed = existsSync(`${root}/trace.jsonl`) ? events(root) : []
      let removalSucceeded = true
      try { rmSync(`${root}/tmp`, { recursive: true, force: true }); rmSync(`${root}/acp-shim`, { force: true }) }
      catch (error) { if (!(error instanceof Error)) throw error; removalSucceeded = false; failure ||= "DriverCleanupError" }
      for (const name of cliTemporaryDirectories) driverResources.push({ kind: "cli-temp-directory", value: name, removed: !existsSync(`${root}/tmp/${name}`) })
      driverResources.push({ kind: "driver-temp-root", value: `${root}/tmp`, removed: !existsSync(`${root}/tmp`) }, { kind: "driver-shim", value: `${root}/acp-shim`, removed: !existsSync(`${root}/acp-shim`) })
      driverTemporaryRemoval = removalSucceeded && driverResources.every(item => item.removed)
      cleanupCompleted = productCompleted && resourcesObservedBeforeDriverRemoval && driverTemporaryRemoval
      if (!cleanupCompleted) process.exitCode = 1
      writeFileSync(`${root}/evidence.json`, JSON.stringify({ status: status === "passed" && cleanupCompleted ? "passed" : "failed", stage, checkpoint, failure, observations, version, model, actualPromptCount: observed.filter(item => item.event === "prompt").length, reservedPromptCount: observed.filter(item => item.event === "prompt-reserved").length, checks, cleanup: { completed: cleanupCompleted, beforeRemovalCompleted, productCompleted, resourcesObservedBeforeDriverRemoval, cliTemporaryDirectories, driverTemporaryRemoval, driverResources, resources, bridgeCloseBoundMs: 6000, listenerProbeBoundMs: 1000 }, nativeSessions: observed.filter(item => item.event === "session" || item.event === "load").map(item => item.sessionID), nativeSessionDeletion: "not attempted" }, null, 2), { mode: 0o600 })
      console.log(`Smoke evidence: ${root}/evidence.json`)
    }
  }
}
if (process.argv[2] === "--acp-shim") await shim()
else await main()
