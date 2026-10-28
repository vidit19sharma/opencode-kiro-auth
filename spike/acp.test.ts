import { test, expect } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpClient } from "../src/acp.js";
import type { AcpEvent, ApprovedMcpTool } from "../src/contracts.js";
import { PNG } from "./fixtures/image.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.ts", import.meta.url));
for (const [mode, image] of [["image-true", true], ["image-false", false], ["normal", false]] as const) test(`exposes image capability when initialize mode is ${mode}`, async () => {
  // Given an engine advertisement; When initialized; Then only explicit true enables images.
  const run = await setup(mode);
  try { await run.client.initialize(); expect(run.client).toMatchObject({ capabilities: { image } }); }
  finally { await run.close(); }
});
test("serializes exact image blocks when prompting over ACP", async () => {
  // Given a real child; When mixed content is sent; Then the child verifies the exact wire object.
  const run = await setup("image-wire");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    expect(await run.client.prompt(sid, [{ type: "text", text: "inspect" }, { type: "image", data: PNG, mimeType: "image/png" }], new AbortController().signal)).toEqual({ stopReason: "image-exact" });
  } finally { await run.close(); }
});
test("writes a single multi-MiB image prompt when decoded total is 10 MiB", async () => {
  // Given two maximum-sized images; When written as one line; Then the child receives every byte.
  const run = await setup("image-large");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    const data = Buffer.alloc(5 * 1024 * 1024).toString("base64");
    expect(await run.client.prompt(sid, [{ type: "image", data, mimeType: "image/png" }, { type: "image", data, mimeType: "image/png" }], new AbortController().signal)).toEqual({ stopReason: "image-large-exact" });
  } finally { await run.close(); }
});
async function setup(mode = "normal") {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "acp-offline-")));
  const events: AcpEvent[] = [];
  let approved: readonly ApprovedMcpTool[] = [{ serverName: "opencode", toolName: "safe" }];
  let onEvent: (event: AcpEvent) => void = () => {};
  const client = createAcpClient({ executable: process.execPath, args: [fixture, mode], cwd,
    onEvent: (event) => { events.push(event); onEvent(event); }, getApprovedTools: () => approved });
  return { client, cwd, events, listen: (listener: (event: AcpEvent) => void) => { onEvent = listener; }, approve: (tools: readonly ApprovedMcpTool[]) => { approved = tools; },
    async close() { await client.close(); await rm(cwd, { recursive: true }); } };
}

test("decodes fragmented/coalesced frames and suppresses load replay", async () => {
  // Given a real child using the G1 wire shapes.
  const run = await setup();
  try {
    await run.client.initialize();
    // When loading a transcript then prompting.
    expect(await run.client.open(run.cwd, "restored")).toBe("restored");
    expect(run.events).toEqual([]);
    const result = await run.client.prompt("restored", [{ type: "text", text: "normal" }], new AbortController().signal);
    // Then only fresh supported events are delivered.
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(run.events.map((event) => event.type)).toEqual(["text", "tool", "metadata"]);
    expect(run.events[0]).toEqual({ type: "text", sessionID: "restored", text: "fresh 🦊" });
    expect(run.events.every(Object.isFrozen)).toBe(true);
    for (const event of run.events) if (event.type === "metadata") expect(Object.isFrozen(event.value)).toBe(true);
  } finally { await run.close(); }
});

test("correlates concurrent control replies by ID", async () => {
  const run = await setup("interleaved");
  try {
    await run.client.initialize();
    expect(await Promise.all([run.client.open(run.cwd), run.client.open(run.cwd)])).toEqual(["first", "second"]);
  } finally { await run.close(); }
});

test("denies unverified permissions and every unadvertised client capability", async () => {
  const run = await setup("permissions");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    expect(await run.client.prompt(sid, [], new AbortController().signal)).toEqual({ stopReason: "replies:13" });
  } finally { await run.close(); }
});

test("reads the current allow-list at permission time", async () => {
  const run = await setup("revoked");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    run.listen(() => run.approve([]));
    expect(await run.client.prompt(sid, [], new AbortController().signal)).toEqual({ stopReason: "replies:1" });
  } finally { await run.close(); }
});

test("waits for post-cancel metadata before permitting the next prompt", async () => {
  const run = await setup("cancel");
  const controller = new AbortController();
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    run.listen((event) => { if (event.type === "text") controller.abort(); });
    await expect(run.client.prompt(sid, [], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await run.client.quiesce(sid, 1000)).toBe(true);
    expect(run.events.some((event) => event.type === "metadata")).toBe(true);
    run.listen((event) => { if (event.type === "text") run.client.cancel(sid); });
    const next = run.client.prompt(sid, [], new AbortController().signal);
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(await run.client.quiesce(sid, 1000)).toBe(true);
  } finally { await run.close(); }
});

test("returns false when cancellation has no terminal metadata", async () => {
  const run = await setup("no-metadata");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    run.listen((event) => { if (event.type === "text") run.client.cancel(sid); });
    await expect(run.client.prompt(sid, [], new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await run.client.quiesce(sid, 20)).toBe(false);
    await expect(run.client.prompt(sid, [], new AbortController().signal)).rejects.toThrow();
  } finally { await run.close(); }
});

