import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { z } from "zod"
import { createHash } from "node:crypto"
import { PNG } from "./fixtures/image.ts"
import type { AcpClientOptions, Bridge, PromptBlock, ToolCall, ToolEndpoint, ToolResult } from "../src/contracts.js"

const { createToolServer: realToolServer } = await import("../src/mcp.js")

const clients: AcpClientOptions[] = []
const calls: ((call: ToolCall) => void)[] = []
const prompts: { resolve: () => void; reject: (error: Error) => void; options: AcpClientOptions }[] = []
const promptBlocks: (readonly PromptBlock[])[] = []
const results: ToolResult[] = []
const released: Error[] = []
const closedClients: string[] = []
const opens: (string | undefined)[] = []
const cancelled: string[] = []
let initialization: Promise<void> | undefined
let imageCapability = true
let opening: Promise<void> | undefined
let autoList = true
let loadFailure: Error | undefined
const endpoints: ToolEndpoint[] = []
const endpointSessions = new Map<ToolEndpoint, string>()
const openedEndpoints = new Set<ToolEndpoint>()
async function wire(endpoint: ToolEndpoint, method: string, params: object = {}) {
  const session = endpointSessions.get(endpoint)
  const response = await fetch(endpoint.url, { method: "POST", headers: { ...endpoint.headers, "Content-Type": "application/json", ...(session ? { "Mcp-Session-Id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: 1 }), method, params }), signal: AbortSignal.timeout(1000) })
  if (method === "initialize") endpointSessions.set(endpoint, response.headers.get("Mcp-Session-Id") ?? "")
  return response
}
let settleFinishes = true
let bridge: Bridge | undefined
mock.module("../src/models.js", () => ({ currentModels: async () => [{ id: "auto" }, { id: "other" }] }))
mock.module("../src/acp.js", () => ({ createAcpClient: (options: AcpClientOptions) => {
  clients.push(options)
  let clientClosed = false
  return { get capabilities() { return { image: imageCapability } }, initialize: async () => { await initialization }, open: async (_cwd: string, resume?: string) => {
    opens.push(resume)
    const endpoint = endpoints.at(-1); if (!endpoint) throw new Error("missing endpoint")
    await opening
    if (clientClosed) throw new Error("client closed")
    if (resume && loadFailure) throw loadFailure
    await wire(endpoint, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } })
    await wire(endpoint, "notifications/initialized")
    openedEndpoints.add(endpoint)
    if (autoList) await wire(endpoint, "tools/list")
    return resume ?? `native-${clients.length}`
  },
    prompt: (_sessionID: string, blocks: readonly PromptBlock[]) => new Promise((resolve, reject) => { promptBlocks.push(blocks); prompts.push({ resolve: () => resolve({ stopReason: "end_turn" }), reject, options }); if (loadFailure) resolve({ stopReason: "end_turn" }) }),
    cancel: (id: string) => { cancelled.push(id) }, quiesce: async () => true, close: async () => { clientClosed = true; closedClients.push(options.cwd) } }
} }))
mock.module("../src/mcp.js", () => ({ createToolServer: async () => {
  const server = await realToolServer()
  return { endpoint: (scope: Parameters<typeof server.endpoint>[0], onCall: (call: ToolCall) => void) => {
    calls.push(onCall)
    const nativeCalls = new Set<string>()
    const endpoint = server.endpoint(scope, call => { nativeCalls.add(call.callID); onCall(call) }); endpoints.push(endpoint)
    return { url: endpoint.url, headers: endpoint.headers, get approvedTools() { return endpoint.approvedTools },
      setTools: endpoint.setTools, waitReady: endpoint.waitReady,
      settle: (result: ToolResult) => { if (nativeCalls.delete(result.callID)) endpoint.settle(result); results.push(result); if (settleFinishes) { const p = prompts.at(-1); p?.options.onEvent({ type: "text", sessionID: `native-${clients.length}`, text: String(result.content) }); p?.resolve() } },
      release: (error: Error) => { released.push(error); endpoint.release(error) }, close: endpoint.close }
  }, close: server.close }
} }))
const { createBridge } = await import("../src/bridge.js")
const scope = { sessionID: "one", agent: "build", directory: "/project" }
const message = { role: "user", content: "hello" }
const body = { model: "auto", messages: [message] }
const signal = () => new AbortController().signal
async function until(condition: () => boolean) { const deadline = performance.now() + 1000; while (!condition()) { if (performance.now() >= deadline) throw new Error("fixture event deadline exceeded"); await new Promise(resolve => setImmediate(resolve)) } }
async function started() { await until(() => prompts.length > 0) }
afterEach(async () => { await bridge?.close(); bridge = undefined; initialization = undefined; opening = undefined; autoList = true; loadFailure = undefined; endpoints.length = 0; endpointSessions.clear(); openedEndpoints.clear(); settleFinishes = true; clients.length = 0; calls.length = 0; prompts.length = 0; promptBlocks.length = 0; results.length = 0; released.length = 0; closedClients.length = 0; opens.length = 0; cancelled.length = 0; mock.restore() })
afterEach(() => { imageCapability = true })

const imagePart = (url = `data:image/png;base64,${PNG}`) => ({ type: "image_url", image_url: { url } })
const imageMessage = { role: "user", content: [{ type: "text", text: "inspect" }, imagePart(), { type: "text", text: "after" }] }
test("preserves native image bytes and part order when current user input has a PNG", async () => {
  // Given a mixed current user message.
  bridge = await createBridge({ executable: "fake" })
  // When it starts a native turn.
  const pending = bridge.handle({ ...body, messages: [imageMessage] }, scope, signal())
  await Promise.race([started(), pending.then(response => { expect(response.status).toBe(200) })])
  prompts[0]?.resolve(); await pending
  // Then native blocks preserve exact bytes and relative order without diagnostic payload dumps.
  expect(JSON.stringify(promptBlocks[0]) === JSON.stringify([{ type: "text", text: "inspect" }, { type: "image", data: PNG, mimeType: "image/png" }, { type: "text", text: "after" }])).toBe(true)
})

for (const [url, reason] of [
  ["https://example.invalid/image.png", "External image URLs are not fetched; attach the image instead"],
  ["http://example.invalid/image.png", "External image URLs are not fetched; attach the image instead"],
  ["file:///probe.png", "External image URLs are not fetched; attach the image instead"],
  ["data:image/svg+xml;base64,AAAA", "Unsupported image MIME type"],
  ["data:image/png,AAAA", "Image must be a base64 data URL"],
  ["data:image/png;base64,", "Invalid image base64"],
  ["data:image/png;base64,AA A=", "Invalid image base64"],
  ["data:image/png;base64,!!!!", "Invalid image base64"],
  ["data:image/png;base64,AB==", "Invalid image base64"],
  ["data:image/png;base64,AAA", "Invalid image base64"],
  [`data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")}`, "Image exceeds 5 MiB decoded cap"],
] as const) test(`rejects image input when validation yields ${reason} (${url.startsWith("data:") ? url.length : url.split(":")[0]})`, async () => {
  // Given an invalid attachment; When parsed; Then it fails closed before prompting.
  bridge = await createBridge({ executable: "fake" })
  const response = await bridge.handle({ ...body, messages: [{ role: "user", content: [imagePart(url)] }] }, scope, signal())
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: reason } }); expect(prompts).toHaveLength(0)
})

