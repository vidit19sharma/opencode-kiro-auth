# Gate G1 — v2 authenticated MCP reattachment

**Decision: native resume is supported for the tested, quiescent same-scope lifecycle.** On 2026-10-22, `kiro-cli 2.33.1` successfully loaded the same session in a second process, authenticated to the regenerated agent-file HTTP endpoint, fetched its new tools, used its changed name/schema, and recalled the preceding tool result. Keep fail-closed history reconstruction when load or endpoint/schema verification fails. This closes the focused G1 resume check; it is not evidence for G2/G3 or exhaustive tool isolation.

## Scope and provenance

- Read `.omo/plans/kiro-implementation.md`, all three `/tmp/kiro-probe.gwxj2G/FINDINGS-R{1,2,3}.md` reports, existing ACP/server/load drivers, agent configs, and saved MCP configuration documentation before execution. R2 exists now; it does not change this v2 gate.
- One unique private scratch cwd, two ephemeral `127.0.0.1` listeners, two generated bearer tokens, one native session, two successive ACP processes. The old listener remained available during load/prompt B to detect stale requests. No session-level MCP override.
- **Exactly two live prompts**, both explicitly `claude-haiku-4.5`. No retries or additional text-only prompt. Existing CLI login/environment was inherited without inspecting credentials or changing auth/settings.
- No 130-second rerun. R1 remains the evidence for agent-file `timeout: 7200000` exceeding the session-level 120-second limit.
- Reusable opt-in driver: `spike/gate-g1.ts`. It has no new dependency and touches no implementation module.
- Private execution output: the local OpenCode tool-output artifact `tool_1649ae309001AwqrktzGHOtgt0`. Its first lines contain the native session ID and exact deletion confirmation; do not publish those lines. The recorded RPC array substitutes `<SESSION_ID>` and `<SCOPE_CWD>` and omits bearer values.

## Exact sanitized configuration

Written to `<SCOPE_CWD>/.kiro/agents/opencode.json` before **each** spawn. Substitute `EPOCH`, `PORT`, and `TOKEN` with fresh per-epoch values; this is the actual field shape, not ACP session HTTP-header syntax:

```json
{
  "name": "opencode",
  "description": "Private G1 smoke",
  "prompt": "Follow the instruction resource. Use the provided tool when asked.",
  "resources": ["file://./AGENTS.md"],
  "tools": ["@opencode"],
  "includeMcpJson": false,
  "model": "claude-haiku-4.5",
  "mcpServers": {
    "opencode": {
      "url": "http://127.0.0.1:<PORT_EPOCH>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN_EPOCH>" },
      "timeout": 7200000
    }
  }
}
```

**Agent-file `headers` is an object map.** Earlier R1 logs did not prove an authenticated agent-file connection. The saved documentation supplied this shape, and both live endpoints accepted it. Do not substitute the ACP session-server `headers: [{name,value}]` shape here.

`AGENTS.md` was mode 0600, the scratch cwd was created privately by `mkdtemp`, and both epochs used the same cwd/resource. Exact resource text after replacing the generated marker with `<RESOURCE_MARKER>`:

```text
Instruction marker: <RESOURCE_MARKER>. Only use the provided opencode MCP tool. Do not use shell, filesystem, network or other tools.
```

Both process argument vectors:

```text
kiro-cli acp --agent-engine v2 --agent opencode --model claude-haiku-4.5
```

## ACP fixtures

