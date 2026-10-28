# G2 — installed OpenCode v1 auth, fetch and timeout gate

Date: 2026-10-22. **Disposition: G2 offline host integration PASS on installed OpenCode 1.19.1**, using the plan's explicit-registration fallback and the auth UX constraints below. The fixture-loading obstacle was a fixture syntax error, now fixed. Actual host discovery, explicit registration, custom fetch, scope headers, cancellation, errors and absent-usage accounting were exercised. Interactive terminal prompt behavior and long elapsed deadlines remain source-verified rather than interactively/long-duration exercised.

## Scope and evidence identity

- Plan read: `.omo/plans/kiro-implementation.md:64–72,125–148`, especially G2 at line 133 and the no-overwrite fallback at line 129.
- Installed executable: `~/.local/lib/node_modules/opencode-ai/bin/opencode.exe`, reached through `~/.local/bin/opencode`. Its isolated `--version` returned **1.19.1** (exit 0). Package metadata independently says 1.19.1 at `~/.local/lib/node_modules/opencode-ai/package.json:9`.
- Project-installed `@opencode-ai/plugin` and SDK are **1.19.4**, not 1.19.1: `node_modules/@opencode-ai/plugin/package.json:4,46`. Signatures below are from 1.19.4; runtime claims are from the actual 1.19.1 executable. No general compatibility claim for every OpenCode v1 release follows.
- Cursor prior art read in full: `../opencode-cursor-auth/src/plugin.ts`. Its file-based auth seeding (`87–103`) is prohibited here. Its headers (`132–136`), loader (`138–147`), and timeout defaults (`12–15,109`) were hypotheses checked against the installed runtime, not evidence by themselves.
- Cursor's `../opencode-cursor-auth/scripts/fresh-home-smoke.sh:14–25,31–56` was also read. Its `file://` built-entry pattern works; its real-provider setup/build/install/auth cleanup actions were not executed or copied. Frozen `src/contracts.ts` was read and left unchanged.
- No implementation or contract file was edited. No user auth/config/cache was inspected or written. All OpenCode process executions used a fresh private HOME/XDG/work directory and a non-inherited environment. No Kiro executable, real provider request, login/logout, or paid model call was used.

### Reading the runtime citations

The installed executable contains readable bundled JavaScript, not an installed unbundled TypeScript checkout. **B:L** below means the exact executable path above, raw newline number L, plus its embedded module and a searchable anchor. These are binary-file line numbers, not upstream TypeScript line numbers. Reproduce with `rg -a -n` or the bounded `g2-inspect.mjs` driver. Modules are minified, so anchors identify the relevant code within a long line.

| Ref | Exact installed runtime location and anchor |
| --- | --- |
| R1 | B:480954, `/$bunfs/root/src/index.js`, `E.type==="api"`, `E.authorize`, `Cli.providers.login` |
| R2 | B:481127, `/$bunfs/root/chunk-dts3qt22.js`, `ProviderAuth.authorize`, `L.type!=="oauth"` |
| R3 | B:486194, `/$bunfs/root/chunk-fb62d3j1.js`, API-method branch, `function bu(U)`, `d.client.auth.set` |
| R4 | B:482968, `/$bunfs/root/chunk-sm3jaw2b.js`, `C.auth.loader`, `Y.get(F)`, `function hQ(J)`, `function PY(J,Q,Y)` |
| R5 | B:481115, `/$bunfs/root/chunk-72rm6wjj.js`, `l0={auth:"/auth/:providerID"`, `authSet`, `authRemove` |
| R6 | B:481117, `/$bunfs/root/chunk-72rm6wjj.js`, `ProviderHttpApi.list`, `connected:Object.keys(z).filter` |
| R7 | B:482137, `/$bunfs/root/chunk-h7vvxs1g.js`, `plugin.trigger("chat.headers"`, `...e.model.headers,...b` |
| R8 | B:480718, `/$bunfs/root/chunk-ycp143x1.js`, `errorSchema:SG`, `function jG(G)`, error-field dispatch, `abortSignal:G.abortSignal`. Provider registry at B:482968 loads `chunk-jk0sk9ya.js`; its factory re-export at B:488398 points to this module. |
| R10 | B:483820, `/$bunfs/root/chunk-bysw579z.js`, `Q.usage.inputTokens??0`, `Q.usage.outputTokens??0` |
| R11 | B:485954, `/$bunfs/root/chunk-6tpwchdm.js`, `ProviderConfig`, `headerTimeout`, `chunkTimeout` |
| R12 | B:483786, `/$bunfs/root/chunk-032ydpr3.js`, `Plugin.state`, `Z.waitForDependencies`, `f.config?.(w)` |
| R13 | B:485815, `/$bunfs/root/chunk-say1qh3b.js`, `Npm.install`, `Npm.checkNodeModules`, `Npm.checkDirty` |

