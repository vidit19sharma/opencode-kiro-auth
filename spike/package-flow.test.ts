import { expect, test } from "bun:test"
import { env, project, root } from "../scripts/qa-host.ts"

test("built bridge drives real ACP and HTTP MCP offline with cleanup", async () => {
  // Given built modules in a process with only test-owned environment;
  const child = Bun.spawn([process.execPath, `${project}/spike/fixtures/bridge-flow.ts`], { env, cwd: root, stdout: "inherit", stderr: "inherit" })
  // When text, tool continuation, error, and abort scenarios run;
  const exit = await child.exited
  // Then the real transport scenario and ownership assertions pass.
  expect(exit).toBe(0)
}, 15000)
