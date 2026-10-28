import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { request } from "node:http"
import * as nodeHttp from "node:http"
import { spyOn } from "bun:test"
import { createToolServer } from "../src/mcp.js"
import type { ToolCall, ToolEndpoint, ToolServer, ToolSpec } from "../src/contracts.js"

const servers: ToolServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })
const tool: ToolSpec = { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }
const scope = { sessionID: "session", agent: "agent", directory: "/project" }
async function fixture(onCall: (call: ToolCall) => void = () => {}) {
  const server = await createToolServer()
  servers.push(server)
  const endpoint = server.endpoint(scope, onCall)
  endpoint.setTools([tool])
  return { server, endpoint }
}
function http(endpoint: ToolEndpoint, body: unknown, options: { method?: string; headers?: Record<string, string>; rawHeaders?: readonly string[]; session?: string; raw?: string } = {}) {
  const headers = { ...endpoint.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...(options.session ? { "Mcp-Session-Id": options.session } : {}), ...options.headers }
  const req = request(endpoint.url, { method: options.method ?? "POST", headers: options.rawHeaders ?? headers })
  const response = new Promise<{ status: number; session: string; body: unknown }>((resolve, reject) => {
    req.on("error", reject)
    req.on("response", res => {
      const chunks: Buffer[] = []
      res.on("data", chunk => chunks.push(Buffer.from(chunk)))
      res.on("error", reject)
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString()
        const session = res.headers["mcp-session-id"]
        resolve({ status: res.statusCode ?? 0, session: typeof session === "string" ? session : "", body: text ? JSON.parse(text) : null })
      })
    })
  })
  req.end(options.raw ?? (body === undefined ? undefined : JSON.stringify(body)))
  return { response, req }
}
const rpc = (method: string, params: unknown = {}, id: number = 1) => ({ jsonrpc: "2.0", id, method, params })
async function initialize(endpoint: ToolEndpoint) {
  const init = await http(endpoint, rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } })).response
  assert.equal(init.status, 200)
  assert.partialDeepStrictEqual(init.body, { result: { capabilities: { tools: {} }, protocolVersion: "2025-11-25" } })
  const ready = await http(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, { session: init.session }).response
  assert.equal(ready.status, 202)
  return init.session
}

async function withoutHeadersDistinct(run: () => Promise<void>) {
  const original = nodeHttp.createServer
  const override = spyOn(nodeHttp, "createServer").mockImplementation(new Proxy(original, { apply(target, receiver, args: readonly unknown[]) {
    const server: unknown = Reflect.apply(target, receiver, args)
    if (!(server instanceof nodeHttp.Server)) throw new Error("missing HTTP server")
    server.prependListener("request", (incoming: nodeHttp.IncomingMessage) => { Object.defineProperty(incoming, "headersDistinct", { value: undefined }); incoming.socket.setTimeout(1000, () => incoming.socket.destroy()) })
    return server
  } }))
  try { await run() } finally { override.mockRestore() }
}

test("accepts valid authenticated headers without headersDistinct", async () => {
  await withoutHeadersDistinct(async () => {
    const { endpoint } = await fixture()
    const session = await initialize(endpoint)
    const response = await http(endpoint, rpc("tools/list"), { session }).response
    assert.equal(response.status, 200)
    assert.partialDeepStrictEqual(response.body, { result: { tools: [{ name: "echo" }] } })
  })
})