SDK/declaration paths below are relative to this repository's `node_modules/@opencode-ai/`.

## 1. API-shaped auth method: supported type, constrained UX

**Type-verified:** `plugin/dist/index.d.ts:62–125` supports an API method with text/select prompts and optional `authorize(inputs)`. Success returns `{type:"success", key, provider?, metadata?}`; failure returns `{type:"failed"}`. `PluginInput.client` is the v1 client (`36–38`), not a newly invented auth service.

**Source-verified CLI behavior (R1):**

1. Select provider/method, collect prompts into a string map, applying `when`/legacy `condition` and text `validate`.
2. For an API method, **unconditionally ask the additional non-empty “Enter your API key” prompt**, even when custom `authorize` exists.
3. Then invoke custom `authorize` with the **prompt map**, not the separately entered API-key value. If there is no custom function, save the entered key directly.
4. Custom failure does not save credentials. Custom success saves `result.key` (fallback to the entered key exists in runtime), with merged prompt/result metadata, using the host's auth setter. `result.provider` can redirect the destination.

**Source-verified TUI/HTTP difference (R2, R3):** `/connect` collects API prompts, then opens the ordinary API-key dialog and calls `client.auth.set` directly. It does **not** execute API custom `authorize`. The public provider OAuth authorize route returns immediately for a non-OAuth method. Therefore an API-shaped method is **not** a uniformly enforced CLI-checking UI across CLI/TUI/web. Prompt validation callbacks also are not serialized to the TUI in `ProviderAuth.methods`.

**Recommendation:** keep the plan's API-shaped method only as an explicitly documented **terminal CLI registration flow**: `kiro-cli login`, then `opencode auth login --provider kiro`, choose the CLI-login method, follow its prompt, and enter the non-secret `kiro-cli-managed` marker at the unavoidable API-key prompt. Custom `authorize` must check executable/version/identity before returning that same non-secret marker. Do not describe this as a prompt-free or TUI-verified login method. Request-side CLI checks remain mandatory because `/connect` can bypass `authorize`.

This is a recommendation from installed source, **not an exercised interactive CLI login result**. A key-free, identically validated CLI/TUI flow needs a separately agreed auth UX change; do not improvise browser/device-flow behavior or change the frozen contracts to obtain it.

## 2. Loader registration dependency and existing-auth safety

**Source-verified (R4):** the provider initialization loop checks an actual stored auth entry before calling an auth loader:

```text
if (!(yield* Y.get(F).pipe(z.orDie))) continue;
if (!C.auth.loader) continue;
C.auth.loader(() => ...Y.get(F)..., ...provider...)
```

An `auth` hook and configured models do not themselves register credentials. An environment/config API key may make a provider selectable, but does not satisfy this particular stored-auth guard. The config hook runs after external plugins load (R12) and can define models before an auth loader ever runs. A fresh install can expose provider metadata/auth methods without having its custom loader fetch installed.

**Host-exercised:** fresh discovery listed `g2fake/auto` and the API method, with one plugin initialization and zero loader calls. The test driver then deliberately called `PUT /auth/g2fake`, received `true`, called `POST /instance/dispose`, and requested providers again: the loader ran once and supplied the fake custom fetch. Registration therefore needs a reload/dispose boundary for an already-initialized provider instance. The fixture never calls `input.client.auth.set` during initialization. Before registration, `connected` already included `g2fake`, directly demonstrating why it cannot prove stored-auth presence.

**No public v1 credential-presence API was found:**

- `sdk/dist/gen/sdk.gen.d.ts:265–286` has `auth.set`; its other methods concern MCP auth. It has no provider-auth `get` or `list`.
- `sdk/dist/gen/sdk.gen.js:583–639` implements that setter as `PUT /auth/{id}`. `sdk/dist/v2/gen/sdk.gen.js:24–63` adds provider credential removal, not a credential read.
- The installed host route definition (R5) exposes PUT/DELETE for provider auth, not GET, and no conditional insert/set-if-absent operation.
- `client.provider.auth()` lists **methods**, not stored credentials (`sdk/dist/gen/sdk.gen.d.ts:216–225`; JS `480–500`).
- `client.provider.list().connected` is **not credential presence**: R6 includes a provider if it exists in the active provider map **or** the internal auth map. Config/env/custom providers are included. It is neither an authoritative per-entry existence test nor an atomic no-overwrite guard. Do not read returned provider keys/options as a substitute for an auth-presence API.
- The loader's `getAuth` closure is usable only after the host has already found auth. `ProviderHookContext.auth?` (`plugin/dist/index.d.ts:164–170`) likewise is not a startup insert-if-absent capability.

