import { chmodSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"
import { z } from "zod"
import { createQaRun } from "./qa-paths.ts"

export const project = resolve(import.meta.dirname, "..")
export const root = createQaRun("kiro-package-")
for (const dir of ["home", "config/opencode", "data", "cache", "state", "tmp", "work", "unpacked"])
  mkdirSync(join(root, dir), { recursive: true })
export const env = {
  PATH: `${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: `${root}/home`,
  XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, XDG_CACHE_HOME: `${root}/cache`, XDG_STATE_HOME: `${root}/state`,
  TMPDIR: `${root}/tmp`, TMP: `${root}/tmp`, TEMP: `${root}/tmp`, OPENCODE_TEST_HOME: `${root}/home`,
  OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1", OPENCODE_SERVER_PASSWORD: "offline-only",
  HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost",
  npm_config_registry: "http://127.0.0.1:1", KIRO_CLI: `${root}/fake-kiro`, KIRO_QA_TRACE: `${root}/trace.jsonl`,
  KIRO_QA_ROOT: root,
}
writeFileSync(env.KIRO_QA_TRACE, "")
writeFileSync(`${root}/home/keep-user-data`, "owned-fixture-preserve")
writeFileSync(env.KIRO_CLI, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${project}/spike/fixtures/package-kiro.ts`)} "$@"\n`, { mode: 0o700 })
export const traceSchema = z.object({ event: z.string(), pid: z.number(), cwd: z.string(), nativeID: z.string().optional(), mode: z.string().optional(), url: z.string().optional() }).passthrough()
export const traces = () => readFileSync(env.KIRO_QA_TRACE, "utf8").split("\n").filter(Boolean).map(line => traceSchema.parse(JSON.parse(line)))
export const deadline = AbortSignal.timeout(25000)
export function waitTrace(event: string, from = 0) {
  return new Promise<z.infer<typeof traceSchema>>((resolve, reject) => {
    const watcher = watch(root, (_kind, name) => { if (name === "trace.jsonl") check() })
    const stop = () => { watcher.close(); deadline.removeEventListener("abort", abort) }
    const abort = () => { stop(); reject(deadline.reason) }
    const check = () => { const found = traces().slice(from).find(item => item.event === event); if (found) { stop(); resolve(found) } }
    deadline.addEventListener("abort", abort, { once: true }); check()
  })
}
export async function startHost(entry: string) {
  const configDir = `${root}/config/opencode`
  writeFileSync(`${configDir}/opencode.json`, JSON.stringify({
    plugin: [new URL(`file://${entry}`).href], enabled_providers: ["kiro"], model: "kiro/auto", small_model: "kiro/auto",
    share: "disabled", lsp: false, permission: "allow",
  }))
  writeFileSync(`${configDir}/.gitignore`, "*\n")
  mkdirSync(`${configDir}/tools`)
  writeFileSync(`${configDir}/tools/qa_probe.ts`, `import { z } from ${JSON.stringify(`${project}/node_modules/zod/index.js`)};\nexport default { description: 'Offline QA probe', args: { value: z.string() }, async execute(args: { readonly value: string }) { if(args.value !== 'offline-input') throw Error('wrong arguments'); return 'offline-secret-result'; } };\n`)
  const reservation = createServer().listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address(); assert(address && typeof address === "object")
  const port = address.port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const binary = resolve(process.env.OPENCODE_BIN ?? `${project}/node_modules/.bin/opencode`)
  const version = Bun.spawnSync([binary, "--version"], { env, cwd: `${root}/work`, timeout: 10000 })
  assert.equal(version.exitCode, 0); assert.equal(version.stdout.toString().trim(), "1.19.1")
  chmodSync(configDir, 0o555)
  const child = spawn(binary, ["--print-logs", "--log-level", "DEBUG", "serve", "--port", String(port), "--hostname", "127.0.0.1"], { env, cwd: `${root}/work`, stdio: ["ignore", "pipe", "pipe"] })
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()))
  const logs: string[] = []; child.stderr.on("data", data => logs.push(String(data)))
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(deadline.reason)
      deadline.addEventListener("abort", abort, { once: true })
      child.once("error", reject)
      child.once("exit", code => reject(new Error(`Host exited before listen: ${code}`)))
      child.stdout.on("data", data => { if (String(data).includes("listening on")) { deadline.removeEventListener("abort", abort); resolve() } })
    })
  } catch (error) { child.kill("SIGKILL"); await exited; chmodSync(configDir, 0o755); writeFileSync(`${root}/host.log`, logs.join("")); throw error }
  const headers = { authorization: `Basic ${Buffer.from("opencode:offline-only").toString("base64")}`, "content-type": "application/json" }
  const url = `http://127.0.0.1:${port}`
  async function request(path: string, body?: object, method = "POST") {
    const response = await fetch(`${url}${path}`, { headers, signal: deadline, method: body === undefined && method === "POST" ? "GET" : method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text(); assert(response.ok, `${path}: ${response.status} ${text}`)
    return text
  }
  return { request, url, headers, async close() {
    if (child.exitCode === null) {
      try { await fetch(`${url}/instance/dispose`, { method: "POST", headers, signal: AbortSignal.timeout(5000) }) }
      catch (error) { if (!(error instanceof Error)) throw error; logs.push(`QA cleanup dispose: ${error.name}\n`) }
    }
    if (child.exitCode === null) child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
    await exited; clearTimeout(timer); chmodSync(configDir, 0o755)
    writeFileSync(`${root}/host.log`, logs.join(""))
  } }
}