test("rejects a 5 MiB plus one byte image before decoding its payload", async () => {
  // Given canonical base64 sharing the encoded length of an allowed 5 MiB image.
  const data = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")
  const original = Buffer.from
  let decodedCalls = 0
  spyOn(Buffer, "from").mockImplementation(new Proxy(original, { apply(target, receiver, args: readonly unknown[]) {
    if (args[0] === data && args[1] === "base64") decodedCalls++
    return Reflect.apply(target, receiver, args)
  } }))
  bridge = await createBridge({ executable: "fake" })
  // When the bridge parses the oversized image.
  const response = await bridge.handle({ ...body, messages: [{ role: "user", content: [imagePart(`data:image/png;base64,${data}`)] }] }, scope, signal())
  // Then the cap rejects it before Buffer.from can allocate the decoded payload.
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: "Image exceeds 5 MiB decoded cap" } })
  expect(decodedCalls).toBe(0)
})

test("rejects the third 5 MiB image before decoding beyond the request cap", async () => {
  // Given three individually allowed images.
  const data = Buffer.alloc(5 * 1024 * 1024).toString("base64")
  const part = imagePart(`data:image/png;base64,${data}`)
  const original = Buffer.from
  let decodedCalls = 0
  spyOn(Buffer, "from").mockImplementation(new Proxy(original, { apply(target, receiver, args: readonly unknown[]) {
    if (args[0] === data && args[1] === "base64") decodedCalls++
    return Reflect.apply(target, receiver, args)
  } }))
  bridge = await createBridge({ executable: "fake" })
  // When the third image would exceed the aggregate bound.
  const response = await bridge.handle({ ...body, messages: [{ role: "user", content: [part, part, part] }] }, scope, signal())
  // Then only the two images within the cap have been decoded.
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: "Images exceed 10 MiB decoded request cap" } })
  expect(decodedCalls).toBe(2)
})