**Decision:** no startup `client.auth.set`, no auth-file probe, no sentinel seeding. Require explicit user registration through OpenCode's auth UI/CLI; the host owns the deliberate credential write. Preserve existing entries during startup and requests. An existing unsupported credential should produce an actionable message, not be silently replaced. Never fabricate `client.auth.get`.

The public SDK object's absence of `auth.get/list` was also **exercised offline in the earlier extracted-check run**, with a fetch implementation that throws if called. That particular check made no network/auth setter call. The later host check deliberately uses the public auth setter only in the test-owned fresh HOME.

## 3. Scope headers and custom fetch cancellation

**Type-verified:** `plugin/dist/index.d.ts:216–224` supplies `sessionID`, `agent: string`, model, provider and user message to `chat.headers`, with mutable `output.headers`.

**Source-verified (R7):** the host invokes `chat.headers` with `sessionID:e.sessionID` and `agent:e.agent.name`. Hook headers are spread after model/default headers. `x-opencode-session-id` exists by default, but the plan's distinct `x-opencode-session` and URI-encoded `x-opencode-agent` should be set explicitly for `kiro`. There is no default agent header to rely upon. These are per-request inputs, not a global “last session” variable.

**Source-verified (R8, R4):** the OpenAI-compatible adapter passes the model call's abort signal to its HTTP helper/custom fetch. The provider wrapper composes `init.signal` with header/chunk/optional full-request deadlines using `AbortSignal.any`. It passes the composed signal and Bun-specific `timeout:false` to the custom fetch. The signal object may differ from the original; observe its aborted state/reason, not identity.

**Host-exercised:** two independent host sessions using agents `build` and `plan` reached the fake custom fetch with the correct `x-opencode-session`, `x-opencode-agent`, and a real `init.signal`. After the fake fetch reported that it was pending, `POST /session/{id}/abort` caused that fetch's signal listener to receive `AbortError`; the pending host message request then settled. A filesystem event subscription observes readiness, with no timing sleeps. The earlier extracted-wrapper check separately proved propagation of the identical supplied abort reason and header/chunk deadline behavior. This does not prove ACP/MCP cancellation-race handling, which belongs to the transport/bridge owners.

Implementer: use `init?.signal ?? (input instanceof Request ? input.signal : undefined)`, merge/read Headers correctly, validate both scope headers, and distinguish successful tool-call response completion from actual cancellation. The host wrapper itself uses `init.signal`; Request-signal fallback is the plugin's interoperability responsibility.

## 4. OpenAI-compatible errors and absent usage

**Source-verified (R8), error schema exercised:** before response headers, return a non-2xx JSON response shaped as `{error:{message,type,code}}`; `message` is required, `type` optional/nullish, and `code` may be string/number/nullish. The adapter's error-to-message function extracts `error.message`. Bare `{message:...}` is not the intended compatible schema.

After SSE has begun, send a JSON **data payload** with that nested `error` object and terminate without a later successful finish. An `event: error` line alone is insufficient: the adapter dispatches on the parsed data object's `error` field, emits a provider error, and marks its finish reason `error`. Preserve AbortError rather than turning cancellation into a synthetic upstream-success response. Retry classification at the host is outside this check; never rely on a retry to rescue a paid ACP prompt.

**Host-exercised error distinction:** a fake HTTP 400 JSON error produced an assistant `APIError`, `data.statusCode:400`, `isRetryable:false`, the original message and response body. A fake SSE error payload produced an assistant **`UnknownError` whose `data.message` is the JSON string of the nested error object**, retaining its message/type/code inside that string. Both message HTTP requests completed with HTTP 200, but `info.error` was set and neither had a successful `stop` finish. Do not promise identical typed error metadata or plain-message formatting before and after headers, and do not treat the host message route's HTTP 200 alone as model success. Other retry classifications remain source-only/unexercised.

**Source-verified and extracted normalizer exercised (R8):** omitted/null `usage` is accepted in both completion/chunk schemas. The adapter emits undefined input/output totals and undefined raw usage when no usage object arrives. **An empty `{}` usage object is different: it produces zeros.** Omit usage entirely when Kiro supplies none; do not invent an empty or all-zero wire object.