for (const [name, duplicate, status] of [
  ["Authorization", "aUtHoRiZaTiOn", 401], ["Host", "hOsT", 403], ["Origin", "oRiGiN", 403],
  ["Mcp-Session-Id", "mCp-SeSsIoN-iD", 404], ["MCP-Protocol-Version", "mCp-PrOtOcOl-VeRsIoN", 400],
  ["Content-Type", "cOnTeNt-TyPe", 415], ["Content-Encoding", "cOnTeNt-EnCoDiNg", 415],
] as const) {
  test(`rejects mixed-case duplicate ${name} without headersDistinct`, async () => {
    await withoutHeadersDistinct(async () => {
      const { endpoint } = await fixture()
      const session = await initialize(endpoint)
      const headers = { ...endpoint.headers, Host: new URL(endpoint.url).host, Origin: new URL(endpoint.url).origin, "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-11-25", "Content-Type": "application/json", "Content-Encoding": "identity" }
      const value = Object.entries(headers).find(([key]) => key === name)?.[1]
      if (value === undefined) throw new Error("missing fixture header")
      const response = await http(endpoint, rpc("tools/list"), { rawHeaders: [...Object.entries(headers).flat(), duplicate, value] }).response
      assert.equal(response.status, status)
    })
  })
}

test("readiness requires an authenticated current list on one initialized endpoint-local session", async () => {
  // Given
  const { server, endpoint } = await fixture()
  const other = server.endpoint(scope, () => {})
  const foreign = await initialize(other)
  const session = await initialize(endpoint)
  // When / Then: neither initialization nor another endpoint's session proves inventory delivery.
  await assert.rejects(endpoint.waitReady(new AbortController().signal, 10), { name: "TimeoutError" })
  assert.equal((await http(endpoint, rpc("tools/list"), { session: foreign }).response).status, 404)
  assert.equal((await http(endpoint, rpc("tools/list"), { session, headers: { Authorization: "Bearer wrong" } }).response).status, 401)
  await assert.rejects(endpoint.waitReady(new AbortController().signal, 10), { name: "TimeoutError" })
  const ready = endpoint.waitReady(new AbortController().signal, 1000)
  await http(endpoint, rpc("tools/list"), { session }).response
  await ready
  endpoint.setTools([{ ...tool, name: "new_inventory" }])
  await assert.rejects(endpoint.waitReady(new AbortController().signal, 10), { name: "TimeoutError" })
  await http(endpoint, rpc("tools/list"), { session }).response
  await endpoint.waitReady(new AbortController().signal, 1000)
  await http(endpoint, undefined, { session, method: "DELETE" }).response
  await assert.rejects(endpoint.waitReady(new AbortController().signal, 10), { name: "TimeoutError" })
})

test("a list without initialized on that same session cannot acknowledge readiness", async () => {
  // Given
  const { endpoint } = await fixture()
  await initialize(endpoint)
  const second = await http(endpoint, rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "other", version: "1" } })).response
  // When
  const listed = await http(endpoint, rpc("tools/list"), { session: second.session }).response
  // Then
  assert.partialDeepStrictEqual(listed.body, { error: { code: -32600 } })
  await assert.rejects(endpoint.waitReady(new AbortController().signal, 10), { name: "TimeoutError" })
})

for (const action of ["abort", "release", "endpoint-close", "server-close"] as const) {
  test(`settles readiness waiters promptly on ${action}`, async () => {
    // Given
    const { server, endpoint } = await fixture()
    const controller = new AbortController()
    const pending = endpoint.waitReady(controller.signal, 1000)
    const rejected = assert.rejects(pending, action === "abort" ? { name: "AbortError" } : /closed|released/)
    // When
    switch (action) {
      case "abort": controller.abort(); break
      case "release": endpoint.release(new Error("released")); break
      case "endpoint-close": await endpoint.close(); break
      case "server-close": await server.close(); break
    }
    // Then
    await rejected
  })
}

