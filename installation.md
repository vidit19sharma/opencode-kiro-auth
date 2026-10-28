# Installation

## Current path: local checkout

This development package is not yet published to npm. Source: https://github.com/vidit19sharma/opencode-kiro-auth. Use a local checkout on **macOS or Linux**, with Node.js **>=22.13**. The plugin's ACP cleanup relies on POSIX process groups; Windows is not initially supported, regardless of Kiro CLI installer availability.

```sh
git clone https://github.com/vidit19sharma/opencode-kiro-auth.git
cd opencode-kiro-auth
```

### 1. Install and log in to Kiro CLI

Use the [official installation guide](https://kiro.dev/docs/getting-started/installation/) (CLI tab). The installer URLs referenced by this project's CLI are:

```sh
# macOS / Linux
curl -fsSL https://cli.kiro.dev/install | bash
```

Then, in a terminal:

```sh
kiro-cli login
```

Tested Kiro baseline: **2.33.1**, explicitly using `acp --agent-engine v2`. Other versions are not yet established as compatible; no engine fallback is promised. `KIRO_CLI` can select an alternative executable path.

### 2. Build the local entry

From the checkout root:

```sh
npm install
npm run build
```

The build script compiles TypeScript into `dist` and uses `chmod`; run it in a POSIX-compatible shell. A successful build alone does not verify native Kiro integration.

Merge the following into your OpenCode config, preserving other entries. Replace the placeholder with the absolute checkout path (URL-encode spaces):

```json
{
  "plugin": ["file:///absolute/path/to/opencode-kiro-auth/dist/index.js"]
}
```

The entry must point to the built **file**, not the source directory. Do not use the setup helper for a local install: it writes the unpublished npm package spec. Rebuild after local source updates and restart OpenCode.

### 3. Register CLI-managed authentication in OpenCode

Restart OpenCode after adding the entry, then run:

```sh
opencode auth login --provider kiro
```

Select **“CLI-managed login (terminal registration)”**. Enter the following marker **twice**: first at the plugin's registration text prompt, then at OpenCode's additional **“Enter your API key”** prompt:

```text
kiro-cli-managed
```

This is a **non-secret sentinel**, not a Kiro key. Kiro authentication stays with terminal `kiro-cli login`; the OpenCode step deliberately registers the provider through the host's credential UI. Startup does not seed `auth.json`, scrape tokens, or overwrite existing auth. Unsupported credentials require explicit re-registration.

**Restart OpenCode after registration.** The host only invokes the auth loader for a stored auth entry, and an already-initialized provider requires reload. G2 exercised explicit test-owned registration followed by reload on OpenCode **1.19.1**; terminal prompt sequencing is source-verified only. The CLI invokes custom `authorize`, but TUI `/connect` bypasses it, so requests also check the registration marker and CLI executable/version/login. Plugin/SDK types used are **1.19.4**; broader host compatibility is unverified.

After restarting, select a `kiro/` model. Models are discovered through Kiro CLI and cached, with `kiro/auto` as fallback; listing a model does not prove authentication or inference succeeds.

## Runtime limits

- PNG/JPEG/GIF/WebP base64 data attachments are supported by the bridge: **5 MiB decoded per image / 10 MiB per request**. This is offline-verified through real OpenCode + fake Kiro and confirmed with one native Haiku 4.5 prompt on Kiro CLI 2.34.2 / ACP v2 (the documented baseline remains 2.33.1). The CLI must advertise image input; the catalog does not report per-model vision. External image URLs are never fetched. Image bytes are sent to Kiro's backend like other prompt content.
- Historical image pixels are not resent on reconstruction; replay uses MIME/size/SHA-256 placeholders. No PDF/audio/video input, image output, thought events or effort variants are exposed. See [image scope and evidence](docs/image-input.md).
- Missing native token usage is omitted; OpenCode can show **zero for unknown usage**. Credits/context percentages are not tokens or dollar prices, zero displayed price is not free inference, and output limits are local accounting reserves rather than vendor maxima.
- Each active session/agent scope uses a Kiro process; observed cost was roughly **100–250 MB per active scope**, not a bound.
- Project system/developer instructions are supplied beneath Kiro's own harness; they do not replace it.
- The session map is in memory. Restart or model/history/incompatible instruction/schema changes can reconstruct from OpenCode text history. Replay is approximate, not guaranteed exact native transcript semantics or durable disk resume. Native Kiro session artifacts remain Kiro-managed.
- ACP/MCP tools have a configured two-hour bound; shorter host timeout overrides reduce it. G2 did not exercise elapsed >120-second/two-hour host calls.

See [README.md](README.md) for architecture and cache details. Review the [official Kiro FAQ](https://kiro.dev/faq/) and current account/subscription terms; official ACP availability is not vendor approval of this integration.

## After npm publication only

**These commands are future instructions, not a working installation path today.** The intended scoped package is `@vidit19sharma/opencode-kiro-auth`; the unscoped name refers to a different package.

```sh
npx @vidit19sharma/opencode-kiro-auth@latest setup --dry-run
npx @vidit19sharma/opencode-kiro-auth@latest setup
```

The helper adds `@vidit19sharma/opencode-kiro-auth@latest` to the top-level `plugin` array. It preserves an existing scoped entry; for JSONC requiring a rewrite it prints a manual edit instead. `--config <path>` selects a file. Otherwise lookup uses `OPENCODE_CONFIG`, then `opencode.jsonc` / `opencode.json` under `OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`. Review the target and avoid duplicate local/npm entries for this provider.

For future npm-installed updates:

```sh
npx @vidit19sharma/opencode-kiro-auth@latest update --dry-run
npx @vidit19sharma/opencode-kiro-auth@latest update
```

The update helper removes this package's OpenCode cached installation so the next restart can resolve it again; it does not rebuild a local `file://` entry. OpenCode package cache is separate from the plugin's model catalog cache.

## Verification status

Native text/tool acceptance passed with two Haiku 4.5 ACP prompts: real secret-result tool continuation within the same prompt, remembered code after quiescent schema change/native reload, and owned cleanup. It predates the final cancellation-only fix. Current-tree packed QA passed ten checks with real OpenCode 1.19.1 and a fake Kiro executable, including exact image delivery, parked-tool cancellation and same-scope recovery without disposal. One native image prompt passed on CLI 2.34.2. Both the cancellation and image deltas received independent approval; publication, vendor approval and full UI/long-call behavior are not established. See [image evidence](docs/image-input.md) and [integration QA](docs/integration-qa.md).

`npm test` invokes [`scripts/test-offline.sh`](scripts/test-offline.sh) with isolated HOME/XDG paths and offline fixtures; the retained image-input log records 174 Bun tests passing plus CLI checks. QA artifacts default to the checkout parent's `.qa/kiro/` (`auth_setup/.qa/kiro/` here); `KIRO_QA_ARTIFACTS` overrides the parent artifact base, independently of `TMPDIR`. See [QA evidence](QA-EVIDENCE.md). Further live checks require fresh explicit authorization; historical [plan](docs/implementation-plan.md) budgets do not authorize new calls.
