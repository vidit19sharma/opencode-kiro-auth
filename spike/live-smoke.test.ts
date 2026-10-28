import { test, expect } from "bun:test"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import assert from "node:assert/strict"
import { z } from "zod"
import { createQaRun } from "../scripts/qa-paths.ts"

const driver = resolve(import.meta.dirname, "../scripts/live-smoke.ts")
const resourceSchema = z.object({ kind: z.string(), removed: z.boolean() })
const evidenceSchema = z.object({ status: z.enum(["passed", "failed"]), checkpoint: z.string(), actualPromptCount: z.number(), observations: z.array(z.object({ checkpoint: z.string(), status: z.number().optional(), finishReason: z.string().optional(), contentLength: z.number().optional(), toolCallCount: z.number().optional() })), cleanup: z.object({ completed: z.boolean(), beforeRemovalCompleted: z.boolean(), productCompleted: z.boolean(), resourcesObservedBeforeDriverRemoval: z.literal(true), driverTemporaryRemoval: z.boolean(), driverResources: z.array(resourceSchema), cliTemporaryDirectories: z.array(z.string()), resources: z.array(resourceSchema) }), checks: z.array(z.string()) })
const refusal = z.object({ updates: z.array(z.object({ sessionUpdate: z.literal("agent_message_chunk"), content: z.object({ type: z.literal("text"), text: z.string() }) })), result: z.object({ stopReason: z.literal("end_turn") }) }).parse(JSON.parse(readFileSync(new URL("./fixtures/native-role-refusal.json", import.meta.url), "utf8")))
if (process.argv[2] === "--fake") {
  const args = process.argv.slice(3)
  if (args[0] === "--version") {
    if (process.env.SMOKE_CASE === "version") process.exit(1)
    if (process.env.SMOKE_CASE === "cli-temp" || process.env.SMOKE_CASE === "wrong-secret-cli-temp") for (const name of ["kiro-log", "kiro-cli-updates-501"]) mkdirSync(join(tmpdir(), name))
    if (process.env.SMOKE_CASE === "owned-leak") mkdirSync(join(tmpdir(), "opencode-kiro-leaked"))
    if (process.env.SMOKE_CASE === "cli-named-file") writeFileSync(join(tmpdir(), "kiro-log"), "not-a-cli-directory")
    if (process.env.SMOKE_CASE === "live-pid") appendFileSync(join(tmpdir(), "../trace.jsonl"), JSON.stringify({ event: "preflight", pid: process.ppid }) + "\n")
    console.log("kiro-cli 2.33.1"); process.exit(0)
  }
  if (args[0] === "chat") { if (process.env.SMOKE_CASE === "catalog") process.exit(1); console.log(JSON.stringify({ models: [{ model_id: "claude-haiku-4.5", context_window_tokens: 200000 }] })); process.exit(0) }
  assert.equal(args[0], "acp")
  if (process.env.SMOKE_CASE === "ceiling") {
    createInterface({ input: process.stdin }).on("line", () => writeFileSync(z.string().parse(process.env.SMOKE_MEMORY), "unexpected-prompt"))
    process.stdin.on("end", () => process.exit(0))
  } else {
  const agent = z.object({ mcpServers: z.object({ opencode: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }) }) }).parse(JSON.parse(readFileSync(".kiro/agents/opencode.json", "utf8"))).mcpServers.opencode
  const send = (value: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n")
  let session = "", sequence = 0
  async function mcp(method: string, params: object = {}) {
    const response = await fetch(agent.url, { method: "POST", headers: { ...agent.headers, "content-type": "application/json", ...(session ? { "Mcp-Session-Id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++sequence }), method, params }) })
    assert(response.ok)
    if (method === "initialize") session = z.string().parse(response.headers.get("mcp-session-id"))
    if (response.status === 202) { await response.text(); return undefined }
    return response.json()
  }
  const input = createInterface({ input: process.stdin })
  input.on("line", line => {
    void (async () => {
      const rpc = z.object({ id: z.number().optional(), method: z.string(), params: z.record(z.string(), z.unknown()) }).parse(JSON.parse(line))
      switch (rpc.method) {
        case "initialize":
          await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "offline-smoke", version: "1" } }); await mcp("notifications/initialized"); await mcp("tools/list")
          send({ id: rpc.id, result: { protocolVersion: 1 } }); break
        case "session/new": send({ id: rpc.id, result: { sessionId: "offline-native-session" } }); break
        case "session/load": send({ id: rpc.id, result: {} }); break
        case "session/prompt": {
          const blocks = z.array(z.object({ text: z.string() })).parse(rpc.params.prompt)
          const active = blocks.filter(block => !block.text.startsWith("<opencode-role-data>\n"))
          // Reproduce the observed refusal when current input is only replay data.
          if (!active.length || process.env.SMOKE_CASE === "native-refusal") {
            for (const update of refusal.updates) send({ method: "session/update", params: { sessionId: "offline-native-session", update } })
            send({ id: rpc.id, result: refusal.result }); break
          }
          const prompt = active.map(block => block.text).join("\n\n")
          const memoryPath = z.string().parse(process.env.SMOKE_MEMORY)
          let answer: string
          if (existsSync(memoryPath)) answer = readFileSync(memoryPath, "utf8")
          else {
            const memory = z.string().parse(prompt.match(/Remember code ([a-f0-9]+)\./u)?.[1]); writeFileSync(memoryPath, memory)
            const result = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) }).parse(await mcp("tools/call", { name: "qa_probe", arguments: { value: "native-input" } }))
            answer = process.env.SMOKE_CASE?.startsWith("wrong-secret") ? "incorrect-result" : z.string().parse(result.result.content[0]?.text)
          }
          send({ method: "session/update", params: { sessionId: "offline-native-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } })
          send({ id: rpc.id, result: { stopReason: "end_turn" } }); break
        }
        case "session/cancel": break
        default: assert.fail(rpc.method)
      }
    })().catch(error => { console.error(error instanceof Error ? error.name : "fixture-error"); process.exit(1) })
  })
  input.on("close", () => process.exit(0))
  }
} else {
  async function run(mode: string, permitted = true) {
    const root = createQaRun("live-smoke-offline-"); mkdirSync(`${root}/tmp`)
    const executable = `${root}/fake-cli`
    writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.filename)} --fake "$@"\n`, { mode: 0o700 })
    const child = Bun.spawn([process.execPath, driver], { env: { PATH: "/usr/bin:/bin", HOME: `${root}/home`, XDG_CACHE_HOME: `${root}/cache`, XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, TMPDIR: `${root}/tmp`, KIRO_QA_ARTIFACTS: `${root}/tmp`, KIRO_CLI: executable, KIRO_LIVE_MODEL: "claude-haiku-4.5", ...(permitted ? { KIRO_LIVE: "1" } : {}), SMOKE_CASE: mode, SMOKE_MEMORY: `${root}/memory` }, stdout: "pipe", stderr: "pipe" })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const runs = readdirSync(`${root}/tmp`).filter(name => name.startsWith("kiro-live-"))
    return { root, exit, stdout, stderr, runs, executable, evidence: () => evidenceSchema.parse(JSON.parse(readFileSync(`${root}/tmp/${runs[0]}/evidence.json`, "utf8"))) }
  }
  test("refuses inference when the live guard is absent", async () => {
    // Given no authorization; When invoked; Then no run or native process is created.
    const result = await run("ok", false); expect(result.exit).toBe(2); expect(result.runs).toEqual([])
  })
  for (const mode of ["version", "catalog"]) test(`cleans setup and records zero prompts when ${mode} preflight fails`, async () => {
    // Given a failing official-command boundary; When preflight fails; Then scratch cleanup and zero-prompt evidence survive.
    const result = await run(mode); expect(result.exit).not.toBe(0)
    expect(result.evidence()).toMatchObject({ status: "failed", actualPromptCount: 0, cleanup: { completed: true } })
    expect(result.evidence().cleanup.resources.every(resource => resource.removed)).toBe(true)
    expect(existsSync(`${result.root}/tmp/${result.runs[0]}/tmp`)).toBe(false)
    console.log(`Offline ${mode} failure evidence: ${result.root}`)
  })
  test("records two actual prompts and owned-resource cleanup when the real bridge completes both scenarios", async () => {
    // Given an offline ACP executable; When the unchanged semantic scenarios run; Then metadata proves two prompts and cleanup.
    const result = await run("ok"); expect(result.exit, result.stderr).toBe(0)
    expect(result.evidence()).toMatchObject({ status: "passed", actualPromptCount: 2, cleanup: { completed: true } })
    expect(result.evidence().checks).toHaveLength(2)
    expect(result.evidence().cleanup.resources.some(resource => resource.kind === "process")).toBe(true)
    expect(result.evidence().cleanup.resources.some(resource => resource.kind === "bridge-scratch")).toBe(true)
    expect(result.evidence().cleanup.resources.some(resource => resource.kind === "listener")).toBe(true)
    expect(result.evidence().cleanup.resources.every(resource => resource.removed)).toBe(true)
    console.log(`Offline smoke evidence: ${result.root}`)
  }, 15000)
  test("stops without retry when the secret-result assertion fails", async () => {
    // Given a semantically incorrect native result; When verification fails; Then exactly one prompt was spent and cleanup completed.
    const result = await run("wrong-secret"); expect(result.exit).not.toBe(0)
    expect(result.evidence()).toMatchObject({ status: "failed", checkpoint: "secret.resumed.exact-result", actualPromptCount: 1, cleanup: { completed: true } })
    console.log(`Offline semantic failure evidence: ${result.root}`)
  }, 15000)
  test("identifies the first failed assertion when native returns text without a tool", async () => {
    // Given the sanitized saved native deviation; When replayed offline; Then no semantic success or retry is reported.
    const result = await run("native-refusal")
    expect(result.exit).not.toBe(0)
    expect(result.evidence()).toMatchObject({ status: "failed", checkpoint: "secret.first.finish-reason", actualPromptCount: 1, checks: [] })
    expect(result.evidence().observations).toContainEqual({ checkpoint: "secret-tool.completion", finishReason: "stop", contentLength: refusal.updates[0]?.content.text.length, toolCallCount: 0 })
    expect(JSON.stringify(result.evidence())).not.toContain(refusal.updates[0]?.content.text ?? "synthetic-refusal")
    console.log(`Offline native refusal evidence: ${result.root}`)
  }, 15000)
  for (const mode of ["cli-temp", "owned-leak", "cli-named-file", "live-pid"]) test(`checks cleanup before and after driver removal with ${mode}`, async () => {
    // Given known CLI directories or a genuine failed product check; When scoped driver cleanup runs; Then only the known directories can pass.
    const result = await run(mode)
    expect(result.exit).toBe(mode === "cli-temp" ? 0 : 1)
    const evidence = result.evidence()
    expect(evidence).toMatchObject({ status: mode === "cli-temp" ? "passed" : "failed", cleanup: { completed: mode === "cli-temp", beforeRemovalCompleted: false, productCompleted: mode === "cli-temp", resourcesObservedBeforeDriverRemoval: true, driverTemporaryRemoval: true, cliTemporaryDirectories: mode === "cli-temp" ? ["kiro-cli-updates-501", "kiro-log"] : [] } })
    expect(evidence.cleanup.resources.some(resource => !resource.removed)).toBe(true)
    expect(evidence.cleanup.driverResources.every(resource => resource.removed)).toBe(true)
    expect(evidence.cleanup.resources.some(resource => resource.kind === "process-group")).toBe(true)
    expect(existsSync(`${result.root}/tmp/${result.runs[0]}/tmp`)).toBe(false)
    console.log(`Offline ${mode} evidence: ${result.root}`)
  }, 15000)
  test("keeps semantic failure failed when known CLI directories are cleaned", async () => {
    // Given a wrong secret and known CLI temp directories; When failure cleanup runs; Then cleanup passes but acceptance stays failed after one prompt.
    const result = await run("wrong-secret-cli-temp")
    expect(result.exit).toBe(1)
    expect(result.evidence()).toMatchObject({ status: "failed", checkpoint: "secret.resumed.exact-result", actualPromptCount: 1, checks: [], cleanup: { beforeRemovalCompleted: false, productCompleted: true, driverTemporaryRemoval: true, completed: true } })
  }, 15000)
  test("blocks a third actual ACP prompt before writing to the native child", async () => {
    // Given an exhausted run-wide ledger; When another shim receives a prompt; Then the child receives no payload.
    const result = await run("ok"); expect(result.exit).toBe(0)
    const smokeRoot = `${result.root}/tmp/${result.runs[0]}`, cwd = `${smokeRoot}/tmp/ceiling`
    mkdirSync(`${cwd}/.kiro/agents`, { recursive: true })
    writeFileSync(`${cwd}/.kiro/agents/opencode.json`, JSON.stringify({ mcpServers: { opencode: { url: "http://127.0.0.1:1/mcp" } } }))
    const received = `${result.root}/unexpected`
    const child = Bun.spawn([process.execPath, driver, "--acp-shim", "acp", "--agent-engine", "v2", "--agent", "opencode", "--model", "claude-haiku-4.5"], { cwd, env: { PATH: "/usr/bin:/bin", KIRO_LIVE: "1", KIRO_SMOKE_ROOT: smokeRoot, KIRO_SMOKE_EXECUTABLE: result.executable, SMOKE_CASE: "ceiling", SMOKE_MEMORY: received }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "session/prompt", params: { sessionId: "offline-native-session", prompt: [{ type: "text", text: "must-not-forward" }] } }) + "\n"); child.stdin.end()
      expect(await child.exited).not.toBe(0)
      expect(existsSync(received)).toBe(false)
      const observed = readFileSync(`${smokeRoot}/trace.jsonl`, "utf8").split("\n").filter(Boolean).map(line => z.object({ event: z.string() }).parse(JSON.parse(line)))
      expect(observed.filter(item => item.event === "prompt")).toHaveLength(2)
      expect(observed.filter(item => item.event === "prompt-blocked")).toHaveLength(1)
    } finally { if (child.exitCode === null) child.kill(); await child.exited; rmSync(`${smokeRoot}/tmp`, { recursive: true }) }
    console.log(`Offline ceiling evidence: ${result.root}`)
  }, 15000)
}