test("parks two calls until their own out-of-order results arrive", async () => {
  // Given
  const calls: ToolCall[] = []
  const both = Promise.withResolvers<void>()
  const { endpoint } = await fixture(call => { calls.push(call); if (calls.length === 2) both.resolve() })
  const session = await initialize(endpoint)
  // When
  const first = http(endpoint, rpc("tools/call", { name: "echo", arguments: { value: "first", __tool_use_purpose: "real property" } }, 2), { session }).response
  const second = http(endpoint, rpc("tools/call", { name: "echo", arguments: { value: 42 } }, 3), { session }).response
  await both.promise
  const a = calls.find(call => JSON.parse(call.arguments).value === "first")
  const b = calls.find(call => JSON.parse(call.arguments).value === 42)
  if (!a || !b) throw new Error("missing calls")
  assert.notEqual(a.callID, b.callID)
  assert.equal(JSON.parse(a.arguments).__tool_use_purpose, "real property")
  endpoint.settle({ callID: b.callID, content: { answer: "second" }, isError: false })
  // Then
  assert.deepEqual((await second).body, { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{"answer":"second"}' }], isError: false } })
  assert.throws(() => endpoint.settle({ callID: b.callID, content: "again", isError: false }))
  endpoint.settle({ callID: a.callID, content: "first", isError: true })
  assert.partialDeepStrictEqual((await first).body, { id: 2, result: { isError: true, content: [{ text: "first" }] } })
})

test("denies unauthorized, cross-endpoint and stale-session requests before tools", async () => {
  // Given
  const calls: ToolCall[] = []
  const { server, endpoint } = await fixture(call => calls.push(call))
  const other = server.endpoint({ ...scope, agent: "other" }, call => calls.push(call))
  other.setTools([tool])
  const session = await initialize(endpoint)
  const otherSession = await initialize(other)
  // When / Then
  const invalidHeaders: Record<string, string>[] = [{ Authorization: "" }, { Authorization: "Bearer wrong" }, { ...other.headers }, { Host: "localhost:123" }, { Origin: "https://evil.example" }]
  for (const headers of invalidHeaders) {
    const response = await http(endpoint, rpc("tools/call", { name: "echo" }), { session, headers }).response
    assert.ok([401, 403].includes(response.status))
  }
  assert.equal((await http(endpoint, rpc("tools/call", { name: "echo" }), { session: otherSession }).response).status, 404)
  assert.equal((await http(endpoint, undefined, { method: "GET", session }).response).status, 405)
  assert.equal((await http(endpoint, undefined, { method: "DELETE", session }).response).status, 200)
  assert.equal((await http(endpoint, rpc("tools/list"), { session }).response).status, 404)
  assert.deepEqual(calls, [])
})

test("publishes current exact names and schemas while held calls retain original identity", async () => {
  // Given
  const called = Promise.withResolvers<ToolCall>()
  const { endpoint } = await fixture(called.resolve)
  const session = await initialize(endpoint)
  const schema = { type: "object", properties: { nested: { oneOf: [{ type: "string" }, { type: "number" }] } }, additionalProperties: false }
  const names = ["__proto__", "constructor", "tool with / unicode λ", "oc_reserved"]
  endpoint.setTools(names.map(name => ({ name, description: name, inputSchema: schema })))
  const identities = endpoint.approvedTools
  assert.equal(new Set(identities.map(item => item.toolName)).size, names.length)
  assert.ok(identities.every(item => /^[a-zA-Z0-9_-]{1,64}$/.test(item.toolName)))
  const mapped = identities[2]?.toolName
  if (!mapped) throw new Error("missing mapped name")
  const held = http(endpoint, rpc("tools/call", { name: mapped, arguments: { nested: false } }), { session }).response
  const call = await called.promise
  // When
  endpoint.setTools([{ ...tool, inputSchema: schema }])
  schema.additionalProperties = true
  // Then
  assert.equal(call.name, names[2])
  assert.partialDeepStrictEqual((await http(endpoint, rpc("tools/list"), { session }).response).body, { result: { tools: [{ name: "echo", inputSchema: { additionalProperties: false, properties: schema.properties } }] } })
  assert.deepEqual(endpoint.approvedTools, [{ serverName: "opencode", toolName: "echo" }])
  assert.partialDeepStrictEqual((await http(endpoint, rpc("tools/call", { name: mapped }), { session }).response).body, { error: { code: -32602 } })
  endpoint.settle({ callID: call.callID, content: "old definition completed", isError: false })
  assert.partialDeepStrictEqual((await held).body, { result: { isError: false } })
  assert.throws(() => endpoint.setTools([tool, tool]))
  assert.throws(() => endpoint.setTools([{ ...tool, inputSchema: { type: "string" } }]))
  assert.deepEqual(endpoint.approvedTools, [{ serverName: "opencode", toolName: "echo" }])
})

for (const action of ["release", "delete", "cancel", "close", "endpoint-close"] as const) {
  test(`completes held calls when ${action} occurs`, async () => {
    // Given
    const called = Promise.withResolvers<ToolCall>()
    const { server, endpoint } = await fixture(called.resolve)
    const session = await initialize(endpoint)
    const held = http(endpoint, rpc("tools/call", { name: "echo" }, 9), { session }).response
    const outcome = held.then(value => value, error => ({ error }))
    const call = await called.promise
    // When
    switch (action) {
      case "release": endpoint.release(new Error("aborted")); break
      case "delete": await http(endpoint, undefined, { session, method: "DELETE" }).response; break
      case "cancel": await http(endpoint, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } }, { session }).response; break
      case "close": await server.close(); break
      case "endpoint-close": await endpoint.close(); break
    }
    // Then
    assert.partialDeepStrictEqual(await outcome, { body: { error: { code: -32800 } } })
    assert.throws(() => endpoint.settle({ callID: call.callID, content: "late", isError: false }))
  })
}

