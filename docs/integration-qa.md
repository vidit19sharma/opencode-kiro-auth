# Packaging and integration QA

## Final disposition

**Current-tree offline/packed QA passed; native acceptance passed before the final cancellation-only fix. Final independent delta review completed: APPROVE, high confidence, no blocking findings.** The native run forwarded exactly two Haiku 4.5 ACP prompts, proving real exact-secret tool continuation within the same prompt, then remembered code after a quiescent schema change/native reload, with owned cleanup. It was not rerun after the fix. Historical native prompt total remains **5: two G1 research + one earlier failed acceptance + two successful acceptance**. No publication or vendor approval is claimed; historical budgets below do not authorize new calls.

The independent review recorded a fresh full typecheck exit 0, 149 Bun tests plus CLI checks passing, nine packed-host checks passing, clean reviewed LSP diagnostics, and `dist` matching the packed build. Retained reviewer evidence: [offline log](../../.qa/kiro/parked-abort/reviewer-offline.log), [package log](../../.qa/kiro/parked-abort/reviewer-package.log), and [final packed artifact](../../.qa/kiro/kiro-package-y23d97/evidence.json). The final artifact records one ACP cancel, one gate release, same-scope recovery without disposal, and all eight owned resource records cleaned up. Earlier evidence below remains preserved for provenance.

| Current local evidence | Result |
| --- | --- |
| [Native two-prompt artifact](../../.qa/kiro/evidence/kiro-live-zGo9Of/evidence.json) | Pre-fix native continuation/reload and cleanup proof, not current-tree native cancellation proof. |
| [Current offline log](../../.qa/kiro/parked-abort/offline.log) | 149 Bun tests pass, 0 fail, across isolated processes; CLI checks report ALL PASS. |
| [Current packed artifact](../../.qa/kiro/kiro-package-vvjGRK/evidence.json) | Nine checks pass on real OpenCode 1.19.1 with fake Kiro over actual ACP/authenticated HTTP MCP. Parked host-tool abort produces one ACP cancel, one gate release and child exit before the next same-scope message succeeds, without disposal as repair. Final disposal separately verifies all eight owned children/scratch/listeners. |

See [parked-abort.md](parked-abort.md) for the corrected cancellation gate and RED/GREEN evidence. QA defaults to the checkout parent's `.qa/kiro/` (`auth_setup/.qa/kiro/` here); `KIRO_QA_ARTIFACTS` overrides the parent artifact base, not the individual run root or runtime `TMPDIR`. [QA-EVIDENCE.md](../QA-EVIDENCE.md) indexes preserved historical copies. The remaining sections retain the earlier acceptance chronology; their counts and “latest” labels are historical, superseded by the current-tree evidence above.

