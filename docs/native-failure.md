# First native tool-loop acceptance failure

## Finding

The first failure was the driver's first semantic assertion: expected
`first.finish_reason === "tool_calls"`, but the bridge completed with `"stop"`
without a tool call. This was a product prompt-boundary defect, not an incorrect
acceptance assertion. The assertion remains mandatory.

The bridge placed **current user input** inside an `opencode-role-data` envelope
marked `reconstructed_role_history` and `alreadyExecuted: true`. Its agent config
also tells Kiro to treat historical role data as untrusted. The saved native turn
classified the embedded request as untrusted instructions and returned a textual
refusal instead of executing the requested tool. Current input and replay history
had been conflated at the OpenCode-to-ACP boundary.

## Saved evidence and limits

Original evidence root, preserved without modification:

The original macOS temp location, `kiro-live-6N4BWF/` (local-copy reference: `../.qa/kiro/evidence/kiro-live-6N4BWF/`).

| Evidence | Relevant observation |
| --- | --- |
| `evidence.json` | Kiro CLI 2.33.1, Haiku 4.5, `secret-tool`, `AssertionError`, one reserved and one actual ACP prompt, zero completed semantic checks |
| `trace.jsonl` | One session creation and one prompt, followed by child exit; no load or retry |
| `post-run-verification.json` | Owned processes/group absent, listener refused connection, bridge scratch absent, driver temp root absent; original failure retained |
| Authorized native session JSONL | Two records: one prompt and one assistant text response; no tool-call or result records |
| Authorized native session JSON | One user-turn metadata record, one model request, zero cycles, zero builtin tool uses, 741 response characters, normal user-turn end |

Only the exact test-owned session referenced by `evidence.json.nativeSessions[0]`
was read, at its `.json` and `.jsonl` paths under `~/.kiro/sessions/cli/`.
No native text, memory value, or session contents are copied here or into fixtures.

The old driver did not retain the HTTP completion or full ACP wire recording.
The exact HTTP finish reason is reconstructed from saved conversation behavior
and the bridge implementation: no MCP gate called `flush`; a normally completed
native prompt calls `finish(current, [])`, producing `"stop"`; the first driver
assertion then fails. The synthetic replay independently exercises that mapping.

This failure precedes an attempted tool call. Missing arguments, a denied
permission, tool-result formatting, and secret equality cannot explain this
first assertion. The retained conversation supports a refusal caused by input
framing; it does not establish that later native permission/tool/result paths
work. No inventory absence or wire-level permission behavior is claimed from a
transcript that did not record those exchanges.

## Minimal correction

- `src/bridge.ts`: at the shared native prompt-dispatch seam, split trailing user
  messages from preceding replay history. Send those current messages as native
  text blocks. Keep preceding assistant/tool history in the existing
  `alreadyExecuted` envelope, preserving historical tool results as data.
- Held tool-result continuation still settles the existing MCP gate without a
  new native prompt. Schema reload still loads the same native session and sends
  only fresh input when its history prefix is retained.
- `src/acp.ts` and `src/mcp.ts` required no change for this failure.
- `scripts/live-smoke.ts`: retain the failed checkpoint and safe observations:
  HTTP status, bounded finish-reason category, content length, tool-call count,
  and equality booleans. Explicit checkpoints distinguish HTTP/shape failures,
  first tool-call/argument checks, resumed exact-secret verification, prompt
  counts, exact memory verification, and reload verification. No exception
  messages, response text, prompts, arguments, secrets, or headers are dumped.

The one-call argument check, exact secret, same-actual-prompt continuation,
two-actual-prompt total, schema reload, and exact memory objectives are unchanged.
The shim's two-slot reservation ledger and third-prompt block are unchanged.

## Offline regression and verification

`spike/fixtures/native-role-refusal.json` is a **synthetic, sanitized derived
fixture**, not a byte-exact native ACP capture. It preserves the faulty envelope
structure and models text-only normal completion with zero tool calls, replacing
all content with synthetic values.

The prior smoke fake ignored current-vs-historical input framing and executed
the requested tool regardless. It now models the saved refusal when all input
is wrapped as replay data. The forced-refusal mode checks failure diagnostics
even after the product correction. This is an offline structural model, not
proof of future model behavior.