test("drops a disconnected client gate without disturbing another endpoint", async () => {
  // Given
  const called = Promise.withResolvers<ToolCall>()
  const { server, endpoint } = await fixture(called.resolve)
  const other = server.endpoint(scope, () => {})
  const session = await initialize(endpoint)
  const held = http(endpoint, rpc("tools/call", { name: "echo" }), { session })
  const failure = held.response.catch(error => error)
  const call = await called.promise
  // When
  held.req.destroy(new Error("disconnect"))
  await failure
  // A roundtrip on that socket's endpoint observes the close processed by the server.
  await http(endpoint, rpc("ping"), { session }).response
  // Then
  assert.throws(() => endpoint.settle({ callID: call.callID, content: "late", isError: false }))
  await endpoint.close()
  assert.ok(await initialize(other))
})

test("bounds and parses HTTP input before dispatch", async () => {
  // Given
  const calls: ToolCall[] = []
  const { endpoint } = await fixture(call => calls.push(call))
  const session = await initialize(endpoint)
  // When / Then
  assert.equal((await http(endpoint, rpc("tools/call"), { session, headers: { "Content-Type": "text/plain" } }).response).status, 415)
  assert.partialDeepStrictEqual((await http(endpoint, undefined, { session, raw: "{" }).response).body, { error: { code: -32700 } })
  assert.equal((await http(endpoint, rpc("tools/call"), { session, headers: { "Content-Length": String(8 * 1024 * 1024 + 1) } }).response).status, 413)
  assert.equal((await http(endpoint, undefined, { session, headers: { "Transfer-Encoding": "chunked" }, raw: JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }) }).response).status, 413)
  assert.partialDeepStrictEqual((await http(endpoint, rpc("unknown"), { session }).response).body, { error: { code: -32601 } })
  assert.deepEqual(calls, [])
})

test("bounds pending work and releases every accepted gate", async () => {
  // Given
  const calls: ToolCall[] = []
  const full = Promise.withResolvers<void>()
  const { endpoint } = await fixture(call => { calls.push(call); if (calls.length === 64) full.resolve() })
  const session = await initialize(endpoint)
  const pending = Array.from({ length: 64 }, (_, id) => http(endpoint, rpc("tools/call", { name: "echo" }, id), { session }).response)
  await full.promise
  // When
  const overflow = await http(endpoint, rpc("tools/call", { name: "echo" }, 100), { session }).response
  endpoint.release(new Error("turn cancelled"))
  // Then
  assert.partialDeepStrictEqual(overflow.body, { error: { code: -32000 } })
  assert.equal(calls.length, 64)
  for (const response of await Promise.all(pending)) assert.partialDeepStrictEqual(response.body, { error: { code: -32800 } })
})

