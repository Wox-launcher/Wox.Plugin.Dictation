import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { TextInsert } from "../insert"

const windowsTest = process.platform === "win32" ? test : test.skip
windowsTest("checks the target before copying and inserts multiline text with paste", async () => {
  const api = { Copy: jest.fn(async () => {}) } as unknown as PublicAPI
  const insert = new TextInsert(api, {} as Context, "")
  const run = jest.spyOn(insert as unknown as { run: (mode: string, signal: AbortSignal, input?: string) => Promise<string> }, "run")
  run.mockResolvedValueOnce("1:2:123").mockResolvedValueOnce("")
  const signal = new AbortController().signal
  expect(await insert.insert("1:2:123", "first\n第二行", signal)).toBe(true)
  expect(api.Copy).toHaveBeenCalledWith(expect.anything(), { type: "text", text: "first\r\n第二行" })
  expect(JSON.parse(run.mock.calls[1][2]!)).toEqual({ target: "1:2:123", text: "", paste: true })
  run.mockResolvedValueOnce("9:9:123")
  expect(await insert.insert("1:2:123", "next\nline", signal)).toBe(false)
  expect(api.Copy).toHaveBeenCalledTimes(1)
})