test("rejects image input when request total exceeds 10 MiB", async () => {
  // Given individually permitted images; When their sum exceeds the request cap; Then no prompt is sent.
  bridge = await createBridge({ executable: "fake" })
  const part = imagePart(`data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024).toString("base64")}`)
  const response = await bridge.handle({ ...body, messages: [{ role: "user", content: [part, part, imagePart()] }] }, scope, signal())
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: "Images exceed 10 MiB decoded request cap" } }); expect(prompts).toHaveLength(0)
})
for (const role of ["assistant", "system", "developer", "tool"]) test(`rejects image input when role is ${role}`, async () => {
  // Given an image outside user input; When parsed; Then the existing modality error remains.
  bridge = await createBridge({ executable: "fake" })
  const response = await bridge.handle({ ...body, messages: [{ role, content: [imagePart()] }] }, scope, signal())
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: "Images and other modalities are unsupported" } }); expect(prompts).toHaveLength(0)
})
test("rejects image input when initialize does not advertise support", async () => {
  // Given a text-only engine; When an image request arrives; Then capability rejection precedes prompt.
  imageCapability = false; bridge = await createBridge({ executable: "fake" })
  const response = await bridge.handle({ ...body, messages: [imageMessage] }, scope, signal())
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: "This Kiro CLI/engine does not advertise image input" } }); expect(prompts).toHaveLength(0)
})
test("rejects an unsupported image on a cold scope before opening a native session", async () => {
  // Given a cold scope whose engine advertises no image capability.
  imageCapability = false; bridge = await createBridge({ executable: "fake" })
  // When a valid image arrives before any session exists.
  const response = await bridge.handle({ ...body, messages: [imageMessage] }, scope, signal())
  // Then initialization rejects the image without session/new or prompt.
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: "This Kiro CLI/engine does not advertise image input" } })
  expect(opens).toHaveLength(0); expect(prompts).toHaveLength(0)
})
test("replays descriptors without pixels when image history is reconstructed", async () => {
  // Given historical image input followed by a fresh text message.
  bridge = await createBridge({ executable: "fake" })
  const pending = bridge.handle({ ...body, messages: [imageMessage, { role: "assistant", content: "seen" }, message] }, scope, signal())
  // When reconstruction prompts the native session.
  await started(); prompts[0]?.resolve(); await pending
  // Then only the compact descriptor is replayed.
  const block = promptBlocks[0]?.[0]; if (block?.type !== "text") throw new Error("missing replay")
  const replay = z.object({ messages: z.array(z.object({ parts: z.array(z.unknown()).optional() })) }).parse(JSON.parse(block.text.split("\n")[1] ?? ""))
  expect(replay.messages[0]?.parts).toContainEqual({ type: "image_omitted", mimeType: "image/png", bytes: Buffer.from(PNG, "base64").length, sha256: createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex") })
  expect(block.text.includes(PNG)).toBe(false)
})
test("retains the native session when image descriptors match the resent prefix", async () => {
  // Given a completed native image turn.
  bridge = await createBridge({ executable: "fake" })
  const first = bridge.handle({ ...body, messages: [imageMessage] }, scope, signal()); await started(); prompts[0]?.resolve()
  const assistant = (await (await first).json()).choices[0].message
  // When the host resends its image history with fresh text.
  const next = bridge.handle({ ...body, messages: [imageMessage, assistant, message] }, scope, signal()); await until(() => prompts.length === 2); prompts[1]?.resolve(); await next
  // Then only fresh input is prompted on the same client/session.
  expect(clients).toHaveLength(1); expect(opens).toEqual([undefined]); expect(promptBlocks[1]).toEqual([{ type: "text", text: "hello" }])
})

test("sends current user input outside executed history when starting a native turn", async () => {
  // Given the sanitized current-input shape from the failed native run.
  const saved = z.object({ prompt: z.array(z.object({ text: z.string() })).min(1) }).parse(JSON.parse(readFileSync(new URL("./fixtures/native-role-refusal.json", import.meta.url), "utf8")))
  const block = saved.prompt[0]?.text ?? ""
  const input = z.object({ messages: z.array(z.object({ role: z.literal("user"), content: z.string() })) }).parse(JSON.parse(block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"))))
  bridge = await createBridge({ executable: "fake" })
  // When OpenCode starts that turn.
  const pending = bridge.handle({ ...body, messages: input.messages }, scope, signal()); await started()
  prompts[0]?.resolve(); await pending
  // Then the current message is a native user block, not already-executed role data.
  expect(promptBlocks[0]).toEqual(input.messages.map(item => ({ type: "text", text: item.content })))
})

test("keeps replayed tool results separate when reconstructing with fresh user input", async () => {
  // Given executed history followed by two fresh user blocks.
  const history = [message, { role: "assistant", content: "", tool_calls: [{ id: "old", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "old", content: "old-result" }]
  const current = [{ role: "user", content: "current-a" }, { role: "user", content: "current-b" }]
  bridge = await createBridge({ executable: "fake" })
  // When reconstructing a new native session.
  const pending = bridge.handle({ ...body, messages: [...history, ...current] }, scope, signal()); await started()
  prompts[0]?.resolve(); await pending
  // Then only history is marked already executed; current input remains outside it.
  const blocks = promptBlocks[0] ?? []; const first = blocks[0]; const replay = first?.type === "text" ? first.text : ""
  const replayData: unknown = JSON.parse(replay.slice(replay.indexOf("\n") + 1, replay.lastIndexOf("\n")))
  expect(replayData).toEqual({ kind: "reconstructed_role_history", alreadyExecuted: true, messages: history })
  expect(blocks.slice(1)).toEqual(current.map(item => ({ type: "text", text: item.content })))
})

test("nonstream answer omits usage and ignores advisory metadata", async () => {
  bridge = await createBridge({ executable: "fake" })
  const response = bridge.handle(body, scope, signal()); await started()
  prompts[0]?.options.onEvent({ type: "metadata", sessionID: "native-1", value: { reasoning: "hidden" } })
  prompts[0]?.options.onEvent({ type: "text", sessionID: "native-1", text: "answer" }); prompts[0]?.resolve()
  expect(await (await response).json()).toMatchObject({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] })
})
test("parked native result resumes the same prompt", async () => {
  bridge = await createBridge({ executable: "fake" })
  const first = bridge.handle(body, scope, signal()); await started()
  calls[0]?.({ callID: "call-1", name: "read", arguments: "{}" })
  const completion = await (await first).json()
  const assistant = completion.choices[0].message
  const next = await bridge.handle({ ...body, messages: [message, assistant, { role: "tool", tool_call_id: "call-1", content: "secret" }] }, scope, signal())
  expect(await next.json()).toMatchObject({ choices: [{ message: { content: "secret" } }] })
  expect(prompts.length).toBe(1); expect(results.map(result => result.callID)).toEqual(["call-1"])
  expect((await bridge.handle({ ...body, messages: [message, assistant, { role: "tool", tool_call_id: "call-1", content: "secret" }] }, scope, signal())).status).toBe(409)
})
test("rejects images explicitly", async () => {
  bridge = await createBridge({ executable: "fake" })
  expect((await bridge.handle({ ...body, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "private" } }] }] }, scope, signal())).status).toBe(400)
})
test("already aborted request rejects with AbortError", async () => {
  bridge = await createBridge({ executable: "fake" }); const controller = new AbortController(); controller.abort()
  await expect(bridge.handle(body, scope, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
})

test("SSE emits text and success terminator without usage", async () => {
  bridge = await createBridge({ executable: "fake" })
  const pending = bridge.handle({ ...body, stream: true }, scope, signal()); await started()
  prompts[0]?.options.onEvent({ type: "text", sessionID: "native-1", text: "hello" }); prompts[0]?.resolve()
  const wire = await (await pending).text()
  const frames = wire.split("\n\n").filter(Boolean).map(line => line.slice(6))
  expect(frames.at(-1)).toBe("[DONE]")
  const values = frames.slice(0, -1).map(frame => JSON.parse(frame))
  expect(values.map(value => value.choices[0].delta)).toEqual([{ role: "assistant", content: "" }, { content: "hello" }, {}])
  expect(values.every(value => !("usage" in value))).toBe(true)
})
test("upstream failure before content is non2xx with sanitized error data", async () => {
  bridge = await createBridge({ executable: "fake" })
  const pending = bridge.handle({ ...body, stream: true }, scope, signal()); await started()
  const error = Object.assign(new Error("RPC failure"), { data: { message: "HTTP 429 Bearer secret" } }); prompts[0]?.reject(error)
  const response = await pending
  expect(response.status).toBe(429); expect(JSON.stringify(await response.json())).not.toContain("secret")
})
test("upstream error after text emits one error without success", async () => {
  bridge = await createBridge({ executable: "fake" })
  const pending = bridge.handle({ ...body, stream: true }, scope, signal()); await started()
  prompts[0]?.options.onEvent({ type: "text", sessionID: "native-1", text: "partial" })
  prompts[0]?.reject(new Error("broken"))
  const wire = await (await pending).text()
  expect(wire).toContain('"error":'); expect(wire).not.toContain("[DONE]"); expect(wire).not.toContain('"finish_reason":"stop"')
})
test("abort before first byte rejects pending HTTP", async () => {
  bridge = await createBridge({ executable: "fake" }); const controller = new AbortController()
  const pending = bridge.handle(body, scope, controller.signal); await started(); controller.abort()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
})
test("stream reader cancellation releases native gates", async () => {
  bridge = await createBridge({ executable: "fake" })
  const pending = bridge.handle({ ...body, stream: true }, scope, signal()); await started()
  prompts[0]?.options.onEvent({ type: "text", sessionID: "native-1", text: "partial" })
  const response = await pending; await response.body?.cancel()
  expect(released[0]?.name).toBe("AbortError")
})
test("completed tool segment detaches caller abort while parked", async () => {
  bridge = await createBridge({ executable: "fake" }); const controller = new AbortController()
  const pending = bridge.handle(body, scope, controller.signal); await started()
  calls[0]?.({ callID: "parked", name: "read", arguments: "{}" }); await pending; controller.abort()
  expect(released).toHaveLength(0)
  bridge.observe(scope.sessionID, "deleted"); expect(released).toHaveLength(1)
})
test("multiple and late native calls survive separate HTTP segments", async () => {
  bridge = await createBridge({ executable: "fake" }); settleFinishes = false
  const first = bridge.handle(body, scope, signal()); await started()
  calls[0]?.({ callID: "a", name: "read", arguments: "{}" }); calls[0]?.({ callID: "b", name: "read", arguments: "{}" })
  const assistant = (await (await first).json()).choices[0].message
  expect(assistant.tool_calls.map((c: { id: string }) => c.id)).toEqual(["a", "b"])
  calls[0]?.({ callID: "late", name: "read", arguments: "{}" })
  const wrong = await bridge.handle({ ...body, messages: [message, assistant, { role: "tool", tool_call_id: "foreign", content: "bad" }] }, scope, signal())
  expect(wrong.status).toBe(409); expect(results).toHaveLength(0)
  const history = [message, assistant, { role: "tool", tool_call_id: "b", content: "B" }, { role: "tool", tool_call_id: "a", content: "A" }]
  const second = await bridge.handle({ ...body, messages: history }, scope, signal())
  const late = (await second.json()).choices[0].message
  expect(late.tool_calls.map((c: { id: string }) => c.id)).toEqual(["late"])
  settleFinishes = true
  const final = await bridge.handle({ ...body, messages: [...history, late, { role: "tool", tool_call_id: "late", content: "final" }] }, scope, signal())
  expect((await final.json()).choices[0].message.content).toBe("final")
  expect(results.map(result => result.callID)).toEqual(["b", "a", "late"])
  expect(prompts).toHaveLength(1)
})
test("changed system preserves native session and writes private instructions atomically", async () => {
  bridge = await createBridge({ executable: "fake" })
  const first = bridge.handle(body, scope, signal()); await started(); prompts[0]?.resolve()
  const assistant = (await (await first).json()).choices[0].message
  const next = bridge.handle({ ...body, messages: [{ role: "system", content: "new instructions" }, message, assistant, { role: "user", content: "next" }] }, scope, signal())
  await until(() => prompts.length >= 2)
  prompts[1]?.resolve(); await next
  expect(clients).toHaveLength(1)
  const cwd = clients[0]?.cwd; if (!cwd) throw new Error("missing cwd")
  expect(statSync(cwd).mode & 0o777).toBe(0o700); expect(statSync(`${cwd}/AGENTS.md`).mode & 0o777).toBe(0o600)
  const config = JSON.parse(readFileSync(`${cwd}/.kiro/agents/opencode.json`, "utf8"))
  expect(config).toMatchObject({ tools: ["@opencode"], includeMcpJson: false, mcpServers: { opencode: { timeout: 7200000, headers: endpoints[0]?.headers } } })
})
test("distinct scopes create distinct native sessions even for byte-identical input", async () => {
  bridge = await createBridge({ executable: "fake" })
  const a = bridge.handle(body, scope, signal()); await started()
  const b = bridge.handle(body, { ...scope, directory: "/another" }, signal())
  await until(() => prompts.length >= 2)
  for (const prompt of prompts) prompt.resolve(); await Promise.all([a, b])
  expect(clients).toHaveLength(2); expect(clients[0]?.cwd).not.toBe(clients[1]?.cwd)
})
test("model divergence reconstructs instead of reusing native session", async () => {
  bridge = await createBridge({ executable: "fake" })
  const a = bridge.handle(body, scope, signal()); await started(); prompts[0]?.resolve(); const assistant = (await (await a).json()).choices[0].message
  const b = bridge.handle({ ...body, model: "other", messages: [message, assistant, { role: "user", content: "next" }] }, scope, signal())
  await until(() => prompts.length >= 2)
  prompts[1]?.resolve(); await b
  expect(opens).toEqual([undefined, undefined]); expect(clients[1]?.args.at(-1)).toBe("other")
})
test("two hour timer releases parked work; busy status cannot evict it", async () => {
  const scheduled = new Map<number, () => void>(); const original = globalThis.setTimeout
  spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(original, { apply(target, _receiver, args: readonly unknown[]) {
    const [callback, delay, ...values] = args
    if (typeof callback !== "function" || (delay !== undefined && typeof delay !== "number")) throw new Error("invalid fixture timer")
    const timer = target(() => callback(...values), delay)
    scheduled.set(Number(delay), () => { clearTimeout(timer); callback(...values) })
    return timer
  } }))
  bridge = await createBridge({ executable: "fake" })
  const a = bridge.handle(body, scope, signal()); await started(); calls[0]?.({ callID: "a", name: "read", arguments: "{}" }); await a
  bridge.observe(scope.sessionID, "busy"); expect(scheduled.has(600000)).toBe(false)
  scheduled.get(7200000)?.(); expect(released.at(-1)).toMatchObject({ status: 504 })
})
test("quiescent idle closes child and subsequent request loads same owned cwd", async () => {
  const scheduled = new Map<number, () => void>(); const original = globalThis.setTimeout
  spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(original, { apply(target, _receiver, args: readonly unknown[]) {
    const [callback, delay, ...values] = args
    if (typeof callback !== "function" || (delay !== undefined && typeof delay !== "number")) throw new Error("invalid fixture timer")
    const timer = target(() => callback(...values), delay)
    scheduled.set(Number(delay), () => { clearTimeout(timer); callback(...values) })
    return timer
  } }))
  bridge = await createBridge({ executable: "fake" })
  const a = bridge.handle(body, scope, signal()); await started(); prompts[0]?.resolve(); const assistant = (await (await a).json()).choices[0].message
  scheduled.get(600000)?.()
  const b = bridge.handle({ ...body, messages: [message, assistant, { role: "user", content: "next" }] }, scope, signal())
  await until(() => prompts.length >= 2)
  prompts[1]?.resolve(); await b
  expect(opens).toEqual([undefined, "native-1"]); expect(clients[0]?.cwd).toBe(clients[1]?.cwd)
})
test("dispose waits for initialization and prevents post-dispose native open", async () => {
  let ready: (() => void) | undefined
  initialization = new Promise<void>(resolve => { ready = resolve })
  bridge = await createBridge({ executable: "fake" })
  const pending = bridge.handle(body, scope, signal())
  for (let i = 0; clients.length === 0 && i < 100; i++) await new Promise(resolve => setImmediate(resolve))
  const closing = bridge.close(); ready?.()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" }); await closing
  expect(opens).toHaveLength(0)
})
test("schema refresh respawns and loads instead of trusting in-process schemas", async () => {
  bridge = await createBridge({ executable: "fake" })
  const a = bridge.handle(body, scope, signal()); await started(); prompts[0]?.resolve(); const assistant = (await (await a).json()).choices[0].message
  const b = bridge.handle({ ...body, tools: [{ type: "function", function: { name: "new_tool", parameters: { type: "object" } } }], messages: [message, assistant, { role: "user", content: "next" }] }, scope, signal())
  await until(() => prompts.length >= 2)
  prompts[1]?.resolve(); await b
  expect(opens).toEqual([undefined, "native-1"]); expect(closedClients).toHaveLength(1)
})
test("duplicate active request conflicts without unlocking the running segment", async () => {
  bridge = await createBridge({ executable: "fake" })
  const a = bridge.handle(body, scope, signal()); await started()
  expect((await bridge.handle(body, scope, signal())).status).toBe(409)
  expect((await bridge.handle(body, scope, signal())).status).toBe(409)
  prompts[0]?.resolve(); expect((await a).status).toBe(200); expect(prompts).toHaveLength(1)
})
test("changed history prefix creates a fresh native identity", async () => {
  bridge = await createBridge({ executable: "fake" })
  const a = bridge.handle(body, scope, signal()); await started(); prompts[0]?.resolve(); await a
  const b = bridge.handle({ ...body, messages: [{ role: "user", content: "compacted" }] }, scope, signal())
  await until(() => prompts.length >= 2)
  prompts[1]?.resolve(); await b; expect(opens).toEqual([undefined, undefined])
})
test("changed held instructions rebuild with supplied results without settling stale gate", async () => {
  bridge = await createBridge({ executable: "fake" })
  const a = bridge.handle(body, scope, signal()); await started(); calls[0]?.({ callID: "a", name: "read", arguments: "{}" })
  const assistant = (await (await a).json()).choices[0].message
  const b = bridge.handle({ ...body, messages: [{ role: "system", content: "updated" }, message, assistant, { role: "tool", tool_call_id: "a", content: "known result" }] }, scope, signal())
  await until(() => prompts.length >= 2)
  prompts[1]?.resolve(); await b
  expect(results).toHaveLength(0); expect(opens).toEqual([undefined, undefined]); expect(released).toHaveLength(1)
})
test("midstream abort errors the stream and disposal removes only owned scratch", async () => {
  bridge = await createBridge({ executable: "fake" }); const controller = new AbortController()
  const a = bridge.handle({ ...body, stream: true }, scope, controller.signal); await started()
  prompts[0]?.options.onEvent({ type: "text", sessionID: "native-1", text: "partial" }); const response = await a
  controller.abort(); await expect(response.text()).rejects.toMatchObject({ name: "AbortError" })
  const cwd = clients[0]?.cwd; if (!cwd) throw new Error("missing cwd")
  await bridge.close(); await bridge.close(); expect(() => statSync(cwd)).toThrow()
})

