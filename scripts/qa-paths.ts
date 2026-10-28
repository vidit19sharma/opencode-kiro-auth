import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"

type QaEnvironment = Readonly<Record<string, string | undefined>>

export function qaArtifactBase(env: QaEnvironment = process.env): string {
  const base = resolve(env.KIRO_QA_ARTIFACTS ?? resolve(import.meta.dirname, "../../.qa/kiro"))
  mkdirSync(base, { recursive: true, mode: 0o700 })
  return realpathSync(base)
}

export function createQaRun(prefix: string, env: QaEnvironment = process.env): string {
  return mkdtempSync(join(qaArtifactBase(env), prefix))
}

if (import.meta.main) console.log(qaArtifactBase())
