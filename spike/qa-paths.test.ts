import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { createQaRun, qaArtifactBase } from "../scripts/qa-paths.ts"

test("defaults to checkout-parent QA storage despite inherited OS temp settings", () => {
  // Given the normal inherited OS temporary directory;
  const env = { TMPDIR: "/unused-system-temp", KIRO_QA_ROOT: "/unused-individual-run" }
  // When resolving the QA artifact base;
  const base = qaArtifactBase(env)
  // Then QA storage belongs to the checkout parent, independent of runtime temp settings.
  expect(base).toBe(resolve(import.meta.dirname, "../../.qa/kiro"))
})

test("creates private unique runs within an explicit isolated artifact base", () => {
  // Given a test-owned parent separate from the default artifact base;
  const fixture = mkdtempSync(join(qaArtifactBase(), "qa-paths-test-"))
  try {
    const env = { KIRO_QA_ARTIFACTS: join(fixture, "artifacts"), TMPDIR: join(fixture, "other") }
    // When two runs allocate scratch;
    const first = createQaRun("fixture-", env), second = createQaRun("fixture-", env)
    // Then they are isolated, private children of the supplied base.
    expect(first.startsWith(`${env.KIRO_QA_ARTIFACTS}/fixture-`)).toBe(true)
    expect(second.startsWith(`${env.KIRO_QA_ARTIFACTS}/fixture-`)).toBe(true)
    expect(first).not.toBe(second)
    expect(statSync(env.KIRO_QA_ARTIFACTS).mode & 0o777).toBe(0o700)
    expect(statSync(first).mode & 0o777).toBe(0o700)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
