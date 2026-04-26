import { afterEach, expect, mock, spyOn, test } from "bun:test"
import * as Core from "@opentui/core"

afterEach(() => {
  mock.restore()
})

test("tui rejects when renderer startup fails", async () => {
  const err = new Error("setRawMode failed with errno: 9")
  spyOn(Core, "createCliRenderer").mockRejectedValue(err)

  const { tui } = await import("../../../src/cli/cmd/tui/app")
  const result = await Promise.race([
    tui({
      url: "http://opencode.internal",
      config: {},
      args: {
        continue: false,
        fork: false,
      },
    }).then(
      () => "resolved",
      (error) => error,
    ),
    Bun.sleep(100).then(() => "timeout"),
  ])

  expect(result).toBe(err)
})
