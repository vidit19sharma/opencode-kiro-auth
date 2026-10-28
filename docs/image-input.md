# Image input (offline-verified; one native prompt verified)

PNG/JPEG/GIF/WebP base64 data attachments are supported by the bridge, verified
offline with packed OpenCode 1.19.1 + fake Kiro, then with **one** authorized native
prompt: Kiro CLI 2.34.2, ACP v2, `claude-haiku-4.5`, the deterministic 1x1 red PNG,
HTTP 200 / `stop`, answer `red`, ~10 s, bridge scratch cleaned. The documented CLI
baseline remains 2.33.1; this check does not establish broader version or per-model
vision compatibility. Independent delta review: APPROVE after two fixed blockers
(pre-decode size caps; capability guard before `session/new`).

## Wire formats and sources

- [ACP schema](https://agentclientprotocol.com/protocol/schema),
  [image content](https://agentclientprotocol.com/protocol/content):
  `{ type: "image", data: "<base64>", mimeType: "image/png" }`; `uri` is optional
  and is not emitted. Images accompany text in the existing `session/prompt`.
- [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization):
  require `agentCapabilities.promptCapabilities.image === true`; missing or false
  means unsupported. The client exposes this as readonly `capabilities.image`.
- [Kiro v2 ACP](https://kiro.dev/docs/cli/acp) documents that initialize shape and
  advertises image prompts agent-wide. This is not per-model vision evidence;
  Kiro's catalog does not report per-model vision.
- [Kiro v3 migration](https://kiro.dev/docs/cli/v3/acp-migration) requires capability
  negotiation and describes sending ACP image blocks. It does not prove v2 model
  behavior; this plugin still selects `--agent-engine v2`.
- Empirical host probe: `POST /session/<id>/message` with text + a `file` part
  (`mime`, `filename`, `url: "data:image/png;base64,<payload>"`) becomes
  `{ type: "image_url", image_url: { url: "data:image/png;base64,<payload>" } }`
  at bridge parse. Probe logs contain only part types/keys; instrumentation removed.

## Limits and failure modes

- User messages only; PNG/JPEG/GIF/WebP MIME allowlist, strict canonical base64.
  Invalid encoding, MIME or placement returns HTTP 400; nothing is silently dropped.
- Maximum decoded size: **5 MiB/image**, **10 MiB/request**, including supplied history.
  Both caps are enforced before decoding; cap errors name the cap. No external URLs are fetched:
  `External image URLs are not fetched; attach the image instead` (HTTP 400).
- Missing/false initialize image capability returns HTTP 400:
  `This Kiro CLI/engine does not advertise image input`, before cold `session/new` or any prompt.
- Ordered current-user parts become native blocks. Stored history contains only
  `{ type: "image_omitted", mimeType, bytes, sha256 }` descriptors alongside text.
  Reconstruction loses historical pixels; future upgrade: resend bounded recent
  images. Matching descriptors retain the existing native session.
- ACP stdin permits multi-MiB JSON lines (10 MiB decoded tested); the 8 MiB frame
  bound remains on child stdout only. Text-only serialization is unchanged.
- Output is text-only; no PDF/audio/video input. Image bytes are sent to Kiro's
  backend like any prompt content. Traces retain only image hashes/sizes.

## Evidence

Base: `auth_setup/.qa/kiro/image-input/` (outside the package).
- `baseline.log`: 149 Bun tests + CLI checks before changes.
- `red-host-wire.log`, `kiro-package-0SFJy6/host.log`: real host shape + HTTP 400.
- `red-bridge.log` → `green-bridge.log`: 16 failures → 58 passing tests.
- `red-acp.log` → `green-acp.log`: 4 failures → 28 passing tests. Exact image
  passthrough already worked at runtime; capability exposure/write limit did not.
- `red-plugin.log` → `test.log`: 2 metadata failures → full offline suite green.
- `build.log`, `typecheck.log`, `test.log`: 174 Bun tests + CLI checks, no failures.
- `green-package.log`, `kiro-package-iSS3Wz/evidence.json`: ten host checks,
  including exact PNG SHA-256, one prompt, text regression and parked abort/cleanup.
- `fix-*.log`, `reviewer*-*.log`, `kiro-package-gmFOB0/evidence.json`: blocker fixes
  (177 Bun tests + CLI, ten host checks) and independent re-review.
- `native-image-check.ts`, `native-image-evidence.json`: the single native image prompt
  (status, finish reason, normalized one-word answer, PNG SHA-256; no image bytes).
