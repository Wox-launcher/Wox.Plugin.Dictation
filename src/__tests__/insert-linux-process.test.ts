import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { TextInsert } from "../insert"

jest.mock("node:child_process", () => ({ spawn: jest.fn() }))

test("Linux checks the target, copies text and asks the helper to paste", async () => {
  const platform = process.platform
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() })
  jest.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)
  const api = { Copy: jest.fn(async () => {}) } as unknown as PublicAPI
  try {
    const input: string[] = []
    child.stdin.on("data", data => {
      const text = data.toString()
      input.push(text)
      if (JSON.parse(text).op === "check") child.stdout.write("checked\n")
      if (JSON.parse(text).op === "paste") { child.stdout.write("done\n"); setImmediate(() => child.emit("close", 0)) }
    })
    const insert = new TextInsert(api, {} as Context, "/plugin")
    const signal = new AbortController().signal
    const pending = insert.capture(123, signal)
    child.stdout.write("ready\n")
    const target = await pending
    expect(spawn).toHaveBeenCalledWith("python3", ["-u", expect.stringContaining("insert-linux.py"), "123"], expect.objectContaining({ signal }))
    expect(await insert.insert(target, "你好\nworld", signal)).toBe(true)
    expect(input.map(line => JSON.parse(line))).toEqual([{ op: "check" }, { op: "paste" }])
    expect(api.Copy).toHaveBeenCalledWith(expect.anything(), { type: "text", text: "你好\nworld" })
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true })
  }
})