Each process starts its RPC IDs at 1. All placeholders represent literal runtime values replaced for publication. `initialize`, new/load controls have 15-second deadlines; each prompt has a 45-second deadline. Control deadlines are additionally clamped to a shared 140-second execution deadline; cleanup commands have separate bounded deadlines. There is no application retry.

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"gate-g1","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"<SCOPE_CWD>","mcpServers":[]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<SESSION_ID>","prompt":[{"type":"text","text":"Call <TOOL_A> once with label alpha. Report its secret and the instruction marker. Also state whether shell/filesystem tools are available, without attempting them. Keep it short."}]}}
```

After prompt A returned `{"stopReason":"end_turn"}`, close process A, regenerate endpoint/token/config, spawn process B, and initialize it identically:

```jsonl
{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"cwd":"<SCOPE_CWD>","mcpServers":[],"sessionId":"<SESSION_ID>"}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<SESSION_ID>","prompt":[{"type":"text","text":"Call the current tool <TOOL_B> once with key beta and generation 2. Report its secret and recall the previous tool's secret from our conversation. Do not call any old tool. Keep it short."}]}}
```

Both new/load responses report `currentModeId: "opencode"`, `currentModelId: "claude-haiku-4.5"`. Initialization advertises `loadSession: true`, `mcpCapabilities.http: true`, `authMethods: []`. Availability of other selectable modes/models is not evidence that they were invoked.

## MCP fixtures and schema refresh

Names were unique generated values: `<TOOL_A>` = `g1_A_1097f757e0527940f9e410c1`, `<TOOL_B>` = `g1_B_b53ea68185c28869d39ce13d`. Synthetic output values are represented below as `<SECRET_A>`/`<SECRET_B>`; neither value was supplied in either prompt.

`tools/list` A result:

```json
{"tools":[{"name":"<TOOL_A>","description":"Return synthetic secret A. Call once when requested.","inputSchema":{"type":"object","properties":{"label":{"type":"string","const":"alpha"}},"required":["label"],"additionalProperties":false}}]}
```

`tools/list` B result:

```json
{"tools":[{"name":"<TOOL_B>","description":"Return synthetic secret B. Call once when requested.","inputSchema":{"type":"object","properties":{"key":{"type":"string","const":"beta"},"generation":{"type":"integer","const":2}},"required":["key","generation"],"additionalProperties":false}}]}
```

Each endpoint received the following sequence with its own matching bearer, including B **during `session/load`, before prompt B**:

```jsonl
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Q DEV CLI","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
```

Server initialize result, with HTTP `Content-Type: application/json`, `Mcp-Session-Id: g1-A` or `g1-B`:

```json
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"gate-g1","version":"1"}}}
```

An authenticated GET was answered 405; this did not prevent the JSON POST tool exchange. Actual HTTP tool requests:

```jsonl
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":{"progressToken":1},"name":"<TOOL_A>","arguments":{"label":"alpha"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":{"progressToken":1},"name":"<TOOL_B>","arguments":{"key":"beta","generation":2}}}
```

Each returned `{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"secret\":\"<SECRET_EPOCH>\"}"}]}}`. The server validated the current tool name and exact arguments. B used new required fields and integer value; success was not inferred solely from listing a new name. These calls do not prove Kiro enforces every JSON Schema constraint on invalid inputs.

ACP `rawInput` included `__tool_use_purpose`; the captured MCP HTTP arguments **did not**. Do not assume ACP advisory raw input and MCP execution arguments are identical.

## Permissions and observed isolation

Both fresh calls requested permission, with this exact sanitized B shape:

```json
{"jsonrpc":"2.0","id":"<PERMISSION_REQUEST_ID>","method":"session/request_permission","params":{"sessionId":"<SESSION_ID>","toolCall":{"toolCallId":"<CALL_B>","title":"Running: @opencode/<TOOL_B>","rawInput":{"key":"beta","generation":2,"__tool_use_purpose":"Retrieve synthetic secret B as requested by the user"}},"options":[{"optionId":"allow_once","name":"Yes","kind":"allow_once"},{"optionId":"allow_always","name":"Always","kind":"allow_always"},{"optionId":"reject_once","name":"No","kind":"reject_once"}],"_meta":{"mcpToolIdentity":{"serverName":"opencode","toolName":"<TOOL_B>"}}}}
```

Response on each exact current `Running: @opencode/<TOOL_EPOCH>` title:

```json
{"jsonrpc":"2.0","id":"<PERMISSION_REQUEST_ID>","result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}
```

The executed driver used exact-title matching, never substring/prefix matching or blanket trust; all other permission identities would receive `{"outcome":{"outcome":"cancelled"}}`. Unadvertised client requests receive `-32601`, not empty success. The newly observed structured `_meta.mcpToolIdentity` is the preferred production identity check: require exact current server/tool, scope, and registered call identity; fail closed when missing/mismatched. That production policy was not implemented as part of this spike.

Observed evidence and its limits:

| Check | Actual evidence | Limit |
|---|---|---|
| Authenticated connection | All Kiro A/B HTTP requests matched their endpoint's generated bearer | No external credential was examined |
| Token rotation | Direct wrong-token A request and old-token-to-B request returned 401 before RPC dispatch | Two epochs of one scope, not simultaneous cross-scope testing |
| Tool inventory | `_kiro.dev/commands/available.tools` contained exactly the current tool, `source: "mcp:opencode"`; MCP inventory contained only `opencode`, toolCount 1 | Other slash commands/modes were still advertised; this is not complete surface elimination |
| Instructions | Prompt A returned the generated marker found only in scratch `AGENTS.md` | No changed-resource reread or inherited-context sentinel was tested |
| Built-ins | No shell/fs/terminal or unrelated-tool call/permission appeared; fs/terminal capabilities were false | Model said unavailable “per the instruction context”; no active forbidden-tool attempt was requested, so **refusal enforcement is unproven** |
| Permission isolation | Exactly two exact current opencode tool requests, both `allow_once` | Denial path was configured but not exercised by a live non-exact request |
| Inherited context | Config disables MCP JSON discovery and lists only the scratch resource; observed inventory has no inherited MCP tools | No exhaustive inspection/proof of absence of inherited instructions/resources |

## Replay versus fresh execution

During load, ACP first replayed user A, an empty agent chunk, A's `tool_call`, A's completed `tool_call_update`, and the prior answer. The replay used the original A call ID and bare A tool title, not a fresh permission request. Only afterward did endpoint B initialize/list and load return. Sanitized replay excerpt:

```jsonl
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<SESSION_ID>","update":{"sessionUpdate":"tool_call","toolCallId":"<CALL_A>","title":"<TOOL_A>","rawInput":{"label":"alpha","__tool_use_purpose":"Retrieve synthetic secret A as requested by the user"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<SESSION_ID>","update":{"sessionUpdate":"tool_call_update","toolCallId":"<CALL_A>","status":"completed","rawOutput":{"items":[{"Json":{"content":[{"type":"text","text":"{\"secret\":\"<SECRET_A>\"}"}]}}]}}}}
```

Driver evidence labels every event by `load-replay`, `A-prompt`, or `B-prompt`; it counts executions only at HTTP `tools/call`. **Zero HTTP calls occurred during replay; A executed once total, B once total.** A's listener remained open and received no stale load/prompt-B request. ACP tool replay must never create a fresh OpenCode tool gate.

Final B answer was exactly, with synthetic secrets substituted:

```text
**Secret B:** `<SECRET_B>`

