import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { TextInsert } from "../insert"

jest.mock("node:child_process", () => ({ spawn: jest.fn() }))

test("macOS keeps the captured target alive and sends the transcript through stdin", async () => {
  const platform = process.platform
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() })
  jest.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)
  try {
    const input: string[] = []
    child.stdin.on("data", data => input.push(data.toString()))
    child.stdin.on("finish", () => child.emit("close", 0))
    const insert = new TextInsert({} as PublicAPI, {} as Context, "/plugin")
    const signal = new AbortController().signal
    const pending = insert.capture(123, signal)
    child.stdout.write("ready\n")
    const target = await pending
    expect(spawn).toHaveBeenCalledWith("/usr/bin/osascript", ["-l", "JavaScript", expect.stringContaining("insert-macos.js"), "123"], expect.objectContaining({ signal }))
    expect(await insert.insert(target, "你好 😀", signal)).toBe(true)
    expect(JSON.parse(input.join(""))).toEqual({ text: "你好 😀" })
    insert.release(target)
    expect(child.kill).toHaveBeenCalled()
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true })
  }
})
