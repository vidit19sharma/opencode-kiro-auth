import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { PNG } from "./image.ts";

type Obj = { readonly [key: string]: unknown };
function obj(value: unknown): Obj {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const update = (sessionId: string, update: Obj) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const text = (sessionId: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fresh 🦊" } });
const tool = (sessionId: string) => update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call", title: "safe" });
const metadata = (sessionId: string) => ({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId, turnDurationMs: 1, reasoning: { support: "unavailable", effortLevels: [] } } });
const lines = createInterface({ input: process.stdin });
const mode = process.argv[2];
let held: unknown;
let poisoned = false;
const permissions = new Map<string, unknown>();
let replies = 0;
let ready = Promise.resolve();
if (mode === "tree") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync("pids.json", JSON.stringify([process.pid, child.pid]));
  process.on("SIGTERM", () => { child.kill("SIGKILL"); child.on("exit", () => process.exit(0)); });
  setInterval(() => {}, 1000);
}
if (mode === "orphan") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  writeFileSync("descendant.json", JSON.stringify(child.pid));
  ready = new Promise<void>((resolve) => child.stdout.once("data", () => { child.unref(); resolve(); }));
  lines.on("close", () => process.exit(0));
}
lines.on("line", (line) => {
  const rpc = obj(JSON.parse(line));
  if (typeof rpc.id === "string" && permissions.has(rpc.id)) {
    const wanted = permissions.get(rpc.id);
    assert.deepEqual(rpc.result ?? rpc.error, wanted);
    permissions.delete(rpc.id); replies++;
    if (permissions.size === 0) reply(held, { stopReason: `replies:${replies}` });
    return;
  }
  const params = obj(rpc.params);
  switch (rpc.method) {
    case "initialize":
      if (mode === "silent") break;
      if (mode === "malformed") { process.stdout.write("{broken}\n"); break; }
      if (mode === "oversized") { process.stdout.write("x".repeat(8 * 1024 * 1024 + 1)); break; }
      if (mode === "oversized-line") { process.stdout.write(`${"x".repeat(8 * 1024 * 1024 + 1)}\n`); break; }
      if (mode === "bad-id") { send({ jsonrpc: "2.0", id: {}, result: {} }); break; }
      if (mode === "eof") { process.stdout.end(() => process.exit(0)); break; }
      assert.deepEqual(params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
      void ready.then(() => reply(rpc.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, ...(mode === "image-true" || mode === "image-false" ? { promptCapabilities: { image: mode === "image-true" } } : {}) } })); break;
    case "session/load":
    case "session/new":
      if (rpc.method === "session/load") { send(text(String(params.sessionId))); send(tool(String(params.sessionId))); }
      assert.deepEqual(params.mcpServers, []); assert.equal(params.cwd, process.cwd());
      if (mode === "interleaved") {
        if (held === undefined) held = rpc.id;
        else { reply(rpc.id, { sessionId: "second" }); reply(held, { sessionId: "first" }); }
      } else reply(rpc.id, { sessionId: params.sessionId ?? "session" });
      break;
    case "session/prompt": {
      const sid = String(params.sessionId);
      held = rpc.id;
      if (mode === "image-wire") {
        assert(JSON.stringify(params.prompt) === JSON.stringify([{ type: "text", text: "inspect" }, { type: "image", data: PNG, mimeType: "image/png" }]), "image wire mismatch");
        reply(rpc.id, { stopReason: "image-exact" }); break;
      }
      if (mode === "image-large") {
        assert(Array.isArray(params.prompt) && params.prompt.length === 2);
        for (const raw of params.prompt) { const block = obj(raw); assert(block.type === "image" && block.mimeType === "image/png" && typeof block.data === "string" && Buffer.from(block.data, "base64").equals(Buffer.alloc(5 * 1024 * 1024)), "large image mismatch"); }
        reply(rpc.id, { stopReason: "image-large-exact" }); break;
      }
      if (mode === "long-held") {
        setTimeout(() => reply(rpc.id, { stopReason: "end_turn" }), 15_100); break;
      }
      if (mode === "exit") { process.exit(9); }
      if (mode === "error") {
        send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "Bearer private-token", data: { reason: "Unknown model", token: "private-token", prompt: "private-prompt" } } }); break;
      }
      if (mode === "hold" || mode === "no-metadata" || mode === "early-metadata") { send(text(sid)); break; }
      if (mode === "permissions") {
        const identity = { serverName: "opencode", toolName: "safe" };
        const once = { optionId: "once", kind: "allow_once" };
        const cancelled = { outcome: { outcome: "cancelled" } };
        const cases = [
          { sessionId: sid, _meta: { mcpToolIdentity: identity }, options: [once], allow: true },
          { sessionId: sid, options: [once] },
          { sessionId: "other", _meta: { mcpToolIdentity: identity }, options: [once] },
          { sessionId: sid, _meta: { mcpToolIdentity: { ...identity, toolName: "stale" } }, options: [once] },
          { sessionId: sid, _meta: { mcpToolIdentity: { ...identity, serverName: "other" } }, options: [once] },
          { sessionId: sid, _meta: { mcpToolIdentity: identity }, options: [{ optionId: "always", kind: "allow_always" }] },
          { sessionId: sid, _meta: { mcpToolIdentity: identity }, options: [once, { ...once, optionId: "ambiguous" }] },
          { sessionId: sid, _meta: { mcpToolIdentity: [identity, identity] }, options: [once] },
          { sessionId: sid, _meta: { mcpToolIdentity: identity }, options: [once, { ...once, kind: "allow_always" }] },
        ];
        cases.forEach((item, index) => {
          const id = `permission:${index}`;
          permissions.set(id, item.allow ? { outcome: { outcome: "selected", optionId: "once" } } : cancelled);
          send({ jsonrpc: "2.0", id, method: "session/request_permission", params: { ...item, toolCall: { toolCallId: id, title: "Running: @opencode/safe" } } });
        });
        for (const method of ["fs/read_text_file", "fs/write_text_file", "terminal/create", "unknown/client"]) {
          permissions.set(method, { code: -32601, message: "Client capability disabled" });
          send({ jsonrpc: "2.0", id: method, method, params: {} });
        }
        break;
      }
      if (mode === "revoked") {
        permissions.set("permission", { outcome: { outcome: "cancelled" } });
        send(text(sid));
        send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: sid, _meta: { mcpToolIdentity: { serverName: "opencode", toolName: "safe" } }, toolCall: { toolCallId: "call" }, options: [{ kind: "allow_once", optionId: "once" }] } }); break;
      }
      if (mode === "cancel") {
        if (poisoned) { reply(rpc.id, { stopReason: "cancelled" }); break; }
        send(text(sid)); break;
      }
      if (mode === "upstream-cancel") { reply(rpc.id, { stopReason: "cancelled" }); break; }
      if (mode === "length") {
        const blocks = params.prompt; assert(Array.isArray(blocks));
        reply(rpc.id, { stopReason: String(String(obj(blocks[0]).text).length) }); break;
      }
      const frames = Buffer.from([text(sid), text("unrelated"), tool(sid), update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "ignored" } }), metadata(sid), { jsonrpc: "2.0", id: rpc.id, result: { stopReason: "end_turn" } }].map((frame) => `${JSON.stringify(frame)}\n`).join(""));
      const split = frames.indexOf(Buffer.from("🦊")) + 1;
      process.stdout.write(frames.subarray(0, split));
      setImmediate(() => process.stdout.write(frames.subarray(split))); break;
    }
    case "session/cancel":
      poisoned = true;
      if (mode === "early-metadata") send(metadata(String(params.sessionId)));
      reply(held, { stopReason: "cancelled" });
      if (mode !== "no-metadata" && mode !== "early-metadata") setImmediate(() => { poisoned = false; send(metadata(String(params.sessionId))); });
      break;
    default: assert.fail("Unexpected fixture method");
  }
});