**Host-exercised limit (also R10):** both successful fake SSE turns omitted usage entirely, returned the expected assistant text, and finished normally. Their final host counters were `input:0, output:0`, matching the host's `usage.inputTokens ?? 0`/`outputTokens ?? 0` accounting. Thus “absent usage preserved” is true at the compatible-adapter boundary, **not** a promise that OpenCode's final numeric session/UI counters distinguish unknown from zero. No token estimate is required to make the adapter accept the response. Document the host's zero-accounting limitation; credits/context percentage must remain separate from token/dollar claims.

## 5. Supported deadlines and the two-hour held-tool window

**Source/type-verified:** R11 and `sdk/dist/v2/gen/types.gen.d.ts:1380–1405` explicitly support provider `options.timeout`, `headerTimeout`, and `chunkTimeout`, each in milliseconds, each accepting `false`. The older v1 config declaration explicitly names only `timeout` but allows extra option keys (`sdk/dist/gen/types.gen.d.ts:925–945`); the installed runtime schema is decisive for the other two.

**Actual wrapper semantics (R4):**

- `headerTimeout` defaults to **300,000 ms**, starts before calling custom fetch and is cleared when its promise settles. `false` disables it. Custom fetch must honor the signal; the wrapper does not itself race a signal-ignoring fetch promise.
- `chunkTimeout` defaults to **300,000 ms**. It wraps responses with bodies whose content type contains `text/event-stream`, timing each pending reader read. Expiry aborts the composed signal, cancels the underlying body, and rejects with a response-stream timeout. It is not an MCP tool timer. `false` disables it.
- `timeout`, when numeric, adds `AbortSignal.timeout(timeout)` for the full fetch/body lifetime. `false` disables that extra timer. Clearing a header timer does not clear a configured full-request timer.
- Custom fetch receives `timeout:false`, disabling Bun's independent fetch timeout. The wrapper consumes/deletes header/chunk settings before creating the SDK provider.
- Normal EOF is not wrapper cancellation. Explicit cancellation of the wrapped SSE body aborts its chunk controller and cancels the underlying reader.

**Minimal recommendation:** in the plugin's in-memory provider defaults use `timeout:false`, `headerTimeout:7_260_000`, `chunkTimeout:7_260_000` (two hours plus a one-minute transport/cleanup margin), with documented user overrides. Keep the actual ACP/MCP two-hour deadline and bounded shutdown separately enforced. A pre-existing shorter user timeout must be reported/documented as reducing the supported window, not silently represented as two-hour support. No persisted user-config mutation is needed to supply plugin defaults.

The installed defaults already exceed 120 seconds but do not cover two hours. Cursor's thirty-minute value is also insufficient for the approved two-hour window. Settings are source-verified; a real 130-second host turn and a two-hour duration were **not** exercised here. Short extracted-wrapper checks exercise the same deadline mechanism, not elapsed long-tool integration.

## 6. Loading root cause and reproducible host evidence

Drivers were retained in the original macOS temp location (`opencode/`); checkout-relative evidence references use `../.qa/kiro/evidence/<name>/`:

- **Current minimal reproduction:** `g2-host.mjs` and `g2-fake-plugin.js`. The fake entry exports only `default`, typed against the installed `Plugin` declaration via checked JSDoc. It provides the fake model, scoped headers and fake fetch; it never accesses Kiro or external inference.
- `g2-host.mjs:10–25` creates fresh private HOME/XDG/config/cache/state/TMP/work paths and an explicit `file://.../g2-fake-plugin.js` config entry. It does not invent a lockfile or install packages. For this already-resolved JS entry, its config directory is made non-writable before spawning: the installed real `Npm.install` checks writability first and returns (R13). The external resolver, actual import, hook initialization and provider SDK path all execute normally. The fixture's only non-native runtime import is the already-installed project Zod module via absolute path; it needs no package installation. Directory permissions are restored after the host exits.
- `g2-host.mjs:28–38` obtains a unique OS-assigned loopback port, then passes that **nonzero** port to OpenCode. The CLI's `--port 0` had selected 4096 in these probes, so it is not used as an isolation guarantee. Model refresh, external skills, updates and default auth plugins are disabled; only `g2fake` is enabled. The process environment is constructed explicitly and inference never falls through to network fetch.
- **Root cause:** the old fake entry's nested `config.provider.g2fake.models` object lacked one closing brace. The actual loader rejected it with `Expected "}" but found ";"`. Plugin-load errors are published as bootstrap `session.error` events (R12); a normal instance `/event` subscription opens after bootstrap and missed them. Subscribing to **`/global/event` before the first instance request** exposed the parser error in run `g2-host-ufzOGn`. After the one-brace fix, a default-only entry initialized and discovered its model/auth method in `g2-host-OOhewk`. No plugin/export contract change was necessary. Both the explicit built-file URL and global `plugins/*.js` discovery were observed working after that fix.
- Earlier fake-lockfile experiments did not establish a loading contract. The obsolete `g2-runtime.mjs`/`g2-fixture` drivers were removed; the current reproduction follows the real source-verified non-writable-directory branch and does not use those experiments.
- `g2-inspect.mjs` and `g2-snippet-checks.mjs` retain the earlier source/extracted-check evidence. **The seven previously passing extracted checks were not rerun in this follow-up.** Their results remain distinct from the new real-host checks.

