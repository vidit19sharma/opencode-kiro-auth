import { appendFileSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { createHash, randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { z } from "zod"
import { PNG } from "./image.ts"

const tracePath = z.string().min(1).parse(process.env.KIRO_QA_TRACE)
const trace = (event: string, data: Readonly<Record<string, unknown>> = {}) =>
  appendFileSync(tracePath, JSON.stringify({ event, pid: process.pid, cwd: process.cwd(), ...data }) + "\n")
const args = process.argv.slice(2)
trace("cli", { args })
switch (args[0]) {
  case "--version": console.log("kiro-cli 2.33.1"); process.exit(0)
  case "whoami": console.log('{"accountType":"BuilderId"}\nnon-JSON informational footer'); process.exit(0)
  case "chat":
    assert.deepEqual(args, ["chat", "--list-models", "--format", "json"])
    console.log(JSON.stringify({ models: [{ model_id: "auto", model_name: "Offline", context_window_tokens: 200000, rate_multiplier: 1 }] })); process.exit(0)
  case "acp": break
  default: assert.fail(`Unexpected fake CLI command: ${JSON.stringify(args)}`)
}
assert.deepEqual(args, ["acp", "--agent-engine", "v2", "--agent", "opencode", "--model", "auto"])
const agent = z.object({ mcpServers: z.object({ opencode: z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()) }) }) })
  .parse(JSON.parse(readFileSync(".kiro/agents/opencode.json", "utf8"))).mcpServers.opencode