test("open success waits for current MCP inventory before the first prompt and schema reload", async () => {
  autoList = false; bridge = await createBridge({ executable: "fake" })
  const pending = bridge.handle(body, scope, signal())
  await until(() => openedEndpoints.size >= 1)
  await new Promise(resolve => setImmediate(resolve))
  expect(prompts).toHaveLength(0)
  const endpoint = endpoints[0]; if (!endpoint) throw new Error("missing endpoint")
  await wire(endpoint, "tools/list"); await started(); prompts[0]?.resolve()
  const assistant = (await (await pending).json()).choices[0].message
  const next = bridge.handle({ ...body, tools: [{ type: "function", function: { name: "new_tool", parameters: { type: "object" } } }], messages: [message, assistant, { role: "user", content: "next" }] }, scope, signal())
  await until(() => openedEndpoints.size >= 2)
  await new Promise(resolve => setImmediate(resolve))
  expect(prompts).toHaveLength(1)
  const current = endpoints[1]; if (!current) throw new Error("missing reload endpoint")
  expect((await wire(endpoint, "tools/list")).status).toBe(404)
  await wire(current, "tools/list")
  await until(() => prompts.length >= 2)
  prompts[1]?.resolve(); expect((await next).status).toBe(200)
})

for (const phase of ["initialize", "open", "readiness"] as const) {
  test(`request abort rejects promptly during ${phase}`, async () => {
    const ready = Promise.withResolvers<void>()
    switch (phase) {
      case "initialize": initialization = ready.promise; break
      case "open": opening = ready.promise; break
      case "readiness": autoList = false; break
    }
    bridge = await createBridge({ executable: "fake" }); const controller = new AbortController()
    const pending = bridge.handle(body, scope, controller.signal)
    const outcome = pending.then(response => response, error => error)
    await until(() => phase === "initialize" ? clients.length > 0 : phase === "open" ? opens.length > 0 : openedEndpoints.size > 0)
    controller.abort()
    try { expect(await Promise.race([outcome, new Promise((_, reject) => setTimeout(() => reject(new Error("abort stranded during setup")), 100))])).toMatchObject({ name: "AbortError" }) }
    finally { ready.resolve() }
    expect(prompts).toHaveLength(0)
  })
}

