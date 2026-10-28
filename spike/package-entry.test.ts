import { expect, test } from "bun:test"

test("built package exposes exactly one callable default plugin", async () => {
  // Given the emitted public entry; When the host imports its namespace;
  const entry = await import("../dist/index.js")
  // Then there is one hook factory rather than duplicate plugin initialization.
  expect(Object.keys(entry)).toEqual(["default"])
  expect(typeof entry.default).toBe("function")
})
