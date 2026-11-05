import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { TextInsert } from "../insert"

jest.mock("node:child_process", () => ({ spawn: jest.fn() }))

beforeEach(() => jest.mocked(spawn).mockReset())

test("Windows prepares the insertion process during capture and keeps it alive to restore the clipboard", async () => {
  const platform = process.platform
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() })
  jest.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)
  try {
    const api = { Log: jest.fn(async () => {}) } as unknown as PublicAPI
    const insert = new TextInsert(api, {} as Context, "/plugin")
    const operation = new AbortController()
    const preparing = insert.capture(123, operation.signal)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(jest.mocked(spawn).mock.calls[0][1]).toContain("session")
    child.stdout.write("ready\n")
    const target = await preparing
    let input = ""
    child.stdin.on("data", data => { input += String(data) })
    const pasting = insert.insert(target, "hello", operation.signal)
    await new Promise(resolve => setImmediate(resolve))
    expect(JSON.parse(input)).toEqual({ text: "hello" })
    expect(spawn).toHaveBeenCalledTimes(1)
    child.stdout.write("timing session=test stage=clipboard_snapshot_complete\n")
    child.stdout.write("done\n")
    await expect(pasting).resolves.toBe(true)
    expect(api.Log).toHaveBeenCalledWith(expect.anything(), "Info", expect.stringContaining("stage=clipboard_snapshot_complete"))
    operation.abort()
    insert.release(target)
    expect(child.kill).not.toHaveBeenCalled()
    child.emit("close", 0)
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true })
  }
})

test("Windows reports paste immediately and waits for clipboard restoration before the next paste", async () => {
  const platform = process.platform
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  const child = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() })
  const first = child(), second = child()
  jest.mocked(spawn).mockReturnValueOnce(first as unknown as ChildProcessWithoutNullStreams).mockReturnValueOnce(second as unknown as ChildProcessWithoutNullStreams)
  try {
    const insert = new TextInsert({} as PublicAPI, {} as Context, "/plugin")
    const operation = new AbortController()
    const one = insert.insert("1:2:123", "hello", operation.signal)
    await new Promise(resolve => setImmediate(resolve))
    first.stdout.write("done\r\n")
    await expect(one).resolves.toBe(true)
    operation.abort()
    expect(first.kill).not.toHaveBeenCalled()
    const two = insert.insert("1:2:123", "world", new AbortController().signal)
    await new Promise(resolve => setImmediate(resolve))
    expect(spawn).toHaveBeenCalledTimes(1)
    first.emit("close", 0)
    await new Promise(resolve => setImmediate(resolve))
    expect(spawn).toHaveBeenCalledTimes(2)
    second.stdout.write("done\n")
    await expect(two).resolves.toBe(true)
    second.emit("close", 0)
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true })
  }
})
