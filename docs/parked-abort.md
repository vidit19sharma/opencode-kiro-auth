# Parked native tool abort: offline regression

## Root cause and fix

A tool-call HTTP response completes before OpenCode executes the tool. Its request
abort listener must detach at segment completion: aborting that completed request
does not establish that the host turn was cancelled. Previously, however, the
subsequent host idle event also preserved the running native generation, leaving
its MCP call parked and rejecting the next user message with HTTP 409.

`src/bridge.ts` now abandons a running generation when OpenCode reports session
idle and no HTTP segment or request setup is active. The existing stop path
invalidates generation callbacks, releases MCP gates, aborts/cancels ACP, waits
for cancellation quiescence, and closes the owned client/endpoint. Repeated idle
events do not cancel twice. Plugin event dispatch and lifetime contracts are
unchanged.

A matching held-history prefix followed by fresh user input can also replace
the abandoned generation before idle arrives. It reconstructs a new native
generation rather than settling old gates. Tool-only mismatches, duplicate
results, and foreign-scope results still return 409. Normal held-tool continuation
still uses one native prompt; completing a tool segment alone still does not
cancel that prompt. The deadline test now sends the busy event named by its
scenario; the new regression separately requires idle to release parked work.

## Reproduction and verification

All paths below are relative to the checkout parent (`../`).
Commands ran in `opencode-kiro-auth/` with
`TMPDIR=../.qa/kiro/parked-abort/tmp`.

| Gate | Evidence | Result |
| --- | --- | --- |
| RED packed host | `.qa/kiro/parked-abort/red-package.log`; `.qa/kiro/kiro-package-U9zyFd/events.json` | Real host tool starts, then reports `MessageAbortedError` and `Tool execution aborted`; idle occurs but no native cancel/release/exit within 3 seconds, before cleanup disposal. |
| RED bridge | `.qa/kiro/parked-abort/red-bridge.log` | Both new abandonment/recovery cases fail before the fix. |
| Focused bridge | `.qa/kiro/parked-abort/green-bridge.log` | 38 pass, 0 fail (100 assertions at that run). |
| Build | `.qa/kiro/parked-abort/build.log` | `bun run build` passes. |
| Full typecheck | `.qa/kiro/parked-abort/typecheck.log` | `bun run typecheck` passes, including test/script types. |
| Complete offline suite | `.qa/kiro/parked-abort/offline.log` | `bun run test`: 149 Bun tests pass, 0 fail; CLI setup suite reports ALL PASS. Final bridge suite has 102 assertions. |
| Final packed OpenCode 1.19.1 | `.qa/kiro/parked-abort/green-package-final.log`; `.qa/kiro/kiro-package-vvjGRK/evidence.json` | All 9 checks pass. |

The packed regression installs the real tarball and uses a fake Kiro executable
over real ACP and authenticated HTTP MCP. A test-owned host custom tool blocks
until its host cancellation signal aborts. It is overridden before the first
instance/provider bootstrap. The test checks the host's actual tool error and
assistant error, **one ACP cancellation**, **one MCP gate release**, and owned
child termination **before sending the next message in the same session/agent**.
That next message succeeds without disposal as repair. Evidence records two
prompts across the aborted turn and recovered turn. Final disposal separately
checks all eight owned ACP processes, scratch directories, and listener cleanup.

## Scope and remaining limitation

No paid/native inference was run. No authentication, user configuration, session
stores, dependencies, or worker-owned QA helper/runner files were changed.
Diagnostics report no errors in the four changed TypeScript files.

The nonblocking approximate reconstruction limitation for changed held
instructions/schema with a tool-result-only suffix remains outside this fix.
Fresh-user replacement requires the matching held-history prefix; arbitrary
tool-only continuations are not accepted as recovery.

The production change is confined to the existing bridge lifecycle state machine.
Its inherited file size exceeds the programming size guideline (342 pure LOC);
the existing bridge test suite is 440 pure LOC. Broad splitting was deliberately
excluded from this single-blocker change. The package harness and executable
fixture remain 173 and 107 pure LOC respectively. Review found no new escape
hatches, boundary parsing changes, parameter abstractions, defensive wrappers,
or logging changes.