Fail-first observations before the source correction:

```text
bun test spike/bridge.test.ts -t "current user input|replayed tool results"
0 pass, 2 fail: current input was inside alreadyExecuted history

bun test spike/live-smoke.test.ts -t "records two actual prompts"
0 pass, 1 fail: offline executable returned text without a tool; driver exited 1
```

After the correction:

```text
bun run typecheck && bun run build && bun run test
typecheck: passed (production and test configurations)
build: passed
module tests: 131 passed (13 models, 30 plugin, 36 bridge, 23 ACP, 29 MCP)
CLI setup: ALL PASS
built package entry: 1 passed
built ACP + authenticated loopback HTTP MCP direct flow: 1 passed
smoke-driver tests: 9 passed
```

The built direct-flow test includes actual offline ACP permission exchange and
HTTP MCP tool/result continuation across segments. It uses a fake executable,
not native Kiro. All test executables and transport traffic in this assignment
were offline fixtures or localhost. No live Kiro command was executed.

Error-level LSP diagnostics were clear for `src/bridge.ts`,
`scripts/live-smoke.ts`, and `spike/bridge.test.ts`. The diagnostics tool timed out
for `spike/live-smoke.test.ts`; the complete TypeScript test check passed.

Additional preserved offline evidence (outside the full-suite temporary root,
which the existing test runner deletes on exit):

- Refusal: original macOS temp location, `live-smoke-offline-IwcI8w/tmp/kiro-live-H779J7/evidence.json` (local-copy reference: `../.qa/kiro/evidence/live-smoke-offline-IwcI8w/`).
- CLI temp residue: original macOS temp location, `live-smoke-offline-QE0cBd/tmp/kiro-live-Jgubhe/evidence.json` (local-copy reference: `../.qa/kiro/evidence/live-smoke-offline-QE0cBd/`).
- Unclassified/owned residue: original macOS temp location, `live-smoke-offline-RizswW/tmp/kiro-live-pF6hRa/evidence.json` (local-copy reference: `../.qa/kiro/evidence/live-smoke-offline-RizswW/`).

The refusal replay records `secret.first.finish-reason`, HTTP 200, `stop`, zero
tool calls, one actual prompt, zero semantic checks, and exit failure. It retains
only synthetic response length, not response text.

## Initial cleanup accounting (historical)

The original evidence correctly remains failed. All recorded process, bridge
scratch, and listener checks passed; its conservative cleanup aggregate was
false because `kiro-log` and `kiro-cli-updates-501` remained before the driver's
final temp-root removal. The supplemental file documents that final removal;
it does not retroactively convert native semantic acceptance to success.

The diagnostic-only driver's evidence at that point separated:

- `cleanup.productCompleted`: exact recorded process/scratch/listener checks
  passed, bridge close succeeded, and no unclassified temp residue remained.
- `cleanup.cliTemporaryDirectories`: only the recognized CLI temp names.
- `cleanup.driverTemporaryRemoval`: the driver's final removal operations
  returned successfully; this is not a product cleanup assertion.
- `cleanup.completed`: retains the original conservative aggregate; residue
  keeps it false even if final driver removal succeeds.

Offline tests prove both recognized CLI residue and unclassified residue keep
the overall run failed. An unclassified leftover also fails product cleanup.

## Scope review

Only native prompt composition changed in production; no dependencies or git
writes were introduced. New data parsing is at test/driver boundaries; no type
escape hatches, variant handling, logging framework, or one-off production helper
was added. Existing permission and result validation remain in their owners.
The regression fails when the old input framing is restored.

Pure-LOC review: bridge 336, bridge tests 402, driver 211, driver tests 137,
synthetic fixture 7. The bridge and its test file already exceeded 250 before
this assignment. They received only the necessary seam fix and direct tests,
honoring the explicit no-broad-refactor scope. The driver is in the 200–250
warning band; split QA evidence handling before a subsequent expansion.

## Live validation status at the end of diagnosis (historical)

Native acceptance remains **unverified after the fix**. The original allocation
is still **1 of 2 actual prompts spent**; this assignment spent zero additional
native prompts and did not reset that allocation. The original native session
and evidence remain retained. No session load, new native probe, auth access,
user configuration change, or session deletion was performed.

