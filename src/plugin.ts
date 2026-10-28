import { execFile } from "node:child_process"
import type { Config, Plugin } from "@opencode-ai/plugin"
import type { Auth, Model } from "@opencode-ai/sdk/v2"
import { createBridge } from "./bridge.js"
import type { Bridge } from "./contracts.js"
import { currentModels, type KiroModel } from "./models.js"

const MARKER = "kiro-cli-managed"
const BASE_URL = "http://kiro.invalid/v1"
const NPM = "@ai-sdk/openai-compatible"
const DEADLINES = { timeout: false, headerTimeout: 7_260_000, chunkTimeout: 7_260_000 } as const
const TEXT = { text: true, image: false, audio: false, video: false, pdf: false } as const
const INPUT = { ...TEXT, image: true } as const
class LocalError extends Error {
  readonly name = "LocalError"
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const validScope = (value: string): boolean => value.length > 0 && value.length <= 1024 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
function assertNever(_value: never): never { throw new LocalError(500, "auth_variant_unknown", "Unexpected host authentication variant.") }
function modelInfo(model: KiroModel): Model {
  return {
    id: model.id, providerID: "kiro", api: { id: model.id, url: BASE_URL, npm: NPM },
    name: `${model.name} (Kiro subscription)`, release_date: "", status: "active",
    capabilities: { temperature: false, reasoning: false, attachment: true, toolcall: true, input: INPUT, output: TEXT, interleaved: false },
    // Zero is host display accounting, not free inference; Kiro bills subscription credits.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // Local accounting reserve only: the CLI catalog does not report a vendor output maximum.
    limit: { context: model.context, output: Math.min(8192, Math.floor(model.context / 4)) },
    options: {}, headers: {},
  }
}

export const KiroAuthPlugin: Plugin = async (input) => {
  const executable = process.env.KIRO_CLI || "kiro-cli"
  let bridge: Promise<Bridge> | undefined
  let disposing: Promise<void> | undefined
  const lifetime = new AbortController()
  let healthyUntil = 0
  let getAuth: (() => Promise<Auth>) | undefined
  const command = (args: readonly string[], signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const child = execFile(executable, [...args], { timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8", signal }, (error, stdout) => {
      if (signal.aborted) { reject(signal.reason); return }
      if (!error) { resolve(stdout); return }
      if (error.code === "ENOENT") reject(new LocalError(503, "cli_missing", "Kiro CLI was not found. Install kiro-cli or set KIRO_CLI to its executable."))
      else if (args[0] === "whoami" && error.code === 1) reject(new LocalError(401, "login_required", "Run kiro-cli login in a terminal, then retry."))
      else reject(new LocalError(503, "cli_check_failed", "Kiro CLI health check failed or timed out. Check kiro-cli --version and kiro-cli whoami -f json in a terminal."))
    })
    child.stdin?.end()
  })
  const health = async (signal: AbortSignal, force = false): Promise<void> => {
    signal.throwIfAborted()
    if (!force && Date.now() < healthyUntil) return
    const version = /^kiro-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(await command(["--version"], signal))
    const [major = 0, minor = 0, patch = 0] = version?.slice(1).map(Number) ?? []
    if (major < 2 || (major === 2 && (minor < 33 || (minor === 33 && patch < 1))))
      throw new LocalError(503, "cli_unsupported", "Use Kiro CLI 2.33.1 or newer with ACP v2. 2.33.1 is the tested baseline; earlier versions are unverified.")
    const firstLine = (await command(["whoami", "-f", "json"], signal)).split(/\r?\n/u)[0] ?? ""
    let identity: unknown
    try { identity = JSON.parse(firstLine) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new LocalError(503, "identity_unsupported", "Cannot parse Kiro CLI identity. Check kiro-cli whoami -f json; no identity output was retained.")
    }
    if (!record(identity) || typeof identity.accountType !== "string" || !["IamIdentityCenter", "BuilderId"].includes(identity.accountType))
      throw new LocalError(503, "identity_unsupported", "Unsupported Kiro CLI identity format. Check kiro-cli whoami -f json; no identity output was retained.")
    signal.throwIfAborted()
    healthyUntil = Date.now() + 60_000
  }
  const transport = async (resource: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = AbortSignal.any([init?.signal ?? (resource instanceof Request ? resource.signal : new AbortController().signal), lifetime.signal])
    signal.throwIfAborted()
    try {
      const request = new Request(resource, init)
      const path = new URL(request.url).pathname
      if (!((path === "/v1/chat/completions" && request.method === "POST") || (path === "/v1/models" && request.method === "GET")))
        throw new LocalError(404, "route_not_found", "Only GET /v1/models and POST /v1/chat/completions are supported.")
      if (path === "/v1/models") return Response.json({ object: "list", data: (await currentModels()).map((model) => ({ id: model.id, object: "model", owned_by: "kiro" })) })
      const sessionID = request.headers.get("x-opencode-session") ?? ""
      const encodedAgent = request.headers.get("x-opencode-agent") ?? ""
      let agent: string
      try { agent = decodeURIComponent(encodedAgent) }
      catch (error) {
        if (!(error instanceof URIError)) throw error
        throw new LocalError(400, "scope_invalid", "Malformed URI-encoded x-opencode-agent header.")
      }
      if (!validScope(sessionID) || !validScope(agent) || !/^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/u.test(encodedAgent))
        throw new LocalError(400, "scope_invalid", "Valid x-opencode-session and URI-encoded x-opencode-agent headers are required.")
      let body: unknown
      try { body = await request.json() }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        throw new LocalError(400, "request_invalid", "Chat body must be valid JSON.")
      }
      if (!record(body) || typeof body.model !== "string" || !body.model || !Array.isArray(body.messages))
        throw new LocalError(400, "request_invalid", "Chat body must contain a model ID and messages array.")
      const auth = await getAuth?.()
      const registrationError = new LocalError(401, "registration_required", "Run kiro-cli login, then opencode auth login --provider kiro and register the non-secret kiro-cli-managed marker. Pasted keys and OAuth entries are unsupported.")
      switch (auth?.type) {
        case "api": if (auth.key !== MARKER) throw registrationError; break
        case "oauth": case "wellknown": case undefined: throw registrationError
        default: assertNever(auth)
      }
      await health(signal)
      signal.throwIfAborted()
      const active = await (bridge ??= createBridge({ executable }))
      signal.throwIfAborted()
      const response = await active.handle(body, { sessionID, agent, directory: input.directory }, signal)
      if (response.status === 401) healthyUntil = 0
      return response
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (!(error instanceof LocalError)) throw error
      return Response.json({ error: { message: error.message, type: "kiro_error", code: error.code } }, { status: error.status })
    }
  }
  return {
    async config(config) {
      const existing = config.provider?.kiro
      const models: NonNullable<NonNullable<Config["provider"]>[string]["models"]> = Object.fromEntries((await currentModels()).map((item) => {
        const model = modelInfo(item)
        return [item.id, { id: item.id, name: model.name, limit: model.limit, cost: { input: 0, output: 0 }, attachment: true, reasoning: false, temperature: false, tool_call: true, modalities: { input: ["text", "image"], output: ["text"] } }]
      }))
      config.provider = { ...config.provider, kiro: { ...existing, npm: NPM, name: "Kiro (subscription credits; zero display cost is not free)", api: BASE_URL, env: [], models,
        options: { ...DEADLINES, ...existing?.options, baseURL: BASE_URL, fetch: transport } } }
    },
    provider: { id: "kiro", async models() { return Object.fromEntries((await currentModels()).map((model) => [model.id, modelInfo(model)])) } },
    "chat.headers": async ({ model, sessionID, agent }, output) => {
      if (model.providerID !== "kiro") return
      output.headers["x-opencode-session"] = sessionID
      output.headers["x-opencode-agent"] = encodeURIComponent(agent)
    },
    auth: {
      provider: "kiro",
      async loader(auth, provider) {
        getAuth = auth
        return { ...DEADLINES, ...provider.options, baseURL: BASE_URL, apiKey: MARKER, fetch: transport }
      },
      methods: [{ type: "api", label: "CLI-managed login (terminal registration)", prompts: [{ type: "text", key: "registration",
        message: "Run kiro-cli login in a terminal first. Enter kiro-cli-managed here AND at OpenCode's API-key prompt (non-secret registration marker, not an API key).",
        placeholder: MARKER, validate: (value) => value === MARKER ? undefined : "Enter the non-secret kiro-cli-managed marker after terminal login.",
      }], async authorize(values) {
        if (values?.registration !== MARKER) return { type: "failed" }
        await health(lifetime.signal, true)
        return { type: "success", key: MARKER }
      } }],
    },
    async event({ event }) {
      if (!bridge || lifetime.signal.aborted) return
      const active = await bridge
      if (lifetime.signal.aborted) return
      switch (event.type) {
        case "session.status": active.observe(event.properties.sessionID, event.properties.status.type); break
        case "session.idle": active.observe(event.properties.sessionID, "idle"); break
        case "session.deleted": active.observe(event.properties.info.id, "deleted"); break
        default: break
      }
    },
    dispose() {
      return disposing ??= (async () => {
        lifetime.abort(new DOMException("Kiro plugin disposed", "AbortError"))
        healthyUntil = 0
        if (bridge) await (await bridge).close()
      })()
    },
  }
}
