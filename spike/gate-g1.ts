// Opt-in, two-prompt v2 reattachment probe. Synthetic secrets only; no credential reads.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { once } from "node:events";

type Obj = { readonly [key: string]: unknown };
function obj(value: unknown): Obj {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function str(value: unknown): string { assert.equal(typeof value, "string"); return String(value); }
const nonce = () => randomBytes(12).toString("hex");
const init = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "gate-g1", version: "1" } };
const scratchRoot = "../.qa/kiro";
const records: Obj[] = []; // Mutable evidence accumulator; never stores bearer values.
const expires = Date.now() + 140000;
let phase = "setup";
function record(event: Obj): void { records.push({ phase, ...event }); }

async function endpoint(epoch: string) {
  const token = nonce(), name = `g1_${epoch}_${nonce()}`, secret = `synthetic_${epoch}_${nonce()}`;
  const properties = epoch === "A" ? { label: { type: "string", const: "alpha" } } : { key: { type: "string", const: "beta" }, generation: { type: "integer", const: 2 } };
  const tool = { name, description: `Return synthetic secret ${epoch}. Call once when requested.`, inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } };
  const calls: Obj[] = [];
  const server = createServer(async (req, res) => {
    const authorized = req.headers.authorization === `Bearer ${token}`;
    record({ transport: epoch, http: req.method, authorized });
    if (!authorized) { res.writeHead(401).end(); return; }
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(req.method === "DELETE" ? 200 : 405).end(); return; }
    try {
      let body = "";
      for await (const chunk of req) { body += String(chunk); assert(body.length < 65536); }
      const rpc = obj(JSON.parse(body));
      const method = str(rpc.method);
      record({ transport: epoch, method, id: rpc.id ?? null, params: rpc.params ?? null });
      if (rpc.id === undefined) { res.writeHead(202).end(); return; }
      let result: unknown;
      switch (method) {
        case "initialize": result = { protocolVersion: obj(rpc.params).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "gate-g1", version: "1" } }; break;
        case "tools/list": result = { tools: [tool] }; break;
        case "tools/call": {
          const params = obj(rpc.params), args = obj(params.arguments);
          assert.equal(params.name, name);
          const cleaned = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "__tool_use_purpose"));
          assert.deepEqual(cleaned, epoch === "A" ? { label: "alpha" } : { key: "beta", generation: 2 });
          calls.push(params);
          result = { content: [{ type: "text", text: JSON.stringify({ secret }) }] };
          break;
        }
        default: res.writeHead(400).end(); return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": `g1-${epoch}` });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch (error) {
      record({ transport: epoch, failure: error instanceof Error ? error.message : String(error) });
      res.writeHead(400).end();
    }
  });
  server.requestTimeout = 5000;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  return { epoch, token, tool, secret, calls, url: `http://127.0.0.1:${address.port}/mcp`, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

function acp(cwd: string, toolName: string) {
  const child = spawn("kiro-cli", ["acp", "--agent-engine", "v2", "--agent", "opencode", "--model", "claude-haiku-4.5"], { cwd, stdio: "pipe", detached: true });
  assert(child.pid); const pid = child.pid;
  record({ process: "spawn", pid });
  let id = 0, stderrBytes = 0;
  const pending = new Map<number, { readonly resolve: (value: Obj) => void; readonly reject: (error: Error) => void }>();
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const rpc = obj(JSON.parse(line));
      record({ acp: rpc });
      if (typeof rpc.method === "string" && rpc.id !== undefined) {
        if (rpc.method === "session/request_permission") {
          const params = obj(rpc.params), call = obj(params.toolCall);
          const exact = call.title === `Running: @opencode/${toolName}`;
          const options = Array.isArray(params.options) ? params.options.map(obj) : [];
          const allow = exact ? options.find((option) => option.kind === "allow_once") : undefined;
          record({ permission: exact ? "exact-tool" : "denied", selected: allow?.optionId ?? null });
          send({ jsonrpc: "2.0", id: rpc.id, result: { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } } });
        } else send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Client capability disabled" } });
      } else if (typeof rpc.id === "number") {
        const waiter = pending.get(rpc.id);
        if (waiter) { pending.delete(rpc.id); waiter.resolve(rpc); }
      }
    } catch (error) {
      for (const waiter of pending.values()) waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.on("error", (error) => { for (const waiter of pending.values()) waiter.reject(error); });
  child.on("exit", (code) => { for (const waiter of pending.values()) waiter.reject(new Error(`ACP exit ${code}`)); });
  return {
    async request(method: string, params: Obj) {
      const requestID = ++id;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await new Promise<Obj>((resolve, reject) => {
          pending.set(requestID, { resolve, reject });
          timer = setTimeout(() => reject(new Error(`Deadline: ${method}`)), Math.max(1, Math.min(expires - Date.now(), method === "session/prompt" ? 45000 : 15000)));
          record({ sent: method, params }); send({ jsonrpc: "2.0", id: requestID, method, params });
        });
        assert.equal(response.error, undefined, JSON.stringify(response.error));
        return obj(response.result);
      } finally { clearTimeout(timer); pending.delete(requestID); }
    },
    async close() {
      const exited = once(child, "exit");
      child.stdin.end();
      // Dedicated process group is created above; only this launcher's descendants are targeted.
      const timer = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } }, 2000);
      if (child.exitCode === null && child.signalCode === null) await exited;
      clearTimeout(timer); lines.close(); record({ process: "closed", pid, stderrBytes });
    },
  };
}

