import type { Context, PublicAPI, AI, HotkeyEvent } from "@wox-launcher/wox-plugin"
import { cleanTranscript, sanitize, expandPrompt, chat, refineInput } from "../refine"
import { Store, defaultAction, normalizeActions, recentContext } from "../store"
import { safeEntry, platformPackage, download, models } from "../downloads"
import * as downloads from "../downloads"
import { Controller } from "../controller"
import type { Engine } from "../engine"
import type { DictationWindow } from "../window"
import { TextInsert } from "../insert"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"

const ctx = {} as Context
function setupStore() {
  const values: Record<string, string> = {}
  const api = {
    GetSetting: jest.fn(async (_ctx, key: string) => values[key] || ""),
    SetSetting: jest.fn(async (_ctx, option) => {
      values[option.Key] = option.Value
      return { Success: true }
    }),
    ShowToastMsg: jest.fn(async () => ({ Success: true, ErrMsg: "" })),
    GetTranslation: jest.fn(async (_ctx, key: string) => key),
    Log: jest.fn(async () => {}),
    InvokePluginTool: jest.fn(async () => ({ Output: { status: "playing" } })),
    Copy: jest.fn(async () => {}),
    HideApp: jest.fn(async () => {})
  } as unknown as PublicAPI
  return { store: new Store(api, ctx), api, values }
}

describe("transcript safety", () => {
  test.each([
    ["language Chinese<asr_text>你好¶", "你好"],
    ["<|zh|><|NEUTRAL|>Hello", "Hello"],
    [" <blank12> <think> </think> ", ""],
    ["123456789", "123456789"],
    ["啊啊啊啊啊啊哈哈哈哈哈哈", ""]
  ])("cleans %s", (input, output) => expect(cleanTranscript(input)).toBe(output))
  test("rejects meta replies and runaway expansion", () => {
    expect(sanitize("你好", "Please provide the transcript")).toBe("")
    expect(sanitize("你好", "This is a very long response to a short utterance.")).toBe("")
    expect(sanitize("hello world", "```text\nHello world.\n```")).toBe("Hello world.")
  })
  test("does not recursively expand text containing placeholders", () =>
    expect(expandPrompt("{wox:dictation_text}: {wox:selected_text}", "{wox:selected_text}", "secret")).toBe("{wox:selected_text}: secret"))
})

describe("durable settings", () => {
  test("default and action shortcuts both allow standalone hold keys", async () => {
    const metadata = JSON.parse(await readFile(join(process.cwd(), "plugin.json"), "utf8"))
    const defaultHotkey = metadata.SettingDefinitions.find((item: { Value?: { Key?: string } }) => item.Value?.Key === "defaultHotkey")
    const actions = metadata.SettingDefinitions.find((item: { Value?: { Key?: string } }) => item.Value?.Key === "actions")
    const actionHotkey = actions.Value.Columns.find((column: { Key: string }) => column.Key === "hotkey")
    expect(defaultHotkey.Value.AllowedHotkeyKinds).toContain("holdKey")
    expect(actionHotkey.AllowedHotkeyKinds).toContain("holdKey")
  })
  test("dictionary table changes supply preferred spellings to AI refinement", async () => {
    const { store, values } = setupStore()
    values.dictionary = JSON.stringify([{ id: "old", phrase: " Wox " }])
    await store.load()
    expect(refineInput("wocks", [], store.dictionary)).toContain("Preferred spellings")
    expect(store.dictionary).toEqual(["Wox"])
    store.changed("dictionary", JSON.stringify([{ phrase: "声纹" }]))
    expect(refineInput("声音", [], store.dictionary)).toContain("声纹")
    expect(values.dictionary).toContain("Wox")
  })
  test("concurrent history edits do not lose records", async () => {
    const { store } = setupStore()
    await store.load()
    await Promise.all([store.addHistory("one", "one"), store.addHistory("two", "original")])
    expect(store.history.map(h => h.content)).toEqual(["two", "one"])
    expect(store.history[0].originalContent).toBe("original")
    expect(store.history[1].originalContent).toBeUndefined()
  })
  test("failed persistence does not change memory", async () => {
    const { store, api } = setupStore()
    jest.mocked(api.SetSetting).mockResolvedValue({ Success: false, ErrMsg: "write failed" })
    await expect(store.addHistory("text", "text")).rejects.toThrow()
    expect(store.history).toEqual([])
  })
  test("malformed stored data is not overwritten", async () => {
    const { store, api, values } = setupStore()
    values.history = "bad JSON"
    await expect(store.load()).rejects.toThrow()
    expect(api.SetSetting).not.toHaveBeenCalled()
  })
  test("retains only 500 history records", async () => {
    const { store } = setupStore()
    store.history = Array.from({ length: 500 }, (_, i) => ({ id: String(i), content: String(i), timestamp: i }))
    await store.addHistory("new", "raw")
    expect(store.history).toHaveLength(500)
    expect(store.history[499].id).toBe("498")
  })
  test("context inserts topic boundaries", () => {
    expect(
      recentContext(
        [
          { id: "2", content: "new", timestamp: 900000 },
          { id: "1", content: "old", timestamp: 600000 }
        ],
        1000000
      )
    ).toEqual(["old", "--- (topic changed) ---", "new"])
  })
  test("normalizes default and custom actions", () => {
    expect(
      normalizeActions([
        { id: "default", type: "default", name: "Disabled", disabled: true },
        { name: "Translate", output: "invalid" }
      ])
    ).toEqual([defaultAction, expect.objectContaining({ type: "custom", output: "input", name: "Translate" })])
  })
})