for (const mode of ["eof", "malformed", "oversized", "oversized-line", "bad-id"]) test(`rejects pending controls on ${mode}`, async () => {
  const run = await setup(mode);
  try { await expect(run.client.initialize()).rejects.toThrow(); }
  finally { await run.close(); }
});

test("preserves useful error.data while sanitizing upstream secrets", async () => {
  const run = await setup("error");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    const failure = await run.client.prompt(sid, [{ type: "text", text: "private-prompt" }], new AbortController().signal).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ name: "AcpError", code: -32603, data: { reason: "Unknown model", token: "[redacted]", prompt: "[redacted]" } });
    expect(JSON.stringify(failure)).not.toContain("private-token");
    if (!(failure instanceof Error)) throw new Error("Expected typed ACP failure");
    expect(failure.message).toBe("Bearer [redacted]");
  } finally { await run.close(); }
});

test("rejects pending prompts on child exit", async () => {
  const run = await setup("exit");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    await expect(run.client.prompt(sid, [], new AbortController().signal)).rejects.toThrow();
  } finally { await run.close(); }
});

test("transmits long prompt blocks without a short control deadline", async () => {
  const run = await setup("length");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    expect(await run.client.prompt(sid, [{ type: "text", text: "x".repeat(1024 * 1024) }], new AbortController().signal)).toEqual({ stopReason: "1048576" });
  } finally { await run.close(); }
});

test("close settles a held prompt and is idempotent", async () => {
  const run = await setup("hold");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    run.listen(() => { void run.client.close(); });
    await expect(run.client.prompt(sid, [], new AbortController().signal)).rejects.toThrow();
    await Promise.all([run.client.close(), run.client.close()]);
  } finally { await run.close(); }
});

test("shutdown reaps the owned launcher and its descendant", async () => {
  const run = await setup("tree");
  try {
    await run.client.initialize();
    const pids: unknown = JSON.parse(await readFile(join(run.cwd, "pids.json"), "utf8"));
    expect(Array.isArray(pids)).toBe(true);
    await run.client.close();
    if (!Array.isArray(pids)) throw new Error("Invalid fixture PIDs");
    for (const pid of pids) { if (typeof pid !== "number") throw new Error("Invalid PID"); expect(() => process.kill(pid, 0)).toThrow(); }
  } finally { await run.close(); }
}, 5000);

test("forces cleanup when an exited launcher leaves a TERM-ignoring descendant", async () => {
  const run = await setup("orphan");
  let ownedPID: number | undefined;
  try {
    await run.client.initialize();
    const pid: unknown = JSON.parse(await readFile(join(run.cwd, "descendant.json"), "utf8"));
    if (typeof pid !== "number") throw new Error("Invalid fixture PID");
    ownedPID = pid;
    await run.client.close();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await run.close();
    if (ownedPID) try { process.kill(ownedPID, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  }
}, 5000);

test("ignores metadata that precedes the cancelled reply", async () => {
  const run = await setup("early-metadata");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    run.listen((event) => { if (event.type === "text") run.client.cancel(sid); });
    await expect(run.client.prompt(sid, [], new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await run.client.quiesce(sid, 20)).toBe(false);
  } finally { await run.close(); }
});

test("bounds silent controls while permitting a held prompt beyond that bound", async () => {
  const control = await setup("silent"), held = await setup("long-held");
  try {
    await held.client.initialize(); const sid = await held.client.open(held.cwd);
    const results = await Promise.allSettled([
      control.client.initialize(),
      held.client.prompt(sid, [], new AbortController().signal),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "TIMEOUT" } });
    expect(results[1]).toEqual({ status: "fulfilled", value: { stopReason: "end_turn" } });
  } finally { await Promise.all([control.close(), held.close()]); }
}, 20000);

test("does not send a prompt whose signal is already aborted", async () => {
  const run = await setup("exit");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    await expect(run.client.prompt(sid, [], AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(await run.client.quiesce(sid, 20)).toBe(true);
  } finally { await run.close(); }
});

test("rejects gracefully when the executable cannot start", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "acp-offline-")));
  const client = createAcpClient({ executable: join(cwd, "absent"), args: [], cwd, onEvent: () => {}, getApprovedTools: () => [] });
  try { await expect(client.initialize()).rejects.toMatchObject({ code: "SPAWN" }); }
  finally { await client.close(); await rm(cwd, { recursive: true }); }
});

test("denies permission when the allow-list identity is ambiguous", async () => {
  const run = await setup("revoked");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    run.approve([{ serverName: "opencode", toolName: "safe" }, { serverName: "opencode", toolName: "safe" }]);
    expect(await run.client.prompt(sid, [], new AbortController().signal)).toEqual({ stopReason: "replies:1" });
  } finally { await run.close(); }
});

test("requires quiescence even when cancellation originates upstream", async () => {
  const run = await setup("upstream-cancel");
  try {
    await run.client.initialize(); const sid = await run.client.open(run.cwd);
    expect(await run.client.prompt(sid, [], new AbortController().signal)).toEqual({ stopReason: "cancelled" });
    expect(await run.client.quiesce(sid, 20)).toBe(false);
  } finally { await run.close(); }
});
