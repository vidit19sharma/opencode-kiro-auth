import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Json, ToolEndpoint, ToolServer, ToolSpec } from "./contracts.js"

const LIMIT = 8 * 1024 * 1024
const PROTOCOL = "2025-11-25"
class GateError extends Error {
  override readonly name = "GateError"
  constructor(readonly code: number, message: string) { super(message) }
}
const opaque = () => randomBytes(32).toString("base64url")
function object(value: unknown): value is { readonly [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function json(value: unknown): value is Json {
  const remaining = [{ value, leaving: false }]
  const seen = new Set<object>()
  while (remaining.length) {
    const frame = remaining.pop()
    if (!frame) break
    const item = frame.value
    if (item === null || typeof item === "string" || typeof item === "boolean") continue
    if (typeof item === "number" && Number.isFinite(item)) continue
    if (typeof item !== "object" || item === null) return false
    if (frame.leaving) { seen.delete(item); continue }
    if (seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) return false
    seen.add(item)
    remaining.push({ value: item, leaving: true })
    for (const value of Object.values(item)) remaining.push({ value, leaving: false })
  }
  return true
}
function snapshot(tool: ToolSpec): ToolSpec {
  if (typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string" || !json(tool.inputSchema) || !object(tool.inputSchema) || tool.inputSchema["type"] !== "object") throw new GateError(-32602, "Invalid tool definition")
  const properties = tool.inputSchema["properties"], required = tool.inputSchema["required"]
  if ((properties !== undefined && !object(properties)) || (required !== undefined && (!Array.isArray(required) || !required.every(name => typeof name === "string")))) throw new GateError(-32602, "Invalid schema shape")
  const copy: ToolSpec = structuredClone({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
  const remaining: object[] = [copy]
  while (remaining.length) {
    const item = remaining.pop()
    if (!item || Object.isFrozen(item)) continue
    Object.freeze(item)
    for (const value of Object.values(item)) if (value !== null && typeof value === "object") remaining.push(value)
  }
  return copy
}
function send(response: ServerResponse, status: number, body?: unknown): void {
  if (response.destroyed || response.writableEnded) return
  if (status >= 400) response.setHeader("Connection", "close")
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}
type Gate = {
  readonly id: string | number
  readonly session: string
  readonly definition: ToolSpec
  readonly finish: (body: unknown) => void
}

export async function createToolServer(): Promise<ToolServer> {
  const routes = new Map<string, { readonly handle: (request: IncomingMessage, response: ServerResponse) => void; readonly endpoint: ToolEndpoint }>()
  let closed = false
  const server = createServer((request, response) => {
    const route = routes.get(request.url ?? "")
    if (!route || closed) { send(response, 404); return }
    route.handle(request, response)
  })
  server.timeout = 0
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new GateError(-32603, "Loopback listener unavailable")
  const host = `127.0.0.1:${address.port}`, origin = `http://${host}`
  let closing: Promise<void> | undefined
  return {
    endpoint(_scope, onCall) {
      if (closed) throw new GateError(-32000, "Server closed")
      const path = `/mcp/${opaque()}`, bearer = `Bearer ${opaque()}`
      const sessions = new Map<string, boolean>(), gates = new Map<string, Gate>()
      const listed = new Set<string>(), waiters = new Set<(error?: Error) => void>()
      const requests = new Set<ServerResponse>()
      let tools = new Map<string, ToolSpec>(), active = true
      const cancel = (gate: Gate) => gate.finish({ jsonrpc: "2.0", id: gate.id, error: { code: -32800, message: "Tool call cancelled" } })
      const endpoint: ToolEndpoint = {
        url: `${origin}${path}`,
        headers: Object.freeze({ Authorization: bearer }),
        get approvedTools() { return Object.freeze([...tools.keys()].map(toolName => Object.freeze({ serverName: "opencode" as const, toolName }))) },
        setTools(definitions) {
          if (!active) throw new GateError(-32000, "Endpoint closed")
          const next = new Map<string, ToolSpec>(), originals = new Set<string>()
          for (const definition of definitions) {
            const frozen = snapshot(definition)
            const wire = /^[a-zA-Z0-9_-]{1,64}$/.test(frozen.name) && !frozen.name.startsWith("oc_") ? frozen.name : `oc_${createHash("sha256").update(frozen.name, "utf16le").digest("base64url")}`
            if (originals.has(frozen.name) || next.has(wire)) throw new GateError(-32602, "Duplicate tool name")
            originals.add(frozen.name)
            next.set(wire, frozen)
          }
          tools = next; listed.clear()
        },
        waitReady(signal, timeoutMs = 15_000) {
          return new Promise<void>((resolve, reject) => {
            if (signal.aborted) { reject(new DOMException("Readiness aborted", "AbortError")); return }
            if (!active) { reject(new GateError(-32000, "Endpoint closed")); return }
            if (listed.size) { resolve(); return }
            const finish = (error?: Error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); waiters.delete(finish); if (error) reject(error); else resolve() }
            const abort = () => finish(new DOMException("Readiness aborted", "AbortError"))
            const timer = setTimeout(() => finish(new DOMException("MCP readiness deadline exceeded", "TimeoutError")), Number.isFinite(timeoutMs) ? Math.max(0, Math.min(15_000, timeoutMs)) : 15_000)
            waiters.add(finish); signal.addEventListener("abort", abort, { once: true })
          })
        },
        settle(result) {
          const gate = gates.get(result.callID)
          if (!gate) throw new GateError(-32000, "Unknown or completed tool call")
          gate.finish({ jsonrpc: "2.0", id: gate.id, result: { content: [{ type: "text", text: typeof result.content === "string" ? result.content : JSON.stringify(result.content) }], isError: result.isError } })
        },
        release(reason) { listed.clear(); for (const finish of waiters) finish(reason); for (const gate of gates.values()) cancel(gate) },
        async close() {
          if (!active) return
          active = false
          routes.delete(path)
          endpoint.release(new GateError(-32800, "Endpoint closed"))
          sessions.clear()
          tools.clear()
          for (const response of requests) send(response, 410)
        },
      }
      function dispatch(body: Json, response: ServerResponse, session: string | undefined): void {
        const id = object(body) && (typeof body["id"] === "string" || (typeof body["id"] === "number" && Number.isFinite(body["id"]))) ? body["id"] : undefined
        const fail = (code: number, message: string) => send(response, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } })
        if (!object(body) || body["jsonrpc"] !== "2.0" || typeof body["method"] !== "string" || (Object.hasOwn(body, "id") && id === undefined)) { fail(-32600, "Invalid request"); return }
        const params = body["params"] === undefined ? {} : body["params"]
        if (!object(params)) { fail(-32602, "Invalid params"); return }
        const success = (result: unknown) => send(response, 200, { jsonrpc: "2.0", id, result })
        if (body["method"] === "initialize") {
          if (id === undefined || session || params["protocolVersion"] !== PROTOCOL || !object(params["capabilities"]) || !object(params["clientInfo"]) || typeof params["clientInfo"]["name"] !== "string" || typeof params["clientInfo"]["version"] !== "string") { fail(-32602, "Invalid initialization"); return }
          if (sessions.size >= 128) { send(response, 429); return }
          const fresh = opaque()
          sessions.set(fresh, false)
          response.setHeader("Mcp-Session-Id", fresh)
          success({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "opencode", version: "1" } })
          return
        }
        if (!session || !sessions.has(session)) { send(response, 404); return }
        switch (body["method"]) {
          case "notifications/initialized":
            if (id !== undefined) { fail(-32600, "Expected notification"); return }
            sessions.set(session, true); send(response, 202); return
          case "notifications/cancelled":
            if (id !== undefined || (typeof params["requestId"] !== "string" && typeof params["requestId"] !== "number")) { fail(-32602, "Invalid cancellation"); return }
            for (const gate of gates.values()) if (gate.session === session && gate.id === params["requestId"]) cancel(gate)
            send(response, 202); return
          case "ping":
          case "tools/list":
          case "tools/call": break
          default: fail(-32601, "Unknown method"); return
        }
        if (id === undefined || !sessions.get(session)) { fail(-32600, "Session not initialized or missing request id"); return }
        if (body["method"] === "ping") { success({}); return }
        if (body["method"] === "tools/list") {
          const inventory = tools
          response.once("finish", () => { if (active && tools === inventory && sessions.get(session)) { listed.add(session); for (const finish of waiters) finish() } })
          success({ tools: [...tools].map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })) }); return
        }
        const definition = typeof params["name"] === "string" ? tools.get(params["name"]) : undefined
        const args = params["arguments"] === undefined ? {} : params["arguments"]
        if (!definition || !object(args)) { fail(-32602, "Unknown tool or invalid arguments"); return }
        if ([...gates.values()].some(gate => gate.session === session && gate.id === id)) { fail(-32600, "Duplicate active request id"); return }
        if (gates.size >= 64) { fail(-32000, "Too many pending tools"); return }
        const callID = `call_${opaque()}`
        const cleanup = () => { gates.delete(callID); clearTimeout(timer); response.removeListener("close", cleanup) }
        const gate: Gate = { id, session, definition, finish(body) { cleanup(); send(response, 200, body) } }
        const timer = setTimeout(() => gate.finish({ jsonrpc: "2.0", id, error: { code: -32001, message: "Tool call timed out" } }), 7_200_000)
        timer.unref()
        gates.set(callID, gate)
        response.once("close", cleanup)
        try { onCall({ callID, name: definition.name, arguments: JSON.stringify(args) }) }
        catch (error) {
          if (error instanceof Error) {
            if (gates.has(callID)) gate.finish({ jsonrpc: "2.0", id, error: { code: -32603, message: "Tool dispatch failed" } })
          } else { if (gates.has(callID)) cancel(gate) }
        }
      }
      function handle(request: IncomingMessage, response: ServerResponse): void {
        requests.add(response)
        response.once("close", () => requests.delete(response))
        const headers = new Map<string, string | undefined>()
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          const name = request.rawHeaders[index]?.toLowerCase()
          if (name !== undefined) headers.set(name, headers.has(name) ? undefined : request.rawHeaders[index + 1])
        }
        const single = (name: string) => headers.get(name)
        const authorization = single("authorization")
        if (!authorization || Buffer.byteLength(authorization) !== Buffer.byteLength(bearer) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(bearer))) { send(response, 401); return }
        if (single("host") !== host || (headers.has("origin") && single("origin") !== origin)) { send(response, 403); return }
        const session = single("mcp-session-id")
        if (headers.has("mcp-session-id") && (!session || !sessions.has(session))) { send(response, 404); return }
        if (headers.has("mcp-protocol-version") && single("mcp-protocol-version") !== PROTOCOL) { send(response, 400); return }
        if (request.method === "DELETE") {
          if (!session) { send(response, 404); return }
          sessions.delete(session); listed.delete(session)
          for (const gate of gates.values()) if (gate.session === session) cancel(gate)
          send(response, 200); return
        }
        if (request.method !== "POST") { response.setHeader("Allow", "POST, DELETE"); send(response, 405); return }
        if (single("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") { send(response, 415); return }
        if (headers.has("content-encoding") && single("content-encoding") !== "identity") { send(response, 415); return }
        if (Number(request.headers["content-length"] ?? 0) > LIMIT) { send(response, 413); request.resume(); return }
        let size = 0
        const chunks: Buffer[] = []
        request.on("error", () => { if (!response.writableEnded) response.destroy() })
        request.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > LIMIT) { chunks.length = 0; send(response, 413); return }
          chunks.push(chunk)
        })
        request.on("end", () => {
          if (response.writableEnded || response.destroyed) return
          if (!active || (session && !sessions.has(session))) { send(response, 404); return }
          let body: unknown
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) }
          catch (error) {
            if (error instanceof SyntaxError) { send(response, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return }
            response.destroy(); return
          }
          if (!json(body)) { send(response, 400); return }
          dispatch(body, response, session)
        })
      }
      routes.set(path, { handle, endpoint })
      return endpoint
    },
    close() {
      if (closing) return closing
      closed = true
      closing = (async () => {
        await Promise.all([...routes.values()].map(route => route.endpoint.close()))
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        await new Promise<void>(resolve => setImmediate(resolve))
        server.closeAllConnections()
        await stopped
      })()
      return closing
    },
  }
}