### Latest host run

Run command:

```sh
bun ../.qa/kiro/evidence/opencode/g2-host.mjs
```

Latest verified evidence root: **`g2-host-GbwiBU`** in the original macOS temp location (local-copy reference: `../.qa/kiro/evidence/g2-host-GbwiBU/`). The driver exited **0**. `evidence.json` stores seven host outcome records, structured trace and observed host events; `events.json` stores the event stream, and `host.log` stores host diagnostics. The fake modes are machine-consumed routing markers; checks do not pin natural-language prompt wording.

| Host outcome | Driver seam | Observed result |
| --- | --- | --- |
| Fresh default-only entry and discovery | `g2-host.mjs:83–92` | Model and API method listed; initialization count 1, loader count 0; `connected` includes fake despite no registration. |
| Public OAuth route does not run API custom authorize | `g2-host.mjs:93–96` | HTTP 200/null, zero custom-authorize calls. Interactive CLI prompts remain source-only. |
| Explicit test-owned auth registration | `g2-host.mjs:97–102` | PUT returns true; instance dispose/reload then executes the auth loader exactly once. |
| No-real-key fetch, scope and usage | `g2-host.mjs:119–131`; `g2-fake-plugin.js:18–60` | Two different session IDs, `build`/`plan` headers and `init.signal`; expected text; omitted wire usage accepted, final host tokens zero. |
| Non-2xx JSON error | `g2-host.mjs:133–155`; fake line 48 | Assistant `APIError`, statusCode 400, isRetryable false, original message; no successful stop. |
| SSE error | Same host range; fake line 49 | Assistant `UnknownError` with JSON-string message containing original error fields; no successful stop. |
| Actual host cancellation | `g2-host.mjs:104–118,155–158`; fake `37–46` | Event-driven readiness, host abort request, custom fetch gets AbortError, pending host request settles. |

The latest run included five fake chat requests (two successful scopes, two failures, one cancellation), one deliberate test auth PUT, and no real Kiro/model requests. `SIGTERM`, with bounded `SIGKILL` fallback, targets only the driver-owned child; the driver awaits exit. No broad process kill is used.

Both current JS files also passed the installed TypeScript compiler with `--allowJs --checkJs --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax`, ESNext/Bundler resolution, project-installed Node type roots and `--skipLibCheck` for dependencies. No TS drivers were written, so no TS-driver LSP target exists. The requested nonblank/non-comment measurement returned **165 LOC** for the host driver and **67 LOC** for the fake entry, both below 200.

### Concrete implementer handoff / remaining limits

1. **Accept explicit registration, no automatic sentinel seeding.** The safe public presence/conditional-set operation needed for startup seeding is absent. This follows the plan's explicit fallback and needs no auth-file exception.
2. **Keep the agreed API-shaped UX constraint:** CLI custom API authorize requires an additional key prompt; TUI bypasses that authorize. Document CLI registration with the non-secret marker and enforce request-side CLI identity checks. The HTTP bypass is exercised; terminal prompt sequencing and TUI keystrokes are source-verified, not interactively exercised here.
3. **Host integration obstacle resolved; no frozen-contract correction.** Set both scope headers in `chat.headers`, consume `init.signal` in custom fetch, reload after deliberate registration, and retain the pre-header/SSE error distinction plus unknown-usage limitation above. These facts were relayed to the orchestrator during the run.
4. **Remaining limits:** elapsed >120-second/two-hour host calls, live Kiro identity/login, ACP/MCP tool continuation/cancellation races, and full UI rendering are not claimed by this short offline gate. Timeout settings/semantics are source-verified as described above; other transport/live gates remain with their owners. No irreducible G2 host-loading blocker remains.

No changes to `src/contracts.ts`, implementation sources, the approved plan, or the user's configuration are part of this report.
