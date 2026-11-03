import type { Context, CreateWindowOption, PluginWindow, PublicAPI } from "@wox-launcher/wox-plugin"
import { DictationWindow } from "../window"
import { runInNewContext } from "node:vm"

const ctx = {} as Context
function setup() {
  let option!: CreateWindowOption
  const window = {
    ID: "window-1",
    Show: jest.fn(async () => ({ Success: true })),
    Close: jest.fn(async () => ({ Success: true })),
    SetOptions: jest.fn(async () => ({ Success: true })),
    Content: { PostMessage: jest.fn(async () => ({ Success: true })) }
  } as unknown as PluginWindow
  const api = {
    GetThemeColors: jest.fn(async () => ({ Background: "#fff", Text: "#111", SecondaryText: "#333", Border: "#555", Accent: "#00f", AccentText: "#fff", Selection: "#ddd", Dark: false })),
    CreateWindow: jest.fn(async (_ctx, value: CreateWindowOption) => {
      option = value
      return { Success: true, Window: window, WindowID: window.ID }
    })
  } as unknown as PublicAPI
  return { view: new DictationWindow(api, ctx), api, window, option: () => option }
}

test("coalesces pre-ready state and reuses one HTML document", async () => {
  const { view, api, window, option } = setup()
  await view.show()
  expect(option().Window).toMatchObject({ Width: 200, Height: 56, HideChrome: true, DragContent: true })
  for (let i = 0; i < 100; i++) await view.update({ status: String(i) })
  expect(window.Content.PostMessage).not.toHaveBeenCalled()
  await option().OnEvent!(ctx, { Type: "ready", WindowID: window.ID })
  expect(window.Content.PostMessage).toHaveBeenLastCalledWith(ctx, { Data: { status: "99" } })
  await view.show()
  expect(api.CreateWindow).toHaveBeenCalledTimes(1)
  expect(window.Show).toHaveBeenCalledWith(ctx, { Activate: false })
  await view.update({ status: "Preparing", busy: true })
  await view.update({ status: "Listening", recording: true })
  await view.update({ status: "AI refining", busy: true })
  expect(window.SetOptions).not.toHaveBeenCalled()
  await view.update({ status: "Ready", result: true, text: "text" })
  expect(window.SetOptions).toHaveBeenLastCalledWith(ctx, { Width: 440, Height: 300 })
  await view.update({ status: "Listening", recording: true })
  expect(window.SetOptions).toHaveBeenLastCalledWith(ctx, { Width: 200, Height: 56 })
  await view.update({ status: "AI refining", busy: true })
  expect(window.SetOptions).toHaveBeenCalledTimes(2)
})

test("stop callback does not block a subsequent cancel event", async () => {
  const { view, window, option } = setup()
  let resolveStop!: () => void
  const commands: string[] = []
  view.onCommand = async command => {
    commands.push(command)
    if (command === "stop")
      await new Promise<void>(resolve => {
        resolveStop = resolve
      })
  }
  await view.show()
  await option().OnEvent!(ctx, { Type: "message", WindowID: window.ID, Data: { command: "stop" } })
  await option().OnEvent!(ctx, { Type: "message", WindowID: window.ID, Data: { command: "cancel" } })
  expect(commands).toEqual(["stop", "cancel"])
  resolveStop()
})

test("old close events cannot cancel a new window", async () => {
  const { view, option } = setup()
  const command = jest.fn(async () => {})
  view.onCommand = command
  await view.show()
  const old = option()
  await view.close()
  await view.show()
  await old.OnEvent!(ctx, { Type: "closed", WindowID: "window-1" })
  expect(command).not.toHaveBeenCalled()
})

test("a delayed waveform update cannot replace a newer processing status", async () => {
  const { view, window, option } = setup()
  await view.show()
  await option().OnEvent!(ctx, { Type: "ready", WindowID: window.ID })
  const post = jest.mocked(window.Content.PostMessage)
  post.mockClear()
  let finish!: () => void
  post.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ Success: true }) }))
  const first = view.update({ status: "Listening", recording: true, level: 0.1 })
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  const stale = view.update({ status: "Listening", recording: true, level: 0.9 })
  const processing = view.update({ status: "AI refining", busy: true })
  finish()
  await Promise.all([first, stale, processing])
  expect(post).toHaveBeenCalledTimes(2)
  expect(post).toHaveBeenLastCalledWith(ctx, { Data: { status: "AI refining", busy: true } })
})

test("HTML messages render untrusted text as text and buttons send structured events", async () => {
  const { view, option } = setup()
  await view.show()
  const nodes: Record<string, Record<string, unknown>> = {}
  const bars = Array.from({ length: 7 }, () => ({ style: { height: "" } }))
  const messages: unknown[] = []
  let receive!: (state: unknown) => void
  const html = option().Content.Data
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
  runInNewContext(script, {
    document: { getElementById: (id: string) => (nodes[id] ||= { setAttribute: () => {} }), querySelectorAll: () => bars, body: { classList: { toggle: () => {} } }, addEventListener: () => {} },
    woxWindow: {
      onMessage: (callback: typeof receive) => {
        receive = callback
      },
      postMessage: (message: unknown) => messages.push(message)
    }
  })
  receive({ status: "Ready", text: "<img src=x onerror=alert(1)>", result: true })
  expect(nodes.text.textContent).toBe("<img src=x onerror=alert(1)>")
  expect(nodes.text.innerHTML).toBeUndefined()
  receive({ status: "Listening", recording: true, level: 0.5 })
  expect(nodes.spinner.hidden).toBe(true)
  expect(bars[3].style.height).toBe("14.5px")
  ;(nodes.wave.onclick as () => void)()
  ;(nodes.copy.onclick as () => void)()
  expect(messages).toEqual([{ command: "stop" }, { command: "copy" }])
  receive({ status: "AI refining", busy: true })
  expect(nodes.spinner.hidden).toBe(false)
  expect(nodes.wave.hidden).toBe(true)
  expect(nodes.status.textContent).toBe("AI refining")
})
