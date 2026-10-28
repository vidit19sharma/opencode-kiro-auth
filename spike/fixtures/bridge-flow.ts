import { existsSync, readFileSync, writeFileSync, watch } from "node:fs"
import assert from "node:assert/strict"
import { z } from "zod"
import { createBridge } from "../../dist/bridge.js"

const root = z.string().min(1).parse(process.env.KIRO_QA_ROOT)
const tracePath = z.string().min(1).parse(process.env.KIRO_QA_TRACE)
const traceSchema = z.array(z.object({ event: z.string(), pid: z.number(), cwd: z.string(), url: z.string().optional() }))
const traces = () => traceSchema.parse(readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)))
const bridge = await createBridge({ executable: z.string().min(1).parse(process.env.KIRO_CLI) })
const scope = { sessionID: "offline-direct", agent: "build", directory: `${root}/work` }
const lifetime = AbortSignal.timeout(10000)
const tools = [{ type: "function", function: { name: "qa_probe", description: "QA tool", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }]
const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({ role: z.literal("assistant"), content: z.string(), tool_calls: z.array(z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }), finish_reason: z.string() })) })
const checks: string[] = []
try {
  const message = { role: "user", content: "qa:tool" }
  const response = await bridge.handle({ model: "auto", messages: [message], tools }, scope, lifetime)
  assert.equal(response.status, 200)
  const first = completionSchema.parse(await response.json()).choices[0]; assert(first)
  const call = first.message.tool_calls?.[0]; assert(call)
  assert.equal(first.finish_reason, "tool_calls"); assert.equal(call.function.name, "qa_probe")
  assert.deepEqual(JSON.parse(call.function.arguments), { value: "offline-input" })
  const next = await bridge.handle({ model: "auto", messages: [message, first.message, { role: "tool", tool_call_id: call.id, content: "offline-secret-result" }], tools }, scope, lifetime)
  assert.equal(completionSchema.parse(await next.json()).choices[0]?.message.content, "offline-tool-roundtrip")
  assert.equal(traces().filter(event => event.event === "prompt").length, 1)
  checks.push("actual ACP permission + actual authenticated HTTP MCP tool/result across two segments, one prompt")
  for (const mode of ["qa:text", "qa:error", "qa:stream-error"]) {
    const response = await bridge.handle({ model: "auto", messages: [{ role: "user", content: mode }], stream: mode === "qa:stream-error" }, { ...scope, sessionID: mode }, lifetime)
    const body = await response.text()
    switch (mode) {
      case "qa:text": assert.equal(completionSchema.parse(JSON.parse(body)).choices[0]?.message.content, "offline-text"); break
      case "qa:error": assert.equal(response.status, 401); z.object({ error: z.object({ message: z.string() }) }).parse(JSON.parse(body)); break
      case "qa:stream-error": assert(body.includes('"error":')); assert(!body.includes("[DONE]")); break
      default: assert.fail(mode)
    }
    checks.push(mode)
  }
  const controller = new AbortController()
  const ready = new Promise<void>((resolve, reject) => {
    const watcher = watch(root, (_event, file) => { if (file === "trace.jsonl" && traces().some(event => event.event === "ready")) { watcher.close(); lifetime.removeEventListener("abort", aborted); resolve() } })
    const aborted = () => { watcher.close(); reject(lifetime.reason) }
    lifetime.addEventListener("abort", aborted, { once: true })
  })
  const pending = bridge.handle({ model: "auto", messages: [{ role: "user", content: "qa:abort" }] }, { ...scope, sessionID: "abort" }, controller.signal)
  const rejected = assert.rejects(pending, { name: "AbortError" })
  await ready; controller.abort(); await rejected
  checks.push("event-driven abort")
} finally {
  await bridge.close()
  for (const child of traces().filter(event => event.event === "mcp-ready")) {
    assert.equal(existsSync(child.cwd), false)
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" })
    assert(child.url); await assert.rejects(fetch(child.url, { signal: AbortSignal.timeout(1000) }))
  }
  assert.equal(readFileSync(`${root}/home/keep-user-data`, "utf8"), "owned-fixture-preserve")
  checks.push("scratch/process/endpoint cleanup; user fixture preserved")
  writeFileSync(`${root}/direct-evidence.json`, JSON.stringify({ root, checks }, null, 2))
  console.log(JSON.stringify({ root, checks }))
}