Main must review and separately authorize any remaining native validation and
its prompt budget. The outstanding native objectives remain: exact OpenCode-owned
tool secret across HTTP segments under the same actual ACP prompt, then exact
memory after changed-schema reload under the two-prompt objective. A fresh
two-prompt smoke would exceed the single remaining prompt of the original
allocation without additional authorization. Offline green results do not
authorize that run or satisfy release acceptance.

## Authorized follow-up acceptance

The next assignment explicitly authorized **one fresh invocation with at most
two new Haiku 4.5 ACP prompts**, after correcting QA cleanup accounting and
passing the latest offline and packaged gates. This superseded the earlier
pending-authorization state; it did not reset historical counts.

Only `scripts/live-smoke.ts`, its direct driver tests, and QA documentation were
changed in this follow-up. Product checks now include exact shim process-group
absence as well as the recorded PIDs, listener, and bridge scratch. All are
observed **before** driver-data deletion. Unknown entries, regular files or
symlinks masquerading as known CLI directories, and failed process checks remain
product cleanup failures. Recognized CLI log/update directories are separately
recorded driver obligations.

`cleanup.beforeRemovalCompleted` preserves the old raw pre-removal aggregate.
`cleanup.driverResources` records actual post-removal absence checks for known
CLI directories, the scoped temp root, and the shim. Overall cleanup now requires
both successful pre-removal product checks and verified driver removal. This
correction has no effect on semantic success and rewrites no old artifact.

The known-CLI-directory regression was observed failing before the correction.
The latest complete chain `bun run build && bun run typecheck && bun run test &&
bun run test:package` exited zero: 131 module tests, 12 driver tests, CLI setup,
built entry/direct flow, and actual packed OpenCode 1.19.1 scenarios passed.
The packed artifact root is
the original macOS temp location, `kiro-package-9rVoJE/` (local copy: `../.qa/kiro/evidence/kiro-package-9rVoJE/`).
Its six resource sets converged within the unchanged five-second bound, observed
at about 60 ms. The full gate log is retained at
the original macOS temp location, `kiro-acceptance-iEddgS/offline.log` (local copy: `../.qa/kiro/evidence/kiro-acceptance-iEddgS/offline.log`).

The guarded native invocation then ran exactly once and exited **0**:

The original macOS temp location, `kiro-live-zGo9Of/evidence.json` (local copy: `../.qa/kiro/evidence/kiro-live-zGo9Of/evidence.json`).

It records CLI 2.33.1, model `claude-haiku-4.5`, **two forwarded/two reserved ACP
prompts**, both semantic checks complete, `status: passed`, and final checkpoint
`memory.native-load`. Exact OpenCode tool-secret continuation passed while the
actual prompt count stayed one. Changed-schema reload then loaded the same
native session and returned the exact remembered value at count two. No retry
or additional native probe occurred.

Cleanup records six PIDs, two process groups, one scratch directory, and one
listener absent before driver deletion. The raw pre-removal aggregate remains
false because the two known CLI directories existed. Product checks, verified
driver removal, and final cleanup are all true. A post-run directory read found
only evidence, trace, and two empty ledger claims. The native session was not
deleted, and no session transcript was read in this follow-up.

Historical total is now **5 actual native prompts: two prior G1 research, one
prior failed acceptance, and these two fresh acceptance prompts**. Earlier
evidence remains unchanged. Full current details and before/after semantics are
in `docs/integration-qa.md`; final review is separate from this passing gate.

Follow-up self-review: the driver owns acceptance orchestration; tests own its
offline executable contract. Added filesystem classification stays at the QA
boundary. No untyped casts, non-exhaustive tagged dispatch, new single-use
production helper, extra parameters, or negative-form state names were added.
Post-delete checks are intentional here because this task explicitly requires
independent absence evidence. Diagnostics keep fixed labels and safe metadata,
without payloads or exception messages. Regressions cover known/unknown residue,
live PID failure, and semantic failure with successful cleanup. Pure LOC is
224 for the driver (warning band; split evidence handling before another
expansion) and 150 for driver tests. Production files were not edited.