describe("AI streaming", () => {
  test("uses final snapshot, never concatenates partial snapshots", async () => {
    const { api } = setupStore()
    api.AIChatStream = jest.fn(async (_c, _m, _h, _o, callback) => {
      callback({ Status: "streaming", Data: "Hello" } as AI.ChatStreamData)
      callback({ Status: "streaming", Data: "Hello world" } as AI.ChatStreamData)
      callback({ Status: "finished", Data: "Hello world." } as AI.ChatStreamData)
    })
    await expect(chat(api, ctx, { Provider: "test", Name: "test" }, "", "", new AbortController().signal)).resolves.toBe("Hello world.")
  })
  test("abort settles even when the host never sends finished", async () => {
    const { api } = setupStore()
    api.AIChatStream = jest.fn(async () => {})
    const abort = new AbortController(),
      result = chat(api, ctx, { Provider: "test", Name: "test" }, "", "", abort.signal)
    abort.abort()
    await expect(result).rejects.toThrow("Cancelled")
  })
  test("timeout settles without a final callback", async () => {
    const { api } = setupStore()
    api.AIChatStream = jest.fn(async () => {})
    await expect(chat(api, ctx, { Provider: "test", Name: "test" }, "", "", new AbortController().signal, 1)).rejects.toThrow("timed out")
  })
})

describe("download boundaries", () => {
  test.each(["../escape", "/absolute", "C:/outside", "package/../escape", "package\\escape"])("rejects path %s", path => expect(() => safeEntry(path, { type: "File" })).toThrow())
  test("rejects links", () => expect(() => safeEntry("package/link", { type: "SymbolicLink" })).toThrow())
  test("rejects unsupported platforms before installing", () => expect(() => platformPackage("win32", "arm64")).toThrow())
  test("validates integrity and rejects changed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictation-test-")),
      original = global.fetch
    const integrity = `sha512-${createHash("sha512").update("payload").digest("base64")}`
    global.fetch = jest.fn(async () => new Response("payload"))
    try {
      await download("https://example.test/a", join(root, "good"), new AbortController().signal, () => {}, integrity)
      expect(await readFile(join(root, "good"), "utf8")).toBe("payload")
      await expect(download("https://example.test/a", join(root, "bad"), new AbortController().signal, () => {}, "sha512-invalid")).rejects.toThrow("integrity")
    } finally {
      global.fetch = original
      await rm(root, { recursive: true, force: true })
    }
  })
})

function setupController() {
  const { store, api } = setupStore()
  const engine = {
    downloads: { ready: jest.fn(async () => true), runtime: jest.fn(async () => "/runtime"), installModel: jest.fn(async () => {}), finishMigratedModel: jest.fn(async () => {}) },
    isModelLoaded: jest.fn(() => false),
    prepare: jest.fn(async () => {}),
    warmMicrophone: jest.fn(async () => {}),
    start: jest.fn(async () => {}),
    stopCapture: jest.fn(async () => {}),
    cancel: jest.fn(async () => {}),
    stop: jest.fn(async () => "hello"),
    feedback: jest.fn(async () => {}),
    dispose: jest.fn(),
    onEvent: () => {}
  } as unknown as Engine
  const view = { show: jest.fn(async () => {}), hide: jest.fn(async () => {}), update: jest.fn(async () => {}), close: jest.fn(async () => {}), onCommand: async () => {} } as unknown as DictationWindow
  const controller = new Controller(api, ctx, store, engine, view)
  return { controller, engine, view, store, api }
}