test("keeps request IDs and cancellation subordinate to the authenticated session", async () => {
  // Given
  const called = Promise.withResolvers<ToolCall>()
  const { server, endpoint } = await fixture(called.resolve)
  const other = server.endpoint(scope, () => {})
  const session = await initialize(endpoint), second = await initialize(endpoint)
  const held = http(endpoint, rpc("tools/call", { name: "echo" }, 8), { session }).response
  const call = await called.promise
  // When
  const duplicate = await http(endpoint, rpc("tools/call", { name: "echo" }, 8), { session }).response
  await http(endpoint, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8 } }, { session: second }).response
  // Then
  assert.partialDeepStrictEqual(duplicate.body, { error: { code: -32600 } })
  assert.throws(() => other.settle({ callID: call.callID, content: "wrong scope", isError: false }))
  endpoint.settle({ callID: call.callID, content: "still pending", isError: false })
  assert.partialDeepStrictEqual((await held).body, { result: { content: [{ text: "still pending" }] } })
})

test("contains callback failures and rejects malformed MCP envelopes", async () => {
  // Given
  const { endpoint } = await fixture(() => { throw new Error("private failure") })
  const session = await initialize(endpoint)
  // When / Then
  assert.partialDeepStrictEqual((await http(endpoint, rpc("tools/call", { name: "echo" }), { session }).response).body, { error: { code: -32603, message: "Tool dispatch failed" } })
  for (const params of [{ name: "echo", arguments: null }, { name: "echo", arguments: [] }, null]) {
    assert.partialDeepStrictEqual((await http(endpoint, rpc("tools/call", params), { session }).response).body, { error: { code: -32602 } })
  }
  assert.equal((await http(endpoint, rpc("tools/list"), { session, headers: { "MCP-Protocol-Version": "wrong" } }).response).status, 400)
  assert.equal((await http(endpoint, rpc("tools/call", { name: "echo" })).response).status, 404)
})

test("preserves shared production schema objects and large argument objects", async () => {
  // Given
  const called = Promise.withResolvers<ToolCall>()
  const { endpoint } = await fixture(called.resolve)
  const session = await initialize(endpoint)
  const shared = { type: "string" }
  endpoint.setTools([{ ...tool, inputSchema: { type: "object", properties: { a: shared, b: shared } } }])
  const args = Object.fromEntries(Array.from({ length: 150_000 }, (_, index) => [`key${index}`, index]))
  // When
  const held = http(endpoint, rpc("tools/call", { name: "echo", arguments: args }), { session }).response
  const call = await called.promise
  endpoint.settle({ callID: call.callID, content: "large object", isError: false })
  // Then
  assert.deepEqual(JSON.parse(call.arguments), args)
  assert.partialDeepStrictEqual((await held).body, { result: { isError: false } })
})

test("executes prototype-like wire names only through their registered gates", async () => {
  // Given
  const calls: ToolCall[] = []
  const { endpoint } = await fixture(call => {
    calls.push(call)
    endpoint.settle({ callID: call.callID, content: call.name, isError: false })
  })
  endpoint.setTools(["__proto__", "constructor", "toString"].map(name => ({ ...tool, name })))
  const session = await initialize(endpoint)
  // When / Then
  for (const name of ["__proto__", "constructor", "toString"]) {
    const response = await http(endpoint, rpc("tools/call", { name, arguments: JSON.parse('{"__proto__":{"polluted":true}}') }), { session }).response
    assert.partialDeepStrictEqual(response.body, { result: { content: [{ text: name }] } })
    assert.equal(calls.at(-1)?.name, name)
    assert.deepEqual(JSON.parse(calls.at(-1)?.arguments ?? "null"), JSON.parse('{"__proto__":{"polluted":true}}'))
  }
})
