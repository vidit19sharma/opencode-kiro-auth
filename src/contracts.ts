// Plugin-internal contracts only. Parse wire input in the owning runtime module.
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

export type Scope = {
  readonly sessionID: string
  readonly agent: string
  readonly directory: string
}

export type ToolSpec = {
  readonly name: string
  readonly description: string
  readonly inputSchema: { readonly [key: string]: Json }
}

export type ToolResult = {
  readonly callID: string
  readonly content: Json
  readonly isError: boolean
}

export type ToolCall = {
  readonly callID: string
  readonly name: string
  readonly arguments: string
}

export type PromptBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

export type AcpEvent =
  | { readonly type: "text"; readonly sessionID: string; readonly text: string }
  | { readonly type: "tool"; readonly sessionID: string; readonly acpCallID: string; readonly name: string }
  | { readonly type: "metadata"; readonly sessionID: string; readonly value: Json }

// Exact MCP wire identity, not a display title or an ACP call ID.
export type ApprovedMcpTool = { readonly serverName: "opencode"; readonly toolName: string }

export type AcpClientOptions = {
  readonly executable: string
  // Production: acp --agent-engine v2 --agent opencode --model <validated-id>.
  readonly args: readonly string[]
  readonly cwd: string
  readonly onEvent: (event: AcpEvent) => void
  // Read at permission-request time; absent/ambiguous identity or no match means deny.
  readonly getApprovedTools: () => readonly ApprovedMcpTool[]
}

export type AcpClient = {
  readonly capabilities: { readonly image: boolean }
  initialize(): Promise<void>
  open(cwd: string, resumeID?: string): Promise<string>
  prompt(sessionID: string, content: readonly PromptBlock[], signal: AbortSignal): Promise<{ readonly stopReason: string }>
  cancel(sessionID: string): void
  quiesce(sessionID: string, timeoutMs: number): Promise<boolean>
  close(): Promise<void>
}

export type ToolEndpoint = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  // Live snapshot of identities published by the latest setTools, after wire-name mapping.
  readonly approvedTools: readonly ApprovedMcpTool[]
  setTools(tools: readonly ToolSpec[]): void
  // Authenticated initialize/initialized/current tools/list on one live endpoint-local session.
  waitReady(signal: AbortSignal, timeoutMs?: number): Promise<void>
  settle(result: ToolResult): void
  release(reason: Error): void
  close(): Promise<void>
}

export type ToolServer = {
  endpoint(scope: Scope, onCall: (call: ToolCall) => void): ToolEndpoint
  close(): Promise<void>
}

export type BridgeOptions = { readonly executable: string }

export type Bridge = {
  handle(body: unknown, scope: Scope, signal: AbortSignal): Promise<Response>
  observe(sessionID: string, status: "busy" | "retry" | "idle" | "deleted"): void
  close(): Promise<void>
}