**Secret A (previous):** `<SECRET_A>`
```

Both prompt results were `end_turn`. Native `turnDurationMs` was 5961 (A), 6144 (B). Metering arrays, in native credits, were A `[0.010776576915422886, 0.0077384523383084575]`, B `[0.012035691475953566, 0.007074523449419569]`. These are recorded credit values, not token counts or a dollar estimate.

## Cleanup, verification, and recommendation

Both owned child processes closed with zero captured stderr bytes; both sent authenticated MCP DELETE. Both listeners were closed and only this probe's scratch tree was removed. Exact `kiro-cli chat --delete-session <SESSION_ID>` exited 0 and printed `✔ Deleted chat session <SESSION_ID>` in private output. No unrelated session or original R1/R2/R3 artifact was deleted. The output's final `cleanup.success:false` was a **reporter error**: deletion confirmation was on stderr, but the driver searched returned stdout. The retained driver records successful command completion instead; the live probe was not repeated to fix a reporting boolean.

Verification performed:

- Final strict standalone TypeScript check passed (`--strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax`). Changed-file LSP reported no diagnostics before the cleanup-reporting edit; two final fresh-diagnostic requests timed out at 3000ms. Final LSP freshness is therefore unavailable; the compiler check covers the retained driver.
- Invocation without `KIRO_G1_LIVE=1` refused before scratch/process creation (expected assertion failure).
- One opt-in live invocation, exactly two prompts; all reattachment/result/schema assertions passed.
- Post-run exact PID check found neither owned launcher present. Native deletion was verified by its successful operation/confirmation, not by querying or sweeping session storage.
- Driver self-review: 176 nonblank/noncomment lines, one responsibility (G1 probe), JSON wire values narrowed at entry, no type assertions/non-null escapes, bounded protocol-method dispatch, exact registered tool/argument checks, and owned resource cleanup. Probe assertions check real HTTP calls/results rather than prompt prose. No production module, dependency, or logging framework was added.

**Recommendation:** enable native `session/load` reuse only after a completed/quiescent turn in the same validated OpenCode scope, preserving its scratch cwd. Regenerate endpoint/token/config before spawning; keep `mcpServers: []` on both new/load; wait for authenticated MCP initialization and a current tool inventory before prompting. Treat all load-time transcript events as replay. Rebuild from validated OpenCode history if load/reattachment/schema checks fail. Pending-tool resume, concurrent scopes, instruction changes while parked, cancel races, and notification-driven in-process schema refresh remain outside this G1 result.

Manual rerun (spends up to two prompts; **not needed for this completed check**):

```sh
KIRO_G1_LIVE=1 bun run spike/gate-g1.ts
```