const wire = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional() })
const send = (value: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n")
const nativeID = `offline-${randomUUID()}`
let mcpSession = "", sequence = 0
const lifetime = new AbortController()
const permissions = new Map<string, (value: unknown) => void>()
const turns = new Map<string | number, AbortController>()
async function mcp(method: string, params: object = {}) {
  const notification = method.startsWith("notifications/")
  const response = await fetch(agent.url, { method: "POST", signal: lifetime.signal,
    headers: { ...agent.headers, "content-type": "application/json", ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++sequence }), method, params }) })
  assert.equal(response.ok, true, `MCP ${method}: ${response.status}`)
  if (notification) { await response.text(); return {} }
  const raw = await response.text()
  if (method === "initialize") trace("initialize-response", { status: response.status, body: raw, headers: Object.fromEntries(response.headers), url: agent.url })
   const body = z.object({ result: z.unknown().optional(), error: z.unknown().optional() }).parse(JSON.parse(raw))
   if (method === "tools/call" && body.error !== undefined) {
     z.object({ code: z.literal(-32800) }).parse(body.error)
     trace("tool-released", { nativeID }); return body
   }
  assert.equal(body.error, undefined, JSON.stringify(body.error))
  if (method === "initialize") mcpSession = z.string().min(1).parse(response.headers.get("mcp-session-id"))
  return body
}
const text = (value: string) => send({ method: "session/update", params: { sessionId: nativeID, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } } })
async function prompt(id: string | number, params: Readonly<Record<string, unknown>>) {
  const controller = new AbortController(); turns.set(id, controller)
  const blocks = z.array(z.discriminatedUnion("type", [z.object({ type: z.literal("text"), text: z.string() }).strict(), z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).strict()])).parse(params.prompt)
  const raw = blocks.flatMap(item => {
    switch (item.type) {
      case "text": return [item.text]
      case "image": return []
      default: { const exhaustive: never = item; throw exhaustive }
    }
  }).join("")
  const mode = z.enum(["qa:image", "qa:text", "qa:tool", "qa:tool-abort", "qa:abort", "qa:error", "qa:stream-error"]).parse([...raw.matchAll(/qa:(?:stream-error|tool-abort|image|text|tool|abort|error)/gu)].at(-1)?.[0])
  trace("prompt", { nativeID, mode })
  switch (mode) {
    case "qa:image": {
      const images = blocks.filter(block => block.type === "image")
      assert.equal(images.length, 1)
      const image = images[0]; assert(image)
      assert.equal(image.mimeType, "image/png"); assert(image.data === PNG, "image bytes mismatch")
      trace("image-received", { nativeID, bytes: Buffer.from(image.data, "base64").length, sha256: createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") })
      text("offline-image-ok"); send({ id, result: { stopReason: "end_turn" } }); break
    }
    case "qa:abort": trace("ready", { nativeID }); return
    case "qa:error": send({ id, error: { code: 401, message: "offline-login-required" } }); break
    case "qa:stream-error": text("offline-partial"); send({ id, error: { code: 401, message: "offline-stream-error" } }); break
    case "qa:tool": case "qa:tool-abort": {
      const listed = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() })) }) }).parse(await mcp("tools/list"))
      assert(listed.result.tools.some(tool => tool.name === "qa_probe"))
      const permissionID = `permission-${++sequence}`
      const permitted = new Promise<unknown>(resolve => permissions.set(permissionID, resolve))
      send({ id: permissionID, method: "session/request_permission", params: { sessionId: nativeID,
        _meta: { mcpToolIdentity: { serverName: "opencode", toolName: "qa_probe" } }, toolCall: { toolCallId: "offline-advisory" }, options: [{ kind: "allow_once", optionId: "once" }] } })
      z.object({ outcome: z.object({ outcome: z.literal("selected"), optionId: z.literal("once") }) }).parse(await permitted)
      trace("permission-allowed", { nativeID })
      trace("tool-pending", { nativeID })
      const response = await mcp("tools/call", { name: "qa_probe", arguments: { value: mode === "qa:tool-abort" ? "offline-abort-input" : "offline-input" } })
      if (mode === "qa:tool-abort") { assert("error" in response); return }
      const result = z.object({ result: z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean() }) }).parse(response)
      assert.equal(result.result.isError, false)
      assert.equal(result.result.content[0]?.text, "offline-secret-result")
      trace("tool-result", { nativeID, matched: true }); text("offline-tool-roundtrip")
      send({ id, result: { stopReason: "end_turn" } }); break
    }
    case "qa:text": text("offline-text"); send({ id, result: { stopReason: "end_turn" } }); break
    default: { const exhaustive: never = mode; assert.fail(exhaustive) }
  }
  turns.delete(id)
}
const input = createInterface({ input: process.stdin })
input.on("line", line => {
  void (async () => {
    const rpc = wire.parse(JSON.parse(line))
    const params = rpc.params ?? {}
    if (!rpc.method && typeof rpc.id === "string") { permissions.get(rpc.id)?.(rpc.result); permissions.delete(rpc.id); return }
    switch (rpc.method) {
      case "initialize": {
        await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "offline-cli", version: "1" } })
        await mcp("notifications/initialized")
        await mcp("tools/list")
        const unauthorized = await fetch(agent.url, { method: "POST", signal: lifetime.signal })
        assert.equal(unauthorized.status, 401); await unauthorized.text()
        trace("mcp-ready", { url: agent.url, unauthorized: unauthorized.status })
        send({ id: rpc.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } }); return
      }
      case "session/new": send({ id: rpc.id, result: { sessionId: nativeID } }); return
      case "session/load": send({ id: rpc.id, result: {} }); return
      case "session/prompt": assert(rpc.id !== undefined); await prompt(rpc.id, params); return
      case "session/cancel":
        for (const [id, controller] of turns) { controller.abort(); send({ id, result: { stopReason: "cancelled" } }); turns.delete(id) }
        send({ method: "_kiro.dev/metadata", params: { sessionId: nativeID, turnDurationMs: 1 } }); trace("cancelled", { nativeID }); return
      default: assert.fail(`Unknown ACP method: ${rpc.method}`)
    }
  })().catch(error => { trace("fixture-error", { message: error instanceof Error ? error.message : String(error) }); console.error(error); process.exitCode = 1; input.close(); lifetime.abort(); process.stdin.destroy() })
})
input.on("close", () => { trace("exit", { nativeID }); lifetime.abort(); process.exit(process.exitCode ?? 0) })
