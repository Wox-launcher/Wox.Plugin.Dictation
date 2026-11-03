import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { Engine } from "../engine"
import type { Downloads } from "../downloads"
import { models } from "../downloads"
import { Controller } from "../controller"
import { defaultAction, Store } from "../store"
import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import type { DictationWindow } from "../window"

jest.mock("node:child_process", () => ({ spawn: jest.fn() }))

async function setup() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    stdout: { resume: jest.fn() },
    stderr: new EventEmitter(),
    kill: jest.fn(),
    send: jest.fn((message: { id: number; method: string }) => {
      if (message.method === "status" || message.method === "start") child.emit("message", { id: message.id, result: { version: "test" } })
      if (message.method === "stop") child.emit("message", { id: message.id, result: { text: "hello" } })
      if (message.method === "stop-capture" || message.method === "sound" || message.method === "cancel") child.emit("message", { id: message.id, result: {} })
    })
  })
  jest.mocked(spawn).mockReturnValue(child as unknown as ChildProcess)
  const downloads = { runtime: jest.fn(async () => "/cache/runtime"), modelPath: jest.fn(model => `/models/${model.id}`) } as unknown as Downloads
  const engine = new Engine(downloads, "/plugin")
  await engine.prepare(new AbortController().signal, () => {})
  return { engine, child }
}

afterEach(() => jest.useRealTimers())

test("tracks the loaded model until the recognition process is disposed", async () => {
  const { engine } = await setup()
  expect(engine.isModelLoaded(models[0])).toBe(false)
  await engine.start(models[0], "")
  expect(engine.isModelLoaded(models[0])).toBe(true)
  expect(engine.isModelLoaded(models[1])).toBe(false)
  engine.dispose()
  expect(engine.isModelLoaded(models[0])).toBe(false)
})

test("consecutive recordings reuse the process and show microphone preparation", async () => {
  const { engine, child } = await setup()
  Object.assign(engine.downloads, { ready: jest.fn(async () => true), finishMigratedModel: jest.fn(async () => {}) })
  const api = { HideApp: jest.fn(async () => {}), GetTranslation: jest.fn(async () => "Processing"), SetSetting: jest.fn(async () => ({ Success: true })), Copy: jest.fn(async () => {}), Log: jest.fn(async () => {}) } as unknown as PublicAPI
  const ctx = {} as Context
  const store = new Store(api, ctx)
  store.settings.model = models[0].id
  const view = { update: jest.fn(async () => {}), show: jest.fn(async () => {}), close: jest.fn(async () => {}) } as unknown as DictationWindow
  const controller = new Controller(api, ctx, store, engine, view)
  const action = { ...defaultAction, output: "clipboard" as const }
  await controller.start(action)
  await controller.stop()
  jest.mocked(view.update).mockClear()
  await controller.start(action)
  expect(view.update).toHaveBeenCalledWith({ status: "Preparing microphone…", busy: true })
  expect(view.update).not.toHaveBeenCalledWith({ status: "Loading speech engine…", busy: true })
  expect(jest.mocked(api.Log).mock.calls.some(([, , message]) => message.includes("engine status") && message.includes("loaded=true"))).toBe(true)
  expect(jest.mocked(api.Log).mock.calls.some(([, , message]) => message.includes("engine reuse"))).toBe(true)
  expect(child.kill).not.toHaveBeenCalled()
  expect(jest.mocked(child.send).mock.calls.filter(([message]) => (message as { method: string }).method === "status")).toHaveLength(1)
  await controller.cancel()
  expect(child.kill).not.toHaveBeenCalled()
  expect(engine.isModelLoaded(models[0])).toBe(true)
  await controller.start(action)
  expect(view.update).toHaveBeenCalledWith({ status: "Preparing microphone…", busy: true })
  await controller.cancel()
  engine.dispose()
})

test("engine timeout reports timeout and terminates its process", async () => {
  jest.useFakeTimers()
  const { engine, child } = await setup()
  const result = expect(engine.request("hang", {}, 5)).rejects.toThrow("timed out")
  jest.advanceTimersByTime(5)
  await result
  expect(child.kill).toHaveBeenCalledTimes(1)
})

test("dispose rejects outstanding operations and late replies are ignored", async () => {
  const { engine, child } = await setup()
  const pending = expect(engine.request("hang", {})).rejects.toThrow("cancelled")
  engine.dispose()
  child.emit("message", { id: 2, result: { text: "late" } })
  await pending
  await expect(engine.request("status", {})).rejects.toThrow("not ready")
})

test("preparing a reused engine cancels its old idle expiration", async () => {
  jest.useFakeTimers()
  const { engine, child } = await setup()
  await engine.stop()
  jest.advanceTimersByTime(599000)
  await engine.prepare(new AbortController().signal, () => {})
  jest.advanceTimersByTime(2000)
  expect(child.kill).not.toHaveBeenCalled()
  engine.dispose()
})