test("continuations preserve the original native-turn deadline", async () => {
  const scheduled = new Map<number, ReturnType<typeof setTimeout>>(); const original = globalThis.setTimeout
  const cleared = new Set<number>(); const originalClear = globalThis.clearTimeout
  let expire: (() => void) | undefined
  spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(original, { apply(target, _receiver, args: readonly unknown[]) {
    const [callback, delay, ...values] = args
    if (typeof callback !== "function" || (delay !== undefined && typeof delay !== "number")) throw new Error("invalid fixture timer")
    const timer = target(() => callback(...values), delay); scheduled.set(Number(delay), timer)
    if (delay === 7200000) expire = () => { originalClear(timer); callback(...values) }
    return timer
  } }))
  spyOn(globalThis, "clearTimeout").mockImplementation(timer => { cleared.add(Number(timer)); originalClear(Number(timer)) })
  bridge = await createBridge({ executable: "fake" }); settleFinishes = false
  const first = bridge.handle(body, scope, signal()); await started()
  const deadline = scheduled.get(7200000); if (!deadline) throw new Error("missing deadline")
  calls[0]?.({ callID: "a", name: "read", arguments: "{}" })
  const assistant = (await (await first).json()).choices[0].message
  calls[0]?.({ callID: "b", name: "read", arguments: "{}" })
  await bridge.handle({ ...body, messages: [message, assistant, { role: "tool", tool_call_id: "a", content: "done" }] }, scope, signal())
  expect(cleared.has(Number(deadline))).toBe(false)
  expect(scheduled.get(7200000)).toBe(deadline)
  expire?.(); expect(released.at(-1)).toMatchObject({ status: 504 })
})

