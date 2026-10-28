import { spawn } from "node:child_process";
import type { AcpClient, AcpClientOptions, AcpEvent, Json } from "./contracts.js";

type Obj = { readonly [key: string]: Json };
const LIMIT = 8 * 1024 * 1024;
const object = (value: Json | undefined): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
function json(value: unknown, depth = 0): Json {
  if (depth > 32) throw new AcpError("ACP JSON nesting limit", "PROTOCOL");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item: unknown) => json(item, depth + 1)));
  if (typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, depth + 1)])));
  throw new AcpError("Invalid ACP JSON", "PROTOCOL");
}

// Exported bridge error: safe message, numeric RPC or local string code, sanitized JSON data.
export class AcpError extends Error {
  override readonly name = "AcpError";
  constructor(message: string, readonly code: number | string, readonly data: Json = null) { super(message); }
}
type Pending = { readonly resolve: (value: Obj) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> };
type Turn = { busy: boolean; cancelled: boolean; settled: boolean; metadata: boolean };

export function createAcpClient(options: AcpClientOptions): AcpClient {
  const child = spawn(options.executable, [...options.args], { cwd: options.cwd, stdio: "pipe", detached: true, shell: false });
  const pending = new Map<number, Pending>(), turns = new Map<string, Turn>(), requests = new Map<number, string>();
  const wake = new Set<() => void>(), secrets = new Map<string, readonly string[]>();
  let sequence = 0, loading = 0, buffer = Buffer.alloc(0), failure: Error | undefined, closing: Promise<void> | undefined;
  let cleanupFailure: AcpError | undefined;
  let capabilities: AcpClient["capabilities"] = Object.freeze({ image: false });
  const stopped = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const emit = (event: AcpEvent) => options.onEvent(Object.freeze(event));
  const notify = () => { for (const listener of wake) listener(); };
  function fail(error: Error) {
    failure ??= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear(); requests.clear(); notify();
  }
  function kill(signal: NodeJS.Signals) {
    if (!child.pid) return false;
    try { return process.kill(-child.pid, signal); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      cleanupFailure = new AcpError("ACP process cleanup failed", "CLEANUP"); fail(cleanupFailure); return false;
    }
  }
  function send(value: Obj) {
    if (failure || closing) throw failure ?? new AcpError("ACP client closed", "CLOSED");
    const frame = `${JSON.stringify(value)}\n`;
    child.stdin.write(frame, (error) => { if (error) fail(new AcpError("ACP input failed", "IO")); });
  }
  function request(method: string, params: Obj): Promise<Obj> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new AcpError("ACP request deadline exceeded", "TIMEOUT"));
        kill("SIGTERM");
      }, method === "session/prompt" ? 7_260_000 : 15_000);
      pending.set(id, { resolve, reject, timer });
      if (method === "session/prompt" && typeof params.sessionId === "string") requests.set(id, params.sessionId);
      try { send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { fail(error instanceof Error ? error : new AcpError("ACP write failed", "IO")); }
    });
  }
  function sanitize(value: Json): Json {
    if (typeof value === "string") {
      let safe = value;
      for (const blocks of secrets.values()) for (const secret of blocks) if (secret) safe = safe.replaceAll(secret, "[redacted]");
      return safe.replace(/Bearer\s+[^\s"',]+/gi, "Bearer [redacted]").replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]").slice(0, 4096);
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|authorization|prompt|headers|api.?key/i.test(key) ? "[redacted]" : sanitize(item)]));
    return value;
  }
  function receive(rpc: Obj) {
    if (rpc.jsonrpc !== "2.0") throw new AcpError("Invalid ACP envelope", "PROTOCOL");
    const params = object(rpc.params), sid = params.sessionId;
    if (typeof rpc.method === "string") {
      if (rpc.id !== undefined) {
        if (!(typeof rpc.id === "number" || typeof rpc.id === "string")) throw new AcpError("Invalid ACP request ID", "PROTOCOL");
        if (rpc.method !== "session/request_permission") {
          send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Client capability disabled" } }); return;
        }
        const identity = object(object(params._meta).mcpToolIdentity), call = object(params.toolCall);
        const offered = Array.isArray(params.options) && params.options.length <= 32 ? params.options.map(object) : [];
        const choices = offered.filter((option) => option.kind === "allow_once" && typeof option.optionId === "string" && option.optionId.length > 0 && offered.filter((item) => item.optionId === option.optionId).length === 1);
        const matches = options.getApprovedTools().filter((tool) => tool.serverName === identity.serverName && tool.toolName === identity.toolName);
        const turn = typeof sid === "string" ? turns.get(sid) : undefined;
        const allow = !loading && turn?.busy && !turn.settled && !turn.cancelled && typeof call.toolCallId === "string" && call.toolCallId.length > 0 && matches.length === 1 && choices.length === 1 ? choices[0] : undefined;
        send({ jsonrpc: "2.0", id: rpc.id, result: { outcome: allow ? { outcome: "selected", optionId: allow.optionId ?? "" } : { outcome: "cancelled" } } }); return;
      }
      if (typeof sid !== "string" || loading) return;
      const turn = turns.get(sid);
      if (!turn) return;
      switch (rpc.method) {
        case "_kiro.dev/metadata":
          if (turn.cancelled && turn.settled && typeof params.turnDurationMs === "number") { turn.metadata = true; notify(); }
          emit({ type: "metadata", sessionID: sid, value: Object.freeze(params) }); return;
        case "session/update": {
          if (turn.cancelled || !turn.busy) return;
          const update = object(params.update), content = object(update.content);
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (content.type === "text" && typeof content.text === "string") emit({ type: "text", sessionID: sid, text: content.text }); return;
            case "tool_call":
              if (typeof update.toolCallId === "string" && typeof update.title === "string") emit({ type: "tool", sessionID: sid, acpCallID: update.toolCallId, name: update.title }); return;
            default: return;
          }
        }
        default: return;
      }
    }
    if (typeof rpc.id !== "number" || !Number.isSafeInteger(rpc.id)) throw new AcpError("Invalid ACP response ID", "PROTOCOL");
    const session = requests.get(rpc.id), turn = session === undefined ? undefined : turns.get(session);
    if (turn) {
      turn.settled = true;
      if (object(rpc.result).stopReason === "cancelled") turn.cancelled = true;
      requests.delete(rpc.id); notify();
    }
    const entry = pending.get(rpc.id);
    if (!entry) return;
    pending.delete(rpc.id); clearTimeout(entry.timer);
    if (rpc.error !== undefined) {
      const error = object(rpc.error), message = sanitize(typeof error.message === "string" ? error.message : "ACP upstream failure");
      entry.reject(new AcpError(String(message), typeof error.code === "number" ? error.code : "UPSTREAM", sanitize(error.data ?? null)));
    } else if (rpc.result !== null && typeof rpc.result === "object" && !Array.isArray(rpc.result)) entry.resolve(object(rpc.result));
    else { entry.reject(new AcpError("Invalid ACP result", "PROTOCOL")); fail(new AcpError("Invalid ACP result", "PROTOCOL")); }
  }
  child.stdout.on("data", (chunk: Buffer) => {
    if (failure || closing) return;
    try {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        if (buffer.length + end - start > LIMIT) throw new AcpError("ACP frame limit", "LIMIT");
        const line = Buffer.concat([buffer, chunk.subarray(start, end)]); buffer = Buffer.alloc(0); start = end + 1;
        if (line.length) receive(object(json(JSON.parse(line.toString("utf8")))));
      }
      if (buffer.length + chunk.length - start > LIMIT) throw new AcpError("ACP frame limit", "LIMIT");
      buffer = Buffer.concat([buffer, chunk.subarray(start)]);
    } catch (error) { fail(error instanceof AcpError ? error : new AcpError("Malformed ACP output", "PROTOCOL")); kill("SIGTERM"); }
  });
  child.stdout.on("end", () => fail(new AcpError("ACP output ended", "EOF")));
  child.stdout.on("error", () => fail(new AcpError("ACP output failed", "IO")));
  child.stdin.on("error", () => fail(new AcpError("ACP input failed", "IO")));
  child.stderr.resume();
  child.stderr.on("error", () => fail(new AcpError("ACP stderr failed", "IO")));
  child.on("error", () => fail(new AcpError("ACP executable could not start", "SPAWN")));
  child.on("exit", () => { fail(new AcpError("ACP process exited", "EXIT")); kill("SIGTERM"); });
  function cancel(sessionID: string) {
    const turn = turns.get(sessionID);
    if (!turn?.busy || turn.settled || turn.cancelled || failure || closing) return;
    turn.cancelled = true; turn.metadata = false;
    try { send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sessionID } }); }
    catch (error) { fail(error instanceof Error ? error : new AcpError("ACP cancel failed", "IO")); }
    for (const [id, sid] of requests) if (sid === sessionID) {
      const entry = pending.get(id);
      if (entry) { clearTimeout(entry.timer); pending.delete(id); entry.reject(new DOMException("ACP prompt cancelled", "AbortError")); }
    }
  }
  return {
    get capabilities() { return capabilities; },
    async initialize() {
      const result = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "opencode-kiro-auth", version: "1" } });
      if (result.protocolVersion !== 1) throw new AcpError("Unsupported ACP protocol", "PROTOCOL");
      capabilities = Object.freeze({ image: object(object(result.agentCapabilities).promptCapabilities).image === true });
    },
    async open(cwd, resumeID) {
      loading++;
      try {
        const result = await request(resumeID === undefined ? "session/new" : "session/load", { cwd, mcpServers: [], ...(resumeID === undefined ? {} : { sessionId: resumeID }) });
        const sid = resumeID ?? result.sessionId;
        if (typeof sid !== "string" || !sid) throw new AcpError("Missing ACP session ID", "PROTOCOL");
        turns.set(sid, { busy: false, cancelled: false, settled: true, metadata: false }); return sid;
      } finally { loading--; }
    },
    async prompt(sessionID, content, signal) {
      if (signal.aborted) throw new DOMException("ACP prompt cancelled", "AbortError");
      const turn = turns.get(sessionID);
      if (!turn || turn.busy || turn.cancelled) throw new AcpError("ACP session is not quiescent", "BUSY");
      turn.busy = true; turn.settled = false; turn.metadata = false;
      secrets.set(sessionID, content.map((block) => {
        switch (block.type) {
          case "text": return block.text;
          case "image": return block.data;
          default: { const exhaustive: never = block; throw exhaustive; }
        }
      }));
      const abort = () => cancel(sessionID);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await request("session/prompt", { sessionId: sessionID, prompt: [...content] });
        if (typeof result.stopReason !== "string") throw new AcpError("Missing ACP stop reason", "PROTOCOL");
        return { stopReason: result.stopReason };
      } finally { signal.removeEventListener("abort", abort); secrets.delete(sessionID); if (!turn.cancelled) turn.busy = false; }
    },
    cancel,
    async quiesce(sessionID, timeoutMs) {
      const turn = turns.get(sessionID);
      if (!turn || failure || closing) return false;
      if (!turn.busy) return true;
      return new Promise<boolean>((resolve) => {
        const finish = (ready: boolean) => { clearTimeout(timer); wake.delete(check); if (ready) { turn.busy = false; turn.cancelled = false; } resolve(ready); };
        const check = () => { if (failure || closing) finish(false); else if (turn.settled && (!turn.cancelled || turn.metadata)) finish(true); };
        const timer = setTimeout(() => finish(false), Number.isFinite(timeoutMs) ? Math.max(0, Math.min(2000, timeoutMs)) : 2000);
        wake.add(check); check();
      });
    },
    close() {
      if (closing) return closing;
      fail(new AcpError("ACP client closed", "CLOSED")); child.stdin.end();
      closing = new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 2000;
        const timer = setInterval(() => {
          try {
            const alive = child.pid ? process.kill(-child.pid, 0) : false;
            if (alive && performance.now() >= deadline) kill("SIGKILL");
            if (cleanupFailure) { clearInterval(timer); reject(cleanupFailure); return; }
            if (alive && performance.now() < deadline + 1000) return;
            clearInterval(timer);
            if (alive) reject(new AcpError("ACP process group did not exit", "CLEANUP"));
            else stopped.then(resolve, reject);
          } catch (error) {
            clearInterval(timer);
            if (error instanceof Error && "code" in error && error.code === "ESRCH") stopped.then(resolve, reject);
            else reject(new AcpError("ACP process cleanup failed", "CLEANUP"));
          }
        }, 20);
      });
      return closing;
    },
  };
}