## Reproduce offline

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run test
bun run test:package
```

The latest sequential `build → typecheck → test → test:package` chain exited zero; dependency installation was not rerun or changed in this follow-up. Bun is 1.4.2; the host is pinned dev-only OpenCode 1.19.1 (the local run uses Node 26.11.1; CI selects Node 22). Zod 4.1.8 is a direct dev-only dependency. Offline inference children use explicit fake CLI paths, fresh HOME/XDG/TMP and blocked external registries/proxies.

**Retained latest gate log:** original macOS temp location, `kiro-acceptance-iEddgS/offline.log` (local copy: `../.qa/kiro/evidence/kiro-acceptance-iEddgS/offline.log`).

| Offline gate | Result |
| --- | --- |
| Build / source and test typecheck | PASS; existing installed dependencies |
| Models / plugin / bridge / ACP / MCP | **13 / 30 / 36 / 23 / 29 PASS**, distinct Bun processes; 131 total |
| Existing CLI setup/update tests | ALL PASS |
| Built default-only entry | 1 PASS |
| Real built bridge → ACP child → HTTP MCP | 1 PASS: text, exact tool permission, secret-result continuation over two HTTP segments/one ACP prompt, errors, abort, owned cleanup |
| Offline native-driver regressions | **12 PASS**: guard, version/catalog failures, two-prompt simulation, semantic-failure stop, saved-refusal replay, four before/after cleanup cases, wrong-secret with CLI directories, third-prompt block |
| Actual tarball and unpacked public entry/CLI | PASS |
| Actual packed host with auth absent | PASS: catalog discovery; no automatic auth write or ACP prompt; actionable registration error through config fetch |
| Public auth setter in fresh test HOME, dispose/reload | PASS; non-secret marker preserved |
| Two host session/agent scopes | PASS |
| Host custom-tool/result roundtrip | PASS: completed `qa_probe` part/result in session history; expected final text; exactly one ACP prompt |
| Host pre-header/post-header errors and abort | PASS: assistant errors without successful stop; actual ACP cancel and terminal metadata |
| Host cleanup and data preservation | PASS: six observed scratch/PID/listener records all gone; registered marker and unrelated user-data fixture preserved |

The isolated offline command now includes `spike/live-smoke.test.ts`, so CI's existing `bun run test` also exercises it in its own process. The fake CLI implements version, first-line JSON identity with a non-JSON footer, model catalog and ACP v2, and connects to actual authenticated HTTP MCP. Integration does not replace the plugin/bridge/ACP/MCP modules. The packed driver compares dry-run and real tarball file lists, extracts the tarball, and loads that exact unpacked `dist/index.js` using G2's non-writable-config installation branch. No fake lockfile or package publication is involved.

## Historical packed-host artifact and bounded disposal

**Latest passing artifact root:** original macOS temp location, `kiro-package-9rVoJE/` (local copy: `../.qa/kiro/evidence/kiro-package-9rVoJE/`).

It retains the tarball/unpacked package, `evidence.json`, `events.json`, `trace.jsonl` and `host.log`. All eight scenario records are present and the driver exited zero. `evidence.json.disposal` records:

- HTTP dispose response: **6.499208 ms** from request start.
- Full observed cleanup convergence: **59.822416 ms** from request start, after three observations.
- All six observed children: `scratchGone`, `processGone`, `listenerGone` are true.
- Assertions ran while the host was still running; the harness did not remove product scratch or terminate the host to obtain the verdict.

The earlier immediate cleanup assertion was incorrect for this host's asynchronous disposal contract. Source-owner ordering evidence in the original macOS temp location, `kiro-package-Aab2rI/disposal-ordering.json` (local-copy reference: `../.qa/kiro/evidence/kiro-package-Aab2rI/`), shows a 1.45 ms response followed by completion observed at 505 ms; its `host.log` proves hook invocation. Production remained unchanged. The harness now checks the existing criteria repeatedly for **at most five seconds**, rather than sleeping a fixed duration. It preserves every scratch, exact PID, listener, auth-marker and unrelated-fixture assertion, records timing/convergence, and fails the gate on expiry.

The earlier passing artifact `kiro-package-no1W8j` and previous failure artifacts (`kiro-package-uvnIzC`, `kiro-package-jsQSS3`, `kiro-package-G5Vc94`) remain untouched. Two other harness corrections remain explicit: completed host tool parts are queried in session history rather than only the final assistant reply; the terminal error fixture uses 401 because the actual host retries 502, including after SSE begins. This run does not claim retryable errors are terminal or free from repeated native prompts. The prior `headersDistinct` compatibility issue and plugin fixture typing error are resolved and covered by the current passing gates.

## First acceptance invocation — failed (historical)

After all offline gates passed, exactly this guarded invocation ran once:

```sh
KIRO_LIVE=1 KIRO_CLI=/opt/homebrew/bin/kiro-cli bun run test:live
```

The driver itself verified CLI **2.33.1** and catalog membership of **claude-haiku-4.5**, then used the real built bridge/ACP/MCP. Authentication stayed delegated to the official CLI's existing login; no private credentials/config or identity were read or logged by QA.

**Native artifact root:** original macOS temp location, `kiro-live-6N4BWF/` (local-copy reference: `../.qa/kiro/evidence/kiro-live-6N4BWF/`).

- Process exit: **1**, `status: failed`, `stage: secret-tool`, `failure: AssertionError`.
- **Actual forwarded ACP prompts: 1; reserved prompt slots: 1.** The trace contains one session creation and one `session/prompt`, no load and no second prompt. Run-owned native session ID is retained only in the private `evidence.json.nativeSessions`/trace, not reproduced here.
- The first semantic scenario did not pass; `checks` is empty. Therefore neither a successful native held-tool/secret-result loop nor native memory/schema reload is claimed.
- The original payload-free evidence alone could not distinguish the failed assertion. Subsequent offline reading of only its retained test-owned session settled the prompt-boundary refusal; see `docs/native-failure.md`. No paid diagnostic probe was used.
- The original driver evidence conservatively reports `cleanup.completed: false`: bridge scratch, tracked PIDs and listener were already gone, but CLI-created `kiro-cli-updates-501` and `kiro-log` entries remained in the run-owned temp root before the driver's final `rmSync` of that root. That field has not been rewritten to PASS.
- Independent post-run observation confirmed all four recorded PIDs absent, the exact shim process group absent, loopback listener connection refused, and the temp root/bridge scratch absent. Immediately after driver exit, the retained root contained only `evidence.json`, `trace.jsonl`, and the empty `prompt-1` claim. Supplemental observations were then saved as `post-run-verification.json`.

No native session deletion, login/logout, user config change, broad process kill, dependency upgrade, git write or publication occurred. That invocation's unspent second prompt was not used. Earlier G1's two research prompts remain separate prior evidence and were not rerun.

## Fresh authorized acceptance — passed

After the latest full offline and packaged chain passed, the same guarded command
shown above was executed **once**, under fresh authorization for at most two
additional prompts. It exited **0** without a retry or any other native probe.

**Native artifact root:** original macOS temp location, `kiro-live-zGo9Of/` (local copy: `../.qa/kiro/evidence/kiro-live-zGo9Of/`).

**Invocation log and gate summary:** original macOS temp location, `kiro-acceptance-iEddgS/` (local copy: `../.qa/kiro/evidence/kiro-acceptance-iEddgS/`).

| Native acceptance fact | Saved result |
| --- | --- |
| CLI / model | `kiro-cli 2.33.1` / `claude-haiku-4.5` |
| Status / final checkpoint | `passed` / `memory.native-load`; empty failure field |
| Forwarded / reserved ACP prompts | **2 / 2**; both claim files retained; no third prompt |
| First segment | HTTP 200, `tool_calls`, exactly one call, exact argument assertion passed |
| Secret continuation | HTTP 200, `stop`, zero further calls, 32-character exact result matched; still one actual ACP prompt |
| Changed-schema memory | HTTP 200, `stop`, zero calls, 16-character exact memory matched; exactly two prompts total |
| Native reload | One `session/new`, one later `session/load`, both prompt events and load refer to the same native session |
| Session deletion | Not attempted; session ID remains in the private evidence/trace only |

Before removing any driver temp data, the driver observed **all six tracked PIDs,
both exact shim process groups, the bridge scratch directory, and the loopback
listener absent**. `cleanup.productCompleted` and
`cleanup.resourcesObservedBeforeDriverRemoval` are true. No unclassified residue
was observed. The raw `cleanup.beforeRemovalCompleted` remains **false**, and its
two `remaining-scratch` observations remain `removed: false`, because the CLI had
created `kiro-log` and `kiro-cli-updates-501` in the driver's own temp root.

After scoped driver removal, `cleanup.driverResources` records both CLI
directories, the driver temp root, and its shim absent. Only then are
`cleanup.driverTemporaryRemoval` and `cleanup.completed` true. A post-run directory
read showed only `evidence.json`, `trace.jsonl`, `prompt-1`, and `prompt-2` retained.
This verdict uses actual before/after checks; it does not rewrite the earlier
failure artifact or treat driver deletion as proof of product cleanup.

The focused cleanup regression first failed with the old driver (exit 1 instead
of the expected success for known CLI directories). After correction, the tests
prove an unknown leftover, a regular file named `kiro-log`, and a recorded live
PID still fail even when the driver removes its temp root. Wrong-secret failure
also remains failed after verified successful cleanup. The production resource
and semantic criteria were not relaxed.

| Historical native prompt ledger | Count |
| --- | --- |
| Prior G1 research | 2 |
| Prior failed acceptance | 1 |
| This fresh acceptance authorization | 2 |
| Image input check (CLI 2.34.2, Haiku 4.5; see [image-input.md](image-input.md)) | 1 |
| **Cumulative actual native prompts** | **6** |

The latest LSP diagnostic for `scripts/live-smoke.ts` was clean. The diagnostics
tool timed out for the driver test file; its full TypeScript check and all 12
driver tests passed. No production edits, dependencies, credentials/config
inspection, login/logout, session deletion, git writes, or publication occurred
in this follow-up. No long-duration native rerun was performed; this gate does
not add new evidence for elapsed two-hour behavior. Final review/release remains
outside this acceptance result.