test("deleted setup removes only its old scope and permits safe recreation", async () => {
  bridge = await createBridge({ executable: "fake" })
  const other = bridge.handle(body, { ...scope, sessionID: "unrelated" }, signal()); await started(); prompts[0]?.resolve(); await other
  const unrelated = clients[0]?.cwd; if (!unrelated) throw new Error("missing unrelated cwd")
  const ready = Promise.withResolvers<void>(); initialization = ready.promise
  const pending = bridge.handle(body, scope, signal()); const outcome = pending.then(response => response, error => error)
  await until(() => clients.length >= 2)
  const old = clients[1]?.cwd; if (!old) throw new Error("missing old cwd")
  bridge.observe(scope.sessionID, "deleted")
  initialization = undefined
  const recreated = bridge.handle(body, scope, signal())
  ready.resolve(); expect(await outcome).toMatchObject({ name: "AbortError" })
  await until(() => prompts.length >= 2)
  prompts[1]?.resolve(); expect((await recreated).status).toBe(200)
  await until(() => !existsSync(old))
  expect(existsSync(old)).toBe(false); expect(existsSync(unrelated)).toBe(true)
  expect(clients[2]?.cwd).not.toBe(old)
})

for (const code of ["IO", 429, 401, -32603] as const) {
  test(`load failure ${code} propagates without opening a fresh conversation`, async () => {
    const scheduled = new Map<number, () => void>(); const original = globalThis.setTimeout
    spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(original, { apply(target, _receiver, args: readonly unknown[]) {
      const [callback, delay, ...values] = args
      if (typeof callback !== "function" || (delay !== undefined && typeof delay !== "number")) throw new Error("invalid fixture timer")
      const timer = target(() => callback(...values), delay); scheduled.set(Number(delay), () => { clearTimeout(timer); callback(...values) }); return timer
    } }))
    bridge = await createBridge({ executable: "fake" })
    const first = bridge.handle(body, scope, signal()); await started(); prompts[0]?.resolve()
    const assistant = (await (await first).json()).choices[0].message
    scheduled.get(600000)?.(); loadFailure = Object.assign(new Error("load failed"), { code })
    const response = await bridge.handle({ ...body, messages: [message, assistant, { role: "user", content: "next" }] }, scope, signal())
    expect(response.status).toBe(code === 401 || code === 429 ? code : 502)
    expect(opens).toEqual([undefined, "native-1"])
  })
}

