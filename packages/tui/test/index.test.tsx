import { expect, test } from "@opencode-ai/nub-test"
import { run } from "../src"

test("exports the canonical application lifecycle", () => {
  expect(typeof run).toBe("function")
})
