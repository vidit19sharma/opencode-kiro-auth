import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { createConnection } from "node:net"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { PNG } from "../spike/fixtures/image.ts"
import { z } from "zod"
import { deadline, env, project, root, startHost, traces, waitTrace } from "./qa-host.ts"

const checks: string[] = []
let parkedAbort: { sessionID: string; pid: number; error: string; cancels: number; releasedGates: number; prompts: number; recovered: boolean } | undefined
let disposal: { responseElapsedMs: number; cleanupElapsedMs: number; converged: boolean; observations: number; resources: { pid: number; cwd: string; scratchGone: boolean; processGone: boolean; listenerGone: boolean }[] } | undefined
console.log(`Offline evidence: ${root}`)
execFileSync(process.execPath, ["run", "build"], { cwd: project, stdio: "inherit" })
const run = (args: readonly string[]) => execFileSync("npm", [...args], { cwd: project, env, encoding: "utf8", timeout: 20000 })
const packSchema = z.array(z.object({ filename: z.string(), files: z.array(z.object({ path: z.string() })) }))
const dry = packSchema.parse(JSON.parse(run(["pack", "--dry-run", "--json", "--ignore-scripts"])))
const packed = packSchema.parse(JSON.parse(run(["pack", "--json", "--ignore-scripts", "--pack-destination", root])))[0]
assert(packed)
assert.deepEqual(packed.files, dry[0]?.files)
assert(packed.files.some(file => file.path === "dist/index.js"))
assert(packed.files.some(file => file.path === "dist/cli.js"))
assert(packed.files.every(file => !/^(src|spike|scripts)\//u.test(file.path)))
execFileSync("tar", ["-xzf", `${root}/${packed.filename}`, "-C", `${root}/unpacked`], { env })
const entry = `${root}/unpacked/package/dist/index.js`
const module = await import(pathToFileURL(entry).href)
assert.deepEqual(Object.keys(module), ["default"]); assert.equal(typeof module.default, "function")
execFileSync(process.execPath, [`${root}/unpacked/package/dist/cli.js`, "--help"], { env, timeout: 10000 })
checks.push("npm dry-run/tarball agree; unpacked default-only entry and CLI load")
const host = await startHost(entry)
// Override the test-owned tool before the first instance/provider bootstrap.
writeFileSync(`${root}/config/opencode/tools/qa_probe.ts`, `import { z } from ${JSON.stringify(`${project}/node_modules/zod/index.js`)};
import { appendFileSync } from 'node:fs';
export default { description: 'Offline QA probe', args: { value: z.string() }, async execute(args: { readonly value: string }, context: { readonly abort: AbortSignal }) {
  if (args.value === 'offline-abort-input') {
    appendFileSync(${JSON.stringify(env.KIRO_QA_TRACE)}, JSON.stringify({ event: 'host-tool-start', pid: process.pid, cwd: process.cwd() }) + '\\n');
    await new Promise<void>((_, reject) => { const abort = () => reject(context.abort.reason); context.abort.addEventListener('abort', abort, { once: true }); if (context.abort.aborted) abort(); });
  }
  if (args.value !== 'offline-input') throw Error('wrong arguments'); return 'offline-secret-result';
} };\n`)
const events: string[] = []
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
let pump: Promise<void> | undefined
const replySchema = z.object({ info: z.object({ error: z.object({ name: z.string(), data: z.object({ message: z.string() }).passthrough() }).optional(), finish: z.string().optional() }).passthrough(), parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) })
async function turn(mode: string, agent = "build") {
  const session = z.object({ id: z.string() }).parse(JSON.parse(await host.request("/session", { title: "Offline packed QA" })))
  const from = traces().length
  const pending = host.request(`/session/${session.id}/message`, { model: { providerID: "kiro", modelID: "auto" }, agent, parts: [{ type: "text", text: mode }] })
  if (mode === "qa:abort") { await waitTrace("ready", from); await host.request(`/session/${session.id}/abort`, {}, "POST"); await waitTrace("cancelled", from) }
  return { id: session.id, reply: replySchema.parse(JSON.parse(await pending)), from }
}
try {
  const eventStream = await fetch(`${host.url}/global/event`, { headers: host.headers, signal: deadline })
  assert(eventStream.body)
  const eventReader = eventStream.body.getReader(); reader = eventReader
  pump = (async () => { for (;;) { const next = await eventReader.read(); if (next.done) return; events.push(new TextDecoder().decode(next.value)) } })()
  // Given an unregistered packed plugin; When the first request runs; Then config fetch returns an actionable error without native inference.
  const catalog = z.object({ all: z.array(z.object({ id: z.string(), models: z.record(z.string(), z.unknown()) })) }).parse(JSON.parse(await host.request("/provider")))
  assert(catalog.all.some(provider => provider.id === "kiro" && Object.hasOwn(provider.models, "auto")))
  const authFile = `${root}/data/opencode/auth.json`
  assert.equal(existsSync(authFile), false)
  const absent = await turn("qa:text")
  assert(absent.reply.info.error); assert.match(absent.reply.info.error.data.message, /opencode auth login/u)
  assert.equal(traces().some(item => item.event === "prompt"), false)
  assert.equal(existsSync(authFile), false)
  checks.push("fresh discovery/startup/request never register auth; pre-registration config fetch actionable")
  // Given deliberate public test-owned registration; When disposed/reloaded; Then the real loader reaches the real ACP/MCP/bridge path.
  assert.equal(await host.request("/auth/kiro", { type: "api", key: "kiro-cli-managed" }, "PUT"), "true")
  const registered = readFileSync(authFile, "utf8")
  await host.request("/instance/dispose", {}, "POST"); await host.request("/provider")
  for (const agent of ["build", "plan"]) {
    const result = await turn("qa:text", agent)
    assert.equal(result.reply.info.error, undefined)
    assert(result.reply.parts.some(part => part.text === "offline-text"))
  }
  checks.push("explicit marker survives reload; text runs through packed plugin in two session/agent scopes")
  // Given a deterministic 1x1 PNG; When the real host receives a file part;
  // Then the packed bridge delivers exact pixels in one native prompt.
  const png = PNG
  const imageSession = z.object({ id: z.string() }).parse(JSON.parse(await host.request("/session", { title: "Offline image QA" })))
  const imageFrom = traces().length
  const imageReply = replySchema.parse(JSON.parse(await host.request(`/session/${imageSession.id}/message`, { model: { providerID: "kiro", modelID: "auto" }, agent: "build", parts: [{ type: "text", text: "qa:image" }, { type: "file", mime: "image/png", filename: "probe.png", url: `data:image/png;base64,${png}` }] })))
  assert.equal(imageReply.info.error, undefined)
  assert(imageReply.parts.some(part => part.text === "offline-image-ok"))
  const imageTrace = traces().slice(imageFrom)
  assert.equal(imageTrace.filter(item => item.event === "prompt").length, 1)
  assert.equal(imageTrace.find(item => item.event === "image-received")?.sha256, createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"))
  checks.push("host image file part → ACP image block, exact bytes, one prompt")
  const tool = await turn("qa:tool")
  assert.equal(tool.reply.info.error, undefined)
  assert(tool.reply.parts.some(part => part.text === "offline-tool-roundtrip"))
  assert.equal(traces().slice(tool.from).filter(item => item.event === "prompt").length, 1)
  assert(traces().slice(tool.from).some(item => item.event === "permission-allowed"))
  assert(traces().slice(tool.from).some(item => item.event === "tool-result"))
  const transcript = z.array(z.object({ parts: z.array(z.object({ type: z.string(), tool: z.string().optional(), state: z.object({ status: z.string(), output: z.string().optional() }).passthrough().optional() }).passthrough()) }))
    .parse(JSON.parse(await host.request(`/session/${tool.id}/message`)))
  assert(transcript.some(message => message.parts.some(part => part.type === "tool" && part.tool === "qa_probe" && part.state?.status === "completed" && part.state.output === "offline-secret-result")))
   checks.push("host custom tool + secret result crosses HTTP segments, one ACP prompt, exact permission identity, actual HTTP MCP")
   // Given a parked real ACP/MCP call executing in the real host; When aborted;
   // Then native cancellation releases the gate/child and the same scope accepts fresh input.
   const abortedSession = z.object({ id: z.string() }).parse(JSON.parse(await host.request("/session", { title: "Parked tool abort" })))
   const abortFrom = traces().length
   const aborted = host.request(`/session/${abortedSession.id}/message`, { model: { providerID: "kiro", modelID: "auto" }, agent: "build", parts: [{ type: "text", text: "qa:tool-abort" }] })
   await waitTrace("host-tool-start", abortFrom)
   await host.request(`/session/${abortedSession.id}/abort`, {}, "POST")
   const abortedReply = replySchema.parse(JSON.parse(await aborted))
   const abortedError = abortedReply.info.error; assert(abortedError)
   assert.equal(abortedError.name, "MessageAbortedError")
   const abortedTranscript = z.array(z.object({ parts: z.array(z.object({ type: z.string(), state: z.object({ status: z.string(), error: z.string().optional() }).passthrough().optional() }).passthrough()) })).parse(JSON.parse(await host.request(`/session/${abortedSession.id}/message`)))
   assert(abortedTranscript.some(message => message.parts.some(part => part.type === "tool" && part.state?.status === "error" && part.state.error === "Tool execution aborted")))
   const cancellation = Promise.all([waitTrace("cancelled", abortFrom), waitTrace("tool-released", abortFrom), waitTrace("exit", abortFrom)])
   let abortTimer: ReturnType<typeof setTimeout> | undefined
   try { await Promise.race([cancellation, new Promise<never>((_, reject) => { abortTimer = setTimeout(() => reject(new Error(`Parked abort stranded native work: ${JSON.stringify(traces().slice(abortFrom))}`)), 3000) })]) }
   finally { clearTimeout(abortTimer) }
   const abortedTrace = traces().slice(abortFrom)
   assert.equal(abortedTrace.filter(item => item.event === "cancelled").length, 1)
   assert.equal(abortedTrace.filter(item => item.event === "tool-released").length, 1)
   const parkedChild = abortedTrace.find(item => item.event === "prompt"); assert(parkedChild)
   const exitDeadline = performance.now() + 3000
   for (;;) {
     try { process.kill(parkedChild.pid, 0) }
     catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; break }
     assert(performance.now() < exitDeadline, "Aborted native child failed to exit")
     await new Promise<void>(resolve => setImmediate(resolve))
   }
   const recovered = replySchema.parse(JSON.parse(await host.request(`/session/${abortedSession.id}/message`, { model: { providerID: "kiro", modelID: "auto" }, agent: "build", parts: [{ type: "text", text: "qa:text" }] })))
   assert.equal(recovered.info.error, undefined)
   assert(recovered.parts.some(part => part.text === "offline-text"))
   assert.equal(traces().slice(abortFrom).filter(item => item.event === "prompt").length, 2)
   parkedAbort = { sessionID: abortedSession.id, pid: parkedChild.pid, error: abortedError.name, cancels: abortedTrace.filter(item => item.event === "cancelled").length, releasedGates: abortedTrace.filter(item => item.event === "tool-released").length, prompts: traces().slice(abortFrom).filter(item => item.event === "prompt").length, recovered: true }
   checks.push("parked host tool abort: MessageAbortedError, one ACP cancel, one MCP gate release, owned child exit, same-scope next message succeeds without dispose")
  for (const mode of ["qa:error", "qa:stream-error"]) {
    const result = await turn(mode)
    assert(result.reply.info.error); assert.notEqual(result.reply.info.finish, "stop")
    checks.push(`${mode}: assistant error, no successful stop`)
  }
  await turn("qa:abort")
  checks.push("host abort endpoint delivers ACP cancellation and terminal metadata")
  assert.equal(readFileSync(authFile, "utf8"), registered)
  const acp = traces().filter(item => item.event === "mcp-ready")
  assert(acp.length > 0)
  const started = performance.now()
  await host.request("/instance/dispose", {}, "POST")
  disposal = { responseElapsedMs: performance.now() - started, cleanupElapsedMs: 0, converged: false, observations: 0, resources: [] }
  const ordering = disposal
  await new Promise<void>((resolve, reject) => {
    let checking = false, settled = false
    const finish = (error?: Error) => { if (settled) return; settled = true; clearInterval(interval); clearTimeout(timeout); ordering.cleanupElapsedMs = performance.now() - started; error ? reject(error) : resolve() }
    const inspect = async () => {
      if (checking) return
      checking = true
      try {
        const observed = await Promise.all(acp.map(async child => {
          let processGone = false
          try { process.kill(child.pid, 0) } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; processGone = true }
          assert(child.url)
          const endpoint = new URL(child.url)
          const listenerGone = await new Promise<boolean>(settle => {
            const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) })
            socket.once("connect", () => { socket.destroy(); settle(false) })
            socket.once("error", error => { socket.destroy(); settle("code" in error && error.code === "ECONNREFUSED") })
            socket.setTimeout(200, () => { socket.destroy(); settle(false) })
          })
          return { pid: child.pid, cwd: child.cwd, scratchGone: !existsSync(child.cwd), processGone, listenerGone }
        }))
        if (settled) return
        ordering.resources = observed; ordering.observations++
        ordering.converged = ordering.resources.every(item => item.scratchGone && item.processGone && item.listenerGone)
        if (ordering.converged) finish()
      } catch (error) { finish(error instanceof Error ? error : new DOMException("Cleanup observation failed", "OperationError")) }
      finally { checking = false }
    }
    const interval = setInterval(() => { void inspect() }, 25)
    const timeout = setTimeout(() => finish(new DOMException("Owned cleanup did not converge within five seconds", "TimeoutError")), 5000)
    void inspect()
  })
  assert.equal(readFileSync(authFile, "utf8"), registered)
  assert.equal(readFileSync(`${root}/home/keep-user-data`, "utf8"), "owned-fixture-preserve")
  for (const child of acp) {
    assert.equal(existsSync(child.cwd), false, `scratch leaked: ${child.cwd}`)
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" })
    assert(child.url)
    await assert.rejects(fetch(child.url, { signal: AbortSignal.timeout(1000) }))
  }
  assert.equal(readdirSync(`${root}/tmp`).some(name => name.startsWith("opencode-kiro-")), false)
  checks.push("dispose removes bridge scratch, terminates exact ACP children, closes MCP endpoints; marker/user fixture preserved")
} finally {
  await Promise.allSettled([reader?.cancel(), pump]); await host.close()
  writeFileSync(`${root}/events.json`, JSON.stringify(events.join(""), null, 2).replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/gu, "[image attachment redacted]"))
   writeFileSync(`${root}/evidence.json`, JSON.stringify({ root, checks, parkedAbort, disposal, trace: traces() }, null, 2))
   console.log(JSON.stringify({ root, checks, parkedAbort, disposal }, null, 2))
}