test("real MCP calls outside a native generation fail closed without parking", async () => {
  bridge = await createBridge({ executable: "fake" })
  const pending = bridge.handle({ ...body, tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }, scope, signal())
  await started(); prompts[0]?.resolve(); await pending
  const endpoint = endpoints[0]; if (!endpoint) throw new Error("missing endpoint")
  const response = await wire(endpoint, "tools/call", { name: "read" })
  expect(await response.json()).toMatchObject({ error: { code: -32603 } })
})

test("real loopback native call receives only its OpenCode continuation result", async () => {
  bridge = await createBridge({ executable: "fake" })
  const input = { ...body, tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }
  const pending = bridge.handle(input, scope, signal()); await started()
  const endpoint = endpoints[0]; if (!endpoint) throw new Error("missing endpoint")
  const nativeCall = wire(endpoint, "tools/call", { name: "read", arguments: { path: "file" } })
  const assistant = (await (await pending).json()).choices[0].message
  expect(assistant.tool_calls).toHaveLength(1)
  expect(assistant.tool_calls[0].function).toEqual({ name: "read", arguments: '{"path":"file"}' })
  const response = await bridge.handle({ ...input, messages: [message, assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "owned result" }] }, scope, signal())
  expect(await (await nativeCall).json()).toMatchObject({ result: { content: [{ type: "text", text: "owned result" }], isError: false } })
  expect(await response.json()).toMatchObject({ choices: [{ message: { content: "owned result" }, finish_reason: "stop" }] })
  expect(prompts).toHaveLength(1)
})

