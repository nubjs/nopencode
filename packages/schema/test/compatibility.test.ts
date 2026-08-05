import { describe, expect, test } from "@opencode-ai/nub-test"
import { FileSystem } from "../src/filesystem"

describe("schema compatibility", () => {
  test("moved class schemas remain constructible", () => {
    const input = new FileSystem.FindInput({ query: "src" })
    expect(input).toBeInstanceOf(FileSystem.FindInput)
    expect(input.query).toBe("src")
  })
})
