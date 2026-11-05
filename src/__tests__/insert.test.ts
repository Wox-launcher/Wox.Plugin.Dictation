import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { TextInsert } from "../insert"

const windowsTest = process.platform === "win32" ? test : test.skip
windowsTest("passes single and multiline text to one focus-checked insertion helper", async () => {
  const api = { Copy: jest.fn(async () => {}) } as unknown as PublicAPI
  const insert = new TextInsert(api, {} as Context, "")
  const run = jest.spyOn(insert as unknown as { run: (mode: string, signal: AbortSignal, input?: string) => Promise<string> }, "run")
  run.mockResolvedValue("done")
  const signal = new AbortController().signal
  expect(await insert.insert("1:2:123", "first single line", signal)).toBe(true)
  expect(JSON.parse(run.mock.calls[0][2]!)).toEqual({ target: "1:2:123", text: "first single line" })
  expect(await insert.insert("1:2:123", "first\n第二行", signal)).toBe(true)
  expect(JSON.parse(run.mock.calls[1][2]!)).toEqual({ target: "1:2:123", text: "first\r\n第二行" })
  expect(run.mock.calls.map(([mode]) => mode)).toEqual(["insert", "insert"])
  expect(api.Copy).not.toHaveBeenCalled()
  run.mockRejectedValueOnce(new Error("The original input is no longer focused"))
  await expect(insert.insert("1:2:123", "next line", signal)).rejects.toThrow("no longer focused")
  expect(api.Copy).not.toHaveBeenCalled()
})