describe("session lifecycle", () => {
  test("a missing model shows only a toast without opening the dictation window", async () => {
    const { controller, engine, view, api } = setupController()
    jest.mocked(engine.downloads.ready).mockResolvedValue(false)
    const capture = jest.spyOn(TextInsert.prototype, "capture")
    try {
      await controller.start(defaultAction, "", "activation", 123, true)
      expect(api.ShowToastMsg).toHaveBeenCalledWith(ctx, { Message: "Error: Download a speech model first: dictate model" })
      expect(view.show).not.toHaveBeenCalled()
      expect(view.update).not.toHaveBeenCalled()
      expect(api.HideApp).not.toHaveBeenCalled()
      expect(capture).not.toHaveBeenCalled()
      expect(engine.start).not.toHaveBeenCalled()
      expect(controller.state).toBe("idle")
    } finally {
      capture.mockRestore()
    }
  })
  test("reports a disconnected microphone without exposing a technical error", async () => {
    const { controller, engine, view, api } = setupController()
    jest.mocked(engine.start).mockRejectedValue(new Error("MICROPHONE_UNAVAILABLE: device lost"))
    await controller.start({ ...defaultAction, output: "clipboard" })
    expect(view.close).toHaveBeenCalled()
    expect(api.ShowToastMsg).toHaveBeenCalledWith(ctx, { Message: expect.stringContaining("Microphone unavailable") })
    expect(api.Log).toHaveBeenCalledWith(ctx, "Warning", expect.stringContaining("device lost"))
    expect(controller.state).toBe("idle")
  })
  test("explains Windows audio initialization errors separately", async () => {
    const { controller, engine, api } = setupController()
    jest.mocked(engine.start).mockRejectedValue(new Error("MICROPHONE_UNAVAILABLE: os error -2147417850"))
    await controller.start({ ...defaultAction, output: "clipboard" })
    expect(api.ShowToastMsg).toHaveBeenCalledWith(ctx, { Message: expect.stringContaining("Could not initialize audio") })
    expect(api.GetTranslation).toHaveBeenCalledWith(ctx, "plugin_dictation_audio_init_failed")
  })
  test("no speech closes the recording window without a toast", async () => {
    const { controller, engine, view, store, api } = setupController()
    jest.mocked(engine.stop).mockResolvedValue("")
    await controller.start({ ...defaultAction, output: "clipboard" })
    await controller.stop()
    expect(view.close).toHaveBeenCalledTimes(1)
    expect(api.ShowToastMsg).not.toHaveBeenCalled()
    expect(engine.dispose).not.toHaveBeenCalled()
    expect(store.history).toEqual([])
    expect(controller.state).toBe("idle")
  })
  test("a late waveform update failure after cancellation does not notify or dispose the engine", async () => {
    const { controller, engine, view, api } = setupController()
    await controller.start({ ...defaultAction, output: "clipboard" })
    let rejectUpdate!: (error: Error) => void
    jest.mocked(view.update).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpdate = reject }))
    engine.onEvent({ event: "level", data: 0.5 })
    await view.onCommand("cancel")
    rejectUpdate(new Error("window closed"))
    await new Promise(resolve => setImmediate(resolve))
    expect(engine.cancel).toHaveBeenCalledTimes(1)
    expect(engine.dispose).not.toHaveBeenCalled()
    expect(api.ShowToastMsg).not.toHaveBeenCalled()
    expect(controller.state).toBe("idle")
  })
  test("a stale waveform failure cannot cancel a new recording", async () => {
    const { controller, engine, view, api } = setupController()
    await controller.start({ ...defaultAction, output: "clipboard" })
    let rejectUpdate!: (error: Error) => void
    jest.mocked(view.update).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpdate = reject }))
    engine.onEvent({ event: "level", data: 0.5 })
    await view.onCommand("cancel")
    await controller.start({ ...defaultAction, output: "clipboard" })
    rejectUpdate(new Error("window closed"))
    await new Promise(resolve => setImmediate(resolve))
    expect(engine.dispose).not.toHaveBeenCalled()
    expect(api.ShowToastMsg).not.toHaveBeenCalled()
    expect(controller.state).toBe("recording")
    await controller.cancel()
  })
  test("a waveform update failure in an active recording is still reported", async () => {
    const { controller, engine, view, api } = setupController()
    await controller.start({ ...defaultAction, output: "clipboard" })
    jest.mocked(view.update).mockRejectedValueOnce(new Error("window update failed"))
    engine.onEvent({ event: "level", data: 0.5 })
    await new Promise(resolve => setImmediate(resolve))
    expect(engine.dispose).toHaveBeenCalledWith("controller failure state=recording")
    expect(api.ShowToastMsg).toHaveBeenCalledWith(ctx, { Message: "Error: window update failed" })
  })
  test("cancelling from the window restores the original app after closing it", async () => {
    const restore = jest.spyOn(TextInsert.prototype, "restoreFocus").mockResolvedValue()
    const { controller, view } = setupController()
    await controller.start({ ...defaultAction, output: "clipboard" }, "", "", 123)
    await view.onCommand("cancel")
    expect(restore).toHaveBeenCalledWith(123)
    expect(jest.mocked(view.close).mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0])
    expect(controller.state).toBe("idle")
    restore.mockRestore()
  })
  test("cancelling a recording keeps the model and waits for capture to close", async () => {
    const { controller, engine, store } = setupController()
    let finish!: () => void
    jest.mocked(engine.cancel).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await controller.start(defaultAction)
    const cancelling = controller.cancel()
    const secondCancel = controller.cancel()
    expect(controller.state).toBe("stopping")
    await expect(controller.start(defaultAction)).rejects.toThrow("busy")
    expect(engine.cancel).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([cancelling, secondCancel])
    expect(controller.state).toBe("idle")
    expect(store.history).toEqual([])
    expect(engine.dispose).not.toHaveBeenCalled()
  })
  test("cancelling from the window requests one stop cue without waiting for it", async () => {
    const { controller, engine, view } = setupController()
    let finishSound!: () => void
    jest.mocked(engine.feedback).mockImplementation(() => new Promise(resolve => { finishSound = resolve }))
    await controller.start({ ...defaultAction, output: "clipboard" })
    const cancelling = view.onCommand("cancel")
    await controller.cancel()
    await cancelling
    expect(engine.feedback).toHaveBeenCalledTimes(1)
    expect(engine.feedback).toHaveBeenCalledWith("stop", expect.any(String), expect.any(Number))
    expect(jest.mocked(engine.feedback).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(engine.cancel).mock.invocationCallOrder[0])
    expect(controller.state).toBe("idle")
    finishSound()
  })
  test("cancelling during the trailing capture plays the cue once", async () => {
    jest.useFakeTimers()
    try {
      const { controller, engine, view } = setupController()
      await controller.start({ ...defaultAction, output: "overlay" })
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(100)
      await view.onCommand("cancel")
      await jest.advanceTimersByTimeAsync(150)
      await stopping
      expect(engine.feedback).toHaveBeenCalledTimes(1)
      expect(engine.feedback).toHaveBeenCalledWith("stop", expect.any(String), expect.any(Number))
      expect(engine.cancel).toHaveBeenCalledTimes(1)
      expect(engine.stopCapture).not.toHaveBeenCalled()
    } finally { jest.useRealTimers() }
  })
  test("cancelling while the microphone is closing does not repeat the stop cue", async () => {
    jest.useFakeTimers()
    try {
      const { controller, engine, view } = setupController()
      let finishCapture!: () => void
      jest.mocked(engine.stopCapture).mockImplementation(() => new Promise(resolve => { finishCapture = resolve }))
      await controller.start({ ...defaultAction, output: "overlay" })
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(250)
      expect(finishCapture).toBeDefined()
      await view.onCommand("cancel")
      finishCapture()
      await stopping
      expect(engine.feedback).toHaveBeenCalledTimes(1)
      expect(engine.cancel).toHaveBeenCalledTimes(1)
      expect(engine.stop).not.toHaveBeenCalled()
    } finally { jest.useRealTimers() }
  })
  test("closing a completed result does not play a second stop cue", async () => {
    const { controller, engine, view } = setupController()
    await controller.start({ ...defaultAction, output: "overlay" })
    await controller.stop()
    await view.onCommand("cancel")
    expect(engine.feedback).toHaveBeenCalledTimes(1)
  })
  test("a failed recording cancellation disposes the engine", async () => {
    const { controller, engine } = setupController()
    jest.mocked(engine.cancel).mockRejectedValue(new Error("capture failed"))
    await controller.start(defaultAction)
    await controller.cancel()
    expect(engine.dispose).toHaveBeenCalledWith("cancel failed")
    expect(controller.state).toBe("idle")
  })
  test("closing a completed result keeps the loaded engine for the next recording", async () => {
    const { controller, engine } = setupController()
    await controller.start({ ...defaultAction, output: "overlay" })
    await controller.stop()
    await controller.cancel()
    expect(engine.dispose).not.toHaveBeenCalled()
    await controller.start(defaultAction)
    expect(engine.start).toHaveBeenCalledTimes(2)
    await controller.cancel()
    expect(engine.cancel).toHaveBeenCalledTimes(1)
    expect(engine.dispose).not.toHaveBeenCalled()
  })
  test("does not show a loading message for a quick start", async () => {
    const { controller, engine, view } = setupController()
    jest.mocked(engine.isModelLoaded).mockReturnValue(true)
    await controller.start(defaultAction)
    expect(view.update).toHaveBeenCalledWith({ status: "Preparing…", starting: true, busy: true, level: 0 })
    expect(view.update).not.toHaveBeenCalledWith({ status: "Preparing microphone…", busy: true })
    expect(view.update).not.toHaveBeenCalledWith({ status: "Loading speech engine…", busy: true })
    await controller.cancel()
  })
  test("starts microphone capture without waiting for a slow window", async () => {
    const { controller, engine, view } = setupController()
    let finish!: () => void
    jest.mocked(view.show).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const starting = controller.start({ ...defaultAction, output: "clipboard" })
    while (controller.state !== "recording") await new Promise(resolve => setImmediate(resolve))
    expect(engine.start).toHaveBeenCalledTimes(1)
    finish()
    await starting
    await controller.cancel()
  })
  test("slow microphone preparation eventually displays its status", async () => {
    const { controller, engine, view } = setupController()
    let finish!: () => void
    jest.mocked(engine.start).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const starting = controller.start({ ...defaultAction, output: "clipboard" })
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 850))
    expect(view.update).toHaveBeenCalledWith({ status: "Loading speech engine…", busy: true })
    finish()
    await starting
    await controller.cancel()
  })
  test("shares an in-progress background model warmup with the first recording", async () => {
    const exists = jest.spyOn(downloads, "exists").mockResolvedValue(true)
    const { controller, engine } = setupController()
    Object.assign(engine.downloads, { runtimePath: () => "/runtime", modelPath: () => "/model" })
    let finish!: () => void
    jest.mocked(engine.prepare).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    Object.assign(engine, { preload: jest.fn(async () => {}) })
    controller.warmup()
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    const starting = controller.start({ ...defaultAction, output: "clipboard" })
    await new Promise(resolve => setImmediate(resolve))
    expect(engine.start).not.toHaveBeenCalled()
    finish()
    await starting
    expect(engine.preload).toHaveBeenCalledTimes(1)
    expect(engine.start).toHaveBeenCalledTimes(1)
    await controller.cancel()
    exists.mockRestore()
  })
  test("a background model download does not block the dictation hotkey", async () => {
    const { controller, engine, store } = setupController()
    const selectedModel = store.settings.model
    let finishDownload!: () => void
    jest.mocked(engine.downloads.installModel).mockImplementation(() => new Promise(resolve => { finishDownload = resolve }))
    const downloading = controller.download(models[1].id, () => {})
    while (!finishDownload) await new Promise(resolve => setImmediate(resolve))
    await controller.onHotkey({ SettingKey: "defaultHotkey", Kind: "pressModifier", Phase: "triggered", Hotkey: "right_shift", ActivationID: "press", Timestamp: 1 })
    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(controller.state).toBe("recording")
    finishDownload()
    await downloading
    expect(store.settings.model).toBe(selectedModel)
    expect(controller.state).toBe("recording")
    expect(engine.dispose).not.toHaveBeenCalled()
    await controller.cancel()
  })
  test("cancelling dictation leaves a background model download running", async () => {
    const { controller, engine } = setupController()
    let finishDownload!: () => void
    let downloadSignal!: AbortSignal
    jest.mocked(engine.downloads.installModel).mockImplementation((_model, signal) => {
      downloadSignal = signal
      return new Promise(resolve => { finishDownload = resolve })
    })
    const downloading = controller.download(models[1].id, () => {})
    while (!finishDownload) await new Promise(resolve => setImmediate(resolve))
    await controller.onHotkey({ SettingKey: "defaultHotkey", Kind: "pressModifier", Phase: "triggered", Hotkey: "right_shift", ActivationID: "press", Timestamp: 1 })
    await controller.cancel()
    expect(downloadSignal.aborted).toBe(false)
    finishDownload()
    await downloading
  })
  test("does not flash a processing message when recognition finishes quickly", async () => {
    jest.useFakeTimers()
    try {
      const { controller, view } = setupController()
      await controller.start({ ...defaultAction, output: "overlay" })
      jest.mocked(view.update).mockClear()
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(250)
      await stopping
      await jest.advanceTimersByTimeAsync(1000)
      expect(view.update).not.toHaveBeenCalledWith(expect.objectContaining({ busy: true }))
      expect(view.update).toHaveBeenCalledWith(expect.objectContaining({ result: true, text: "hello" }))
    } finally { jest.useRealTimers() }
  })
  test("does not show a processing message when recognition and AI both finish quickly", async () => {
    jest.useFakeTimers()
    try {
      const { controller, store, view, api } = setupController()
      store.settings.defaultAIRefineEnabled = "true"
      store.settings.defaultAIModel = JSON.stringify({ Provider: "test", Name: "test" })
      api.AIChatStream = jest.fn(async (_ctx, _model, _messages, _option, callback) => {
        callback({ Status: "finished", Data: "Hello." } as AI.ChatStreamData)
      })
      await controller.start({ ...defaultAction, output: "overlay" })
      jest.mocked(view.update).mockClear()
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(250)
      await stopping
      await jest.advanceTimersByTimeAsync(1000)
      expect(view.update).not.toHaveBeenCalledWith(expect.objectContaining({ busy: true }))
      expect(view.update).toHaveBeenCalledWith(expect.objectContaining({ result: true, text: "Hello." }))
    } finally { jest.useRealTimers() }
  })
  test("shows the current processing stage only after the delay", async () => {
    jest.useFakeTimers()
    try {
      const { controller, engine, store, view, api } = setupController()
      store.settings.defaultAIRefineEnabled = "true"
      store.settings.defaultAIModel = JSON.stringify({ Provider: "test", Name: "test" })
      let finishRecognition!: (text: string) => void
      jest.mocked(engine.stop).mockImplementation(() => new Promise(resolve => { finishRecognition = resolve }))
      const callbacks: AI.ChatStreamFunc[] = []
      api.AIChatStream = jest.fn(async (_ctx, _model, _messages, _option, callback) => { callbacks.push(callback) })
      await controller.start({ ...defaultAction, type: "custom", prompt: "{wox:dictation_text}", output: "overlay" })
      jest.mocked(view.update).mockClear()
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(250)
      expect(engine.stop).toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(499)
      expect(view.update).not.toHaveBeenCalledWith(expect.objectContaining({ busy: true }))
      await jest.advanceTimersByTimeAsync(1)
      expect(view.update).toHaveBeenLastCalledWith({ status: "plugin_dictation_processing", busy: true })
      finishRecognition("hello")
      await jest.advanceTimersByTimeAsync(0)
      expect(view.update).toHaveBeenLastCalledWith({ status: "plugin_dictation_ai_refining", busy: true })
      callbacks[0]({ Status: "finished", Data: "Hello." } as AI.ChatStreamData)
      await jest.advanceTimersByTimeAsync(0)
      expect(view.update).toHaveBeenLastCalledWith({ status: "plugin_dictation_action_ai_processing", busy: true })
      callbacks[1]({ Status: "finished", Data: "Done" } as AI.ChatStreamData)
      await stopping
      expect(store.history[0].content).toBe("Done")
    } finally { jest.useRealTimers() }
  })
  test("a quick recognition followed by slow AI shows the AI stage rather than stale recognition", async () => {
    jest.useFakeTimers()
    try {
      const { controller, store, view, api } = setupController()
      store.settings.defaultAIRefineEnabled = "true"
      store.settings.defaultAIModel = JSON.stringify({ Provider: "test", Name: "test" })
      let finish!: AI.ChatStreamFunc
      api.AIChatStream = jest.fn(async (_ctx, _model, _messages, _option, callback) => { finish = callback })
      await controller.start({ ...defaultAction, output: "overlay" })
      jest.mocked(view.update).mockClear()
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(250)
      expect(finish).toBeDefined()
      await jest.advanceTimersByTimeAsync(500)
      expect(view.update).toHaveBeenLastCalledWith({ status: "plugin_dictation_ai_refining", busy: true })
      expect(view.update).not.toHaveBeenCalledWith({ status: "plugin_dictation_processing", busy: true })
      finish({ Status: "finished", Data: "Hello." } as AI.ChatStreamData)
      await stopping
    } finally { jest.useRealTimers() }
  })
  test("a late translation cannot restore processing after the result is ready", async () => {
    jest.useFakeTimers()
    try {
      const { controller, engine, view, api } = setupController()
      let finishRecognition!: (text: string) => void
      let finishTranslation!: (text: string) => void
      jest.mocked(engine.stop).mockImplementation(() => new Promise(resolve => { finishRecognition = resolve }))
      jest.mocked(api.GetTranslation).mockImplementation((_ctx, key) => key === "plugin_dictation_processing"
        ? new Promise(resolve => { finishTranslation = resolve }) : Promise.resolve(key))
      await controller.start({ ...defaultAction, output: "overlay" })
      jest.mocked(view.update).mockClear()
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(750)
      expect(finishTranslation).toBeDefined()
      finishRecognition("hello")
      await stopping
      finishTranslation("Processing…")
      await jest.advanceTimersByTimeAsync(0)
      expect(view.update).not.toHaveBeenCalledWith({ status: "Processing…", busy: true })
      expect(view.update).toHaveBeenLastCalledWith(expect.objectContaining({ result: true, text: "hello" }))
    } finally { jest.useRealTimers() }
  })
  test("an old translation cannot replace the current AI processing stage", async () => {
    jest.useFakeTimers()
    try {
      const { controller, engine, store, view, api } = setupController()
      store.settings.defaultAIRefineEnabled = "true"
      store.settings.defaultAIModel = JSON.stringify({ Provider: "test", Name: "test" })
      let finishRecognition!: (text: string) => void
      let finishTranslation!: (text: string) => void
      let finishAI!: AI.ChatStreamFunc
      jest.mocked(engine.stop).mockImplementation(() => new Promise(resolve => { finishRecognition = resolve }))
      jest.mocked(api.GetTranslation).mockImplementation((_ctx, key) => key === "plugin_dictation_processing"
        ? new Promise(resolve => { finishTranslation = resolve }) : Promise.resolve(key))
      api.AIChatStream = jest.fn(async (_ctx, _model, _messages, _option, callback) => { finishAI = callback })
      await controller.start({ ...defaultAction, output: "overlay" })
      jest.mocked(view.update).mockClear()
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(750)
      finishRecognition("hello")
      await jest.advanceTimersByTimeAsync(0)
      expect(view.update).toHaveBeenLastCalledWith({ status: "plugin_dictation_ai_refining", busy: true })
      finishTranslation("Old recognition status")
      await jest.advanceTimersByTimeAsync(0)
      expect(view.update).toHaveBeenLastCalledWith({ status: "plugin_dictation_ai_refining", busy: true })
      finishAI({ Status: "finished", Data: "Hello." } as AI.ChatStreamData)
      await stopping
    } finally { jest.useRealTimers() }
  })
  test("cancellation before the delay prevents a later processing message", async () => {
    jest.useFakeTimers()
    try {
      const { controller, engine, view } = setupController()
      let finishRecognition!: (text: string) => void
      jest.mocked(engine.stop).mockImplementation(() => new Promise(resolve => { finishRecognition = resolve }))
      await controller.start({ ...defaultAction, output: "overlay" })
      jest.mocked(view.update).mockClear()
      const stopping = controller.stop()
      await jest.advanceTimersByTimeAsync(250)
      await controller.cancel()
      await jest.advanceTimersByTimeAsync(1000)
      finishRecognition("hello")
      await stopping
      expect(view.update).not.toHaveBeenCalledWith(expect.objectContaining({ busy: true }))
      expect(view.update).not.toHaveBeenCalledWith(expect.objectContaining({ result: true }))
    } finally { jest.useRealTimers() }
  })
  test("inserts into the captured target and closes the overlay on success", async () => {
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockResolvedValue("1:2:123")
    const insert = jest.spyOn(TextInsert.prototype, "insert").mockResolvedValue(true)
    const { controller, view, api } = setupController()
    await controller.start(defaultAction, "", "", 123)
    await controller.stop()
    expect(capture).toHaveBeenCalledWith(123, expect.any(AbortSignal))
    expect(insert).toHaveBeenCalledWith("1:2:123", "hello", expect.any(AbortSignal), expect.objectContaining({ id: expect.any(String) }))
    expect(jest.mocked(view.hide).mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0])
    expect(view.close).toHaveBeenCalled()
    expect(api.Copy).not.toHaveBeenCalled()
    capture.mockRestore()
    insert.mockRestore()
  })
  test("captures a selection action target after hiding Wox", async () => {
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockResolvedValue("1:2:123")
    const { controller, api } = setupController()
    await controller.start(defaultAction, "selected text", "", 123, true)
    expect(jest.mocked(api.HideApp).mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0])
    expect(capture).toHaveBeenCalledWith(123, expect.any(AbortSignal))
    await controller.cancel()
    capture.mockRestore()
  })
  test("captures a hotkey target before displaying or hiding Wox windows", async () => {
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockResolvedValue("1:2:123")
    const { controller, api, view } = setupController()
    await controller.start(defaultAction, "", "", 123)
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(view.show).mock.invocationCallOrder[0])
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(api.HideApp).mock.invocationCallOrder[0])
    await controller.cancel()
    capture.mockRestore()
  })
  test("shows the overlay without taking focus while input target capture is pending", async () => {
    let finish!: (target: string) => void
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const { controller, view, api, engine } = setupController()
    const starting = controller.start(defaultAction, "", "", 123)
    while (!jest.mocked(view.show).mock.calls.length) await new Promise(resolve => setImmediate(resolve))
    expect(view.show).toHaveBeenCalledWith(false)
    expect(api.HideApp).not.toHaveBeenCalled()
    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(controller.state).toBe("recording")
    finish("1:2:123")
    await starting
    expect(view.show).toHaveBeenLastCalledWith()
    await controller.cancel()
    capture.mockRestore()
  })
  test("stopping closes the microphone while target capture is still pending", async () => {
    let finish!: (target: string) => void
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const insert = jest.spyOn(TextInsert.prototype, "insert").mockResolvedValue(true)
    const { controller, engine } = setupController()
    const starting = controller.start(defaultAction, "", "", 123)
    while (controller.state !== "recording") await new Promise(resolve => setImmediate(resolve))
    const stopping = controller.stop()
    while (!jest.mocked(engine.stopCapture).mock.calls.length) await new Promise(resolve => setTimeout(resolve, 10))
    expect(insert).not.toHaveBeenCalled()
    finish("1:2:123")
    await Promise.all([starting, stopping])
    expect(insert).toHaveBeenCalledWith("1:2:123", "hello", expect.any(AbortSignal), expect.objectContaining({ id: expect.any(String) }))
    capture.mockRestore()
    insert.mockRestore()
  })
  test("cancelling while target capture is pending releases a late target", async () => {
    let finish!: (target: never) => void
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const release = jest.spyOn(TextInsert.prototype, "release")
    const { controller, engine } = setupController()
    const starting = controller.start(defaultAction, "", "", 123)
    await Promise.resolve()
    await controller.cancel()
    const child = { kill: jest.fn() }
    finish({ kind: "mac", child } as never)
    await starting
    await new Promise(resolve => setImmediate(resolve))
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ child }))
    expect(child.kill).toHaveBeenCalled()
    expect(engine.start).not.toHaveBeenCalled()
    capture.mockRestore()
    release.mockRestore()
  })
  test("a silent recording releases a target captured after it finishes", async () => {
    let finish!: (target: never) => void
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const { controller, engine } = setupController()
    jest.mocked(engine.stop).mockResolvedValue("")
    const starting = controller.start(defaultAction, "", "", 123)
    while (controller.state !== "recording") await new Promise(resolve => setImmediate(resolve))
    await controller.stop()
    const child = { kill: jest.fn() }
    finish({ kind: "mac", child } as never)
    await starting
    await new Promise(resolve => setImmediate(resolve))
    expect(child.kill).toHaveBeenCalled()
    expect(controller.state).toBe("idle")
    capture.mockRestore()
  })
  test("explains missing macOS Accessibility access when falling back to the clipboard", async () => {
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockRejectedValue(new Error("macOS Accessibility permission is required"))
    const { controller, api } = setupController()
    await controller.start(defaultAction, "", "", 123)
    await controller.stop()
    expect(api.Copy).toHaveBeenCalledWith(ctx, { type: "text", text: "hello" })
    expect(api.Log).toHaveBeenCalledWith(ctx, "Warning", expect.stringContaining("macOS Accessibility permission is required"))
    expect(api.GetTranslation).toHaveBeenCalledWith(ctx, "plugin_dictation_insert_accessibility")
    expect(api.ShowToastMsg).toHaveBeenCalledWith(ctx, { Message: expect.stringContaining("Allow Accessibility access") })
    capture.mockRestore()
  })
  test("copies the transcript and shows a notification if insertion fails", async () => {
    const capture = jest.spyOn(TextInsert.prototype, "capture").mockResolvedValue("1:2:123")
    const insert = jest.spyOn(TextInsert.prototype, "insert").mockRejectedValue(new Error("focus changed"))
    const { controller, view, store, api } = setupController()
    await controller.start(defaultAction, "", "", 123)
    await controller.stop()
    expect(api.Copy).toHaveBeenCalledWith(ctx, { type: "text", text: "hello" })
    expect(api.ShowToastMsg).toHaveBeenCalledWith(ctx, { Message: "plugin_dictation_insert_fallback" })
    expect(store.history[0].content).toBe("hello")
    expect(view.close).toHaveBeenCalled()
    capture.mockRestore()
    insert.mockRestore()
  })
  test("keeps the transcript visible if automatic insertion and copying fail", async () => {
    const { controller, view, store, api } = setupController()
    jest.mocked(api.Copy).mockRejectedValue(new Error("clipboard unavailable"))
    await controller.start(defaultAction)
    await controller.stop()
    expect(view.update).toHaveBeenLastCalledWith(expect.objectContaining({ result: true, text: "hello" }))
    expect(view.show).toHaveBeenCalledTimes(3)
    expect(store.history[0].content).toBe("hello")
    expect(view.close).not.toHaveBeenCalled()
  })
  test("pauses playing media during capture and resumes before recognition finishes", async () => {
    const { controller, engine, store, api } = setupController()
    store.settings.duckVolume = "true"
    await controller.start(defaultAction)
    expect(jest.mocked(api.InvokePluginTool).mock.calls.map(([, option]) => option.Name)).toEqual(["get_status", "pause"])
    expect(jest.mocked(api.InvokePluginTool).mock.invocationCallOrder[1]).toBeLessThan(jest.mocked(engine.start).mock.invocationCallOrder[0])
    await controller.stop()
    expect(jest.mocked(api.InvokePluginTool).mock.calls.map(([, option]) => option.Name)).toEqual(["get_status", "pause", "play"])
    expect(jest.mocked(engine.stopCapture).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(api.InvokePluginTool).mock.invocationCallOrder[2])
    await controller.cancel()
    expect(api.InvokePluginTool).toHaveBeenCalledTimes(3)
  })
  test("slow media resume does not delay transcription or output", async () => {
    const { controller, engine, store, api } = setupController()
    store.settings.duckVolume = "true"
    let finishResume!: () => void
    jest.mocked(api.InvokePluginTool).mockImplementation(async (_ctx, option) => {
      if (option.Name === "play") await new Promise<void>(resolve => { finishResume = resolve })
      return { Output: { status: "playing" } }
    })
    await controller.start({ ...defaultAction, output: "overlay" })
    const stopping = controller.stop()
    while (!finishResume) await new Promise(resolve => setImmediate(resolve))
    await stopping
    expect(engine.stop).toHaveBeenCalledTimes(1)
    expect(controller.state).toBe("idle")
    finishResume()
  })
  test("does not resume media that was already paused", async () => {
    const { controller, store, api } = setupController()
    store.settings.duckVolume = "true"
    jest.mocked(api.InvokePluginTool).mockResolvedValue({ Output: { status: "paused" } })
    await controller.start(defaultAction)
    await controller.cancel()
    expect(jest.mocked(api.InvokePluginTool).mock.calls.map(([, option]) => option.Name)).toEqual(["get_status"])
  })
  test("resumes media if microphone startup fails", async () => {
    const { controller, engine, store, api } = setupController()
    store.settings.duckVolume = "true"
    jest.mocked(engine.start).mockRejectedValue(new Error("microphone unavailable"))
    await controller.start(defaultAction)
    expect(jest.mocked(api.InvokePluginTool).mock.calls.map(([, option]) => option.Name)).toEqual(["get_status", "pause", "play"])
    expect(controller.state).toBe("idle")
  })
  test("continues recording when media tools are unavailable", async () => {
    const { controller, engine, store, api } = setupController()
    store.settings.duckVolume = "true"
    jest.mocked(api.InvokePluginTool).mockRejectedValue(new Error("unavailable"))
    await controller.start(defaultAction)
    expect(engine.start).toHaveBeenCalledTimes(1)
    await controller.cancel()
    expect(api.Log).toHaveBeenCalled()
  })
  test("cancellation during an in-flight pause restores media exactly once", async () => {
    const { controller, store, api } = setupController()
    store.settings.duckVolume = "true"
    let finishPause!: () => void
    jest.mocked(api.InvokePluginTool).mockImplementation(async (_ctx, option) => {
      if (option.Name === "pause") await new Promise<void>(resolve => { finishPause = resolve })
      return { Output: { status: "playing" } }
    })
    const starting = controller.start(defaultAction)
    while (!finishPause) await new Promise(resolve => setImmediate(resolve))
    const cancelling = controller.cancel()
    finishPause()
    await Promise.all([starting, cancelling])
    expect(jest.mocked(api.InvokePluginTool).mock.calls.map(([, option]) => option.Name)).toEqual(["get_status", "pause", "play"])
    expect(controller.state).toBe("idle")
  })
  test("requests stop feedback after capture ends and before transcription finishes", async () => {
    const { controller, engine, store } = setupController()
    await controller.start(defaultAction)
    expect(engine.feedback).not.toHaveBeenCalled()
    await controller.stop()
    expect(store.history).toHaveLength(1)
    expect(engine.feedback).toHaveBeenLastCalledWith("stop", expect.any(String), expect.any(Number))
    expect(jest.mocked(engine.stopCapture).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(engine.feedback).mock.invocationCallOrder[0])
    expect(jest.mocked(engine.feedback).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(engine.stop).mock.invocationCallOrder[0])
  })
  test("correlates startup stages and sound with the same session without recording text", async () => {
    const { controller, engine, api } = setupController()
    const startedAt = Date.now() - 25
    await controller.onHotkey({ SettingKey: "defaultHotkey", Kind: "normalCombo", Phase: "triggered", Hotkey: "ctrl+alt+d", ActivationID: "test", Timestamp: startedAt })
    const args = jest.mocked(engine.start).mock.calls[0]
    const traceId = args[6]
    expect(traceId).toEqual(expect.any(String))
    const logs = jest.mocked(api.Log).mock.calls.map(([, , message]) => message).filter(message => message.includes(`[Dictation timing] session=${traceId} `))
    expect(logs.some(message => message.includes("stage=start_received") && message.includes("eventToPluginMs="))).toBe(true)
    expect(logs.some(message => message.includes("stage=engine_start_requested"))).toBe(true)
    expect(logs.some(message => message.includes("stage=recording_started"))).toBe(true)
    expect(logs.every(message => !message.includes("ctrl+alt+d"))).toBe(true)
    await controller.cancel()
  })
  test.each([
    ["holdModifier", "hold:right_alt"],
    ["holdKey", "hold:delete"]
  ])("%s release during model loading cancels and stale release cannot stop a new session", async (kind, hotkey) => {
    const { controller, engine } = setupController()
    let ready!: (value: boolean) => void
    jest.mocked(engine.downloads.ready).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          ready = resolve
        })
    )
    const event = { SettingKey: "defaultHotkey", Kind: kind, Phase: "started" as const, Hotkey: hotkey, ActivationID: "first", Timestamp: 1 } as HotkeyEvent
    const first = controller.onHotkey(event)
    while (!ready) await new Promise(resolve => setImmediate(resolve))
    await controller.onHotkey({ ...event, Phase: "ended", EndReason: "released" })
    ready(true)
    await first
    expect(controller.state).toBe("idle")
    expect(engine.start).not.toHaveBeenCalled()
    await controller.onHotkey({ ...event, ActivationID: "second" })
    await controller.onHotkey({ ...event, Phase: "ended", EndReason: "released" })
    expect(controller.state).toBe("recording")
    await controller.onHotkey({ ...event, ActivationID: "second", Phase: "ended", EndReason: "bindingChanged" })
    expect(controller.state).toBe("idle")
    expect(engine.stop).not.toHaveBeenCalled()
  })
  test("ordinary hotkey toggles recording and table actions route by stable ID", async () => {
    const { controller, engine, store } = setupController()
    store.actions.push({ ...defaultAction, id: "custom", type: "custom", output: "clipboard" })
    const event = { SettingKey: "actions", ItemID: "custom", ColumnKey: "hotkey", Kind: "normalCombo" as const, Phase: "triggered" as const, Hotkey: "ctrl+alt+d", ActivationID: "once", Timestamp: 1 }
    await controller.onHotkey({ ...event, ItemID: "missing" })
    expect(engine.start).not.toHaveBeenCalled()
    await controller.onHotkey(event)
    expect(controller.state).toBe("recording")
    await controller.onHotkey({ ...event, ActivationID: "twice" })
    expect(engine.stop).toHaveBeenCalledTimes(1)
    expect(controller.state).toBe("idle")
  })
  test("concurrent starts reserve the session before awaiting model checks", async () => {
    const { controller, engine } = setupController()
    let ready!: (value: boolean) => void
    jest.mocked(engine.downloads.ready).mockImplementation(
      () =>
        new Promise(resolve => {
          ready = resolve
        })
    )
    const first = controller.start(defaultAction)
    await expect(controller.start(defaultAction)).rejects.toThrow("busy")
    while (!ready) await new Promise(resolve => setImmediate(resolve))
    ready(true)
    await first
    expect(engine.start).toHaveBeenCalledTimes(1)
    await controller.cancel()
  })
  test("cancellation during custom AI suppresses late output and history", async () => {
    const { controller, store, api } = setupController()
    let callback!: AI.ChatStreamFunc
    api.AIChatStream = jest.fn(async (_ctx, _model, _messages, _option, cb) => {
      callback = cb
    })
    await controller.start({ ...defaultAction, type: "custom", prompt: "{wox:dictation_text}", model: JSON.stringify({ Provider: "test", Name: "test" }), output: "clipboard" })
    const stopping = controller.stop()
    while (!callback) await new Promise(resolve => setTimeout(resolve, 5))
    await controller.cancel()
    callback({ Status: "finished", Data: "late" } as AI.ChatStreamData)
    await stopping
    expect(store.history).toEqual([])
    expect(api.Copy).not.toHaveBeenCalled()
  })
  test("double stop yields one history entry and one fallback copy", async () => {
    const { controller, engine, store, api } = setupController()
    await controller.start(defaultAction)
    await Promise.all([controller.stop(), controller.stop()])
    expect(engine.stop).toHaveBeenCalledTimes(1)
    expect(store.history).toHaveLength(1)
    expect(controller.state).toBe("idle")
    expect(api.Copy).toHaveBeenCalledTimes(1)
  })
  test("cancel during startup prevents microphone activation", async () => {
    const { controller, engine, store } = setupController()
    let ready!: () => void
    jest.mocked(engine.prepare).mockImplementation(
      () =>
        new Promise(resolve => {
          ready = resolve
        })
    )
    const starting = controller.start(defaultAction)
    while (!ready) await new Promise(resolve => setImmediate(resolve))
    await controller.stop()
    ready()
    await starting
    expect(engine.start).not.toHaveBeenCalled()
    expect(store.history).toEqual([])
    expect(controller.state).toBe("idle")
  })
  test("cancel during trailing audio discards output", async () => {
    const { controller, engine, store } = setupController()
    await controller.start(defaultAction)
    const stopping = controller.stop()
    await controller.cancel()
    await stopping
    expect(engine.stop).not.toHaveBeenCalled()
    expect(store.history).toEqual([])
  })
  test("chat and missing selection fail before recording", async () => {
    const { controller, engine } = setupController()
    await expect(controller.start({ ...defaultAction, output: "chat" })).rejects.toThrow("AI Chat output is unavailable")
    await expect(controller.start({ ...defaultAction, prompt: "{wox:selected_text}" })).rejects.toThrow("selection")
    expect(engine.start).not.toHaveBeenCalled()
  })
  test("AI failure preserves the raw transcript", async () => {
    const { controller, store, api } = setupController()
    store.settings.defaultAIRefineEnabled = "true"
    store.settings.defaultAIModel = "bad json"
    await controller.start(defaultAction)
    await controller.stop()
    expect(store.history[0].content).toBe("hello")
    expect(api.ShowToastMsg).toHaveBeenCalled()
  })
  test("silence does not create history", async () => {
    const { controller, engine, store } = setupController()
    jest.mocked(engine.stop).mockResolvedValue("<blank1>")
    await controller.start(defaultAction)
    await controller.stop()
    expect(store.history).toEqual([])
  })
})