async function run() {
  assert.equal(process.env.KIRO_G1_LIVE, "1", "Requires KIRO_G1_LIVE=1; spends at most two Haiku prompts");
  const cwd = await mkdtemp(`${scratchRoot}/kiro-g1-`);
  const endpoints: Awaited<ReturnType<typeof endpoint>>[] = [];
  let client: ReturnType<typeof acp> | undefined, sessionID: string | undefined;
  try {
    console.log(execFileSync("kiro-cli", ["--version"], { timeout: 5000, encoding: "utf8" }).trim());
    await mkdir(`${cwd}/.kiro/agents`, { recursive: true, mode: 0o700 });
    const marker = `resource_${nonce()}`;
    await writeFile(`${cwd}/AGENTS.md`, `Instruction marker: ${marker}. Only use the provided opencode MCP tool. Do not use shell, filesystem, network or other tools.`, { mode: 0o600 });
    for (const epoch of ["A", "B"]) {
      phase = `${epoch}-setup`;
      const ep = await endpoint(epoch); endpoints.push(ep);
      const config = { name: "opencode", description: "Private G1 smoke", prompt: "Follow the instruction resource. Use the provided tool when asked.", resources: ["file://./AGENTS.md"], tools: ["@opencode"], includeMcpJson: false, model: "claude-haiku-4.5", mcpServers: { opencode: { url: ep.url, headers: { Authorization: `Bearer ${ep.token}` }, timeout: 7200000 } } };
      await writeFile(`${cwd}/.kiro/agents/opencode.json`, JSON.stringify(config), { mode: 0o600 });
      const denied = await fetch(ep.url, { method: "POST", headers: { Authorization: `Bearer ${epoch === "B" ? endpoints[0]?.token : "wrong"}` }, signal: AbortSignal.timeout(2000) });
      assert.equal(denied.status, 401);
      client = acp(cwd, ep.tool.name);
      await client.request("initialize", init);
      phase = epoch === "A" ? "new" : "load-replay";
      const opened = await client.request(epoch === "A" ? "session/new" : "session/load", { cwd, mcpServers: [], ...(sessionID ? { sessionId: sessionID } : {}) });
      if (epoch === "A") { sessionID = str(opened.sessionId); process.stderr.write(`Private native session for exact cleanup: ${sessionID}\n`); }
      assert(records.some((event) => event.transport === epoch && event.method === "initialize"));
      assert(records.some((event) => event.transport === epoch && event.method === "tools/list"));
      assert.equal(ep.calls.length, 0, "Replay must not execute tools");
      phase = `${epoch}-prompt`;
      const start = records.length;
      const text = epoch === "A" ? `Call ${ep.tool.name} once with label alpha. Report its secret and the instruction marker. Also state whether shell/filesystem tools are available, without attempting them. Keep it short.` : `Call the current tool ${ep.tool.name} once with key beta and generation 2. Report its secret and recall the previous tool's secret from our conversation. Do not call any old tool. Keep it short.`;
      const result = await client.request("session/prompt", { sessionId: sessionID, prompt: [{ type: "text", text }] });
      assert.equal(result.stopReason, "end_turn"); assert.equal(ep.calls.length, 1);
      const answer = records.slice(start).flatMap((event) => { if (!event.acp) return []; const rpc = obj(event.acp); if (rpc.method !== "session/update") return []; const update = obj(obj(rpc.params).update); return update.sessionUpdate === "agent_message_chunk" ? [str(obj(update.content).text)] : []; }).join("");
      assert(answer.includes(ep.secret), "Fresh synthetic secret absent");
      if (epoch === "A") assert(answer.includes(marker), "Resource marker absent");
      if (epoch === "B") { assert(answer.includes(endpoints[0]?.secret ?? "missing"), "Previous secret not recalled"); assert.equal(endpoints[0]?.calls.length, 1); }
      record({ answer, checked: epoch });
      await client.close(); client = undefined;
    }
    record({ verdict: "resume-supported-for-tested-scope", prompts: 2 });
  } finally {
    await client?.close();
    for (const ep of endpoints) await ep.close();
    if (sessionID) {
      try {
        execFileSync("kiro-cli", ["chat", "--delete-session", sessionID], { timeout: 10000, encoding: "utf8", cwd, stdio: "pipe" });
        record({ cleanup: "exact-native-session", success: true });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        record({ cleanup: "exact-native-session", failure: error.message }); process.exitCode = 1;
      }
    }
    await rm(cwd, { recursive: true });
    const sanitized = JSON.stringify(records, null, 2).replaceAll(cwd, "<SCOPE_CWD>").replaceAll(sessionID ?? "<unused-session>", "<SESSION_ID>");
    console.log(sanitized);
  }
}
await run();