test("host idle abandons a parked tool and permits the next message in the same scope", async () => {
  // Given parked work and an unrelated running scope.
  bridge = await createBridge({ executable: "fake" })
  const input = { ...body, tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }
  const first = bridge.handle(input, scope, signal()); await started()
  const endpoint = endpoints[0]; if (!endpoint) throw new Error("missing endpoint")
  const native = wire(endpoint, "tools/call", { name: "read" })
  const assistant = (await (await first).json()).choices[0].message
  const other = bridge.handle(body, { ...scope, sessionID: "unrelated" }, signal())
  await until(() => prompts.length === 2)
  // When the host ends the tool-executing turn.
  bridge.observe(scope.sessionID, "idle"); bridge.observe(scope.sessionID, "idle")
  // Then its gate and client are released exactly once, with unrelated work intact.
  expect(await (await native).json()).toMatchObject({ error: { code: -32800 } })
  await until(() => closedClients.length === 1)
  expect(cancelled).toEqual(["native-1"]); expect(released).toHaveLength(1)
  prompts[1]?.resolve(); expect((await other).status).toBe(200)
  const next = bridge.handle({ ...input, messages: [message, assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "Tool execution aborted" }, { role: "user", content: "next" }] }, scope, signal())
  await until(() => prompts.length === 3); prompts[2]?.resolve()
  expect((await next).status).toBe(200); expect(opens).toEqual([undefined, undefined, undefined])
  expect((await bridge.handle({ ...input, messages: [message, assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "stale" }] }, scope, signal())).status).toBe(409)
})

test("fresh user suffix replaces held work without accepting a stale tool continuation", async () => {
  // Given a completed HTTP tool segment whose native turn remains parked.
  bridge = await createBridge({ executable: "fake" })
  const first = bridge.handle(body, scope, signal()); await started()
  calls[0]?.({ callID: "held", name: "read", arguments: "{}" })
  const assistant = (await (await first).json()).choices[0].message
  const history = [message, assistant]
  expect((await bridge.handle({ ...body, messages: [...history, { role: "tool", tool_call_id: "foreign", content: "stale" }] }, scope, signal())).status).toBe(409)
  expect((await bridge.handle({ ...body, messages: [...history, { role: "tool", tool_call_id: "held", content: "a" }, { role: "tool", tool_call_id: "held", content: "b" }] }, scope, signal())).status).toBe(409)
  expect((await bridge.handle({ ...body, messages: [...history, { role: "tool", tool_call_id: "held", content: "stale" }] }, { ...scope, agent: "plan" }, signal())).status).toBe(409)
  // When a fresh user suffix arrives before a host idle notification.
  const next = bridge.handle({ ...body, messages: [...history, { role: "user", content: "next" }] }, scope, signal())
  await until(() => prompts.length === 2)
  // Then the old generation cannot settle or emit into the replacement.
  expect(cancelled).toEqual(["native-1"]); expect(released).toHaveLength(1)
  prompts[0]?.options.onEvent({ type: "text", sessionID: "native-1", text: "stale" }); prompts[0]?.resolve()
  prompts[1]?.options.onEvent({ type: "text", sessionID: "native-2", text: "fresh" }); prompts[1]?.resolve()
  expect(await (await next).json()).toMatchObject({ choices: [{ message: { content: "fresh" } }] })
  expect(results).toHaveLength(0); expect(opens).toEqual([undefined, undefined])
})
