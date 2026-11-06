import type { Context, CreateWindowOption, PluginWindow, PublicAPI } from "@wox-launcher/wox-plugin"
import { DictationWindow } from "../window"

const ctx = {} as Context
function setup() {
  let option!: CreateWindowOption
  const update = jest.fn<Promise<{ Success: boolean; ErrMsg: string }>, [Context, { Data: string; Sequence: number }]>(async () => ({ Success: true, ErrMsg: "" }))
  const window = {
    ID: "window-1", Show: jest.fn(async () => ({ Success: true })), Hide: jest.fn(async () => ({ Success: true })),
    Close: jest.fn(async () => ({ Success: true })), SetOptions: jest.fn(async () => ({ Success: true })), Content: { Update: update }
  } as unknown as PluginWindow
  const api = {
    CreateWindow: jest.fn(async (_ctx, value: CreateWindowOption) => { option = value; return { Success: true, Window: window } }),
    GetThemeColors: jest.fn(async () => ({ Background: "#202832", Text: "#e8f0ff", SecondaryText: "#aab8c8", Border: "#333333", Accent: "#4488ff", AccentText: "#ffffff", Selection: "#555555", Dark: true }))
  } as unknown as PublicAPI
  return { view: new DictationWindow(api, ctx), api, window, update, option: () => option }
}
type Node = { type: string; key?: string; props?: Record<string, unknown> & { style?: Record<string, unknown>; onPress?: { $handler: string } }; children?: Node[] }
function nodes(node: Node): Node[] { return [node, ...(node.children || []).flatMap(nodes)] }
function tree(data: string) { return nodes(JSON.parse(data).root) }

test("reuses a WoxView window, resizes it, and replays state after hiding", async () => {
  const { view, api, window, update, option } = setup()
  await view.prepare()
  expect(option().Content.Type).toBe("woxview")
  expect(option().Window).toMatchObject({ Width: 208, Height: 40, OffsetX: 22, HideChrome: true, DragContent: true, Transparent: true })
  expect(option().Window).toMatchObject({ PassThroughTransparent: process.platform === "win32" })
  await view.show(false)
  const opening = update.mock.calls.slice(-2).map(call => tree(call[1].Data).find(n => n.key === "panel")!.props!.style!)
  expect(opening.map(style => [style.scale, style.opacity])).toEqual([[.05, 0], [1, 1]])
  expect(opening.map(style => style.width)).toEqual([164, 164])
  await view.update({ status: "Listening", recording: true, level: .5 })
  let current = tree(update.mock.lastCall![1].Data)
  expect(current.filter(n => n.key?.startsWith("bar-"))).toHaveLength(13)
  expect(current.find(n => n.key === "wave")?.props?.onPress?.$handler).toBe("stop")
  await view.update({ status: "Ready", result: true, text: "<img src=x>" })
  expect(window.SetOptions).toHaveBeenLastCalledWith(ctx, { Width: 440, Height: 300 })
  current = tree(update.mock.lastCall![1].Data)
  expect(current.find(n => n.key === "result-text")?.props).toMatchObject({ text: "<img src=x>", selectable: true })
  expect(current.find(n => n.key === "copy")?.props?.onPress?.$handler).toBe("copy")
  await view.close()
  update.mockClear()
  await view.update({ status: "AI refining", busy: true })
  expect(update).not.toHaveBeenCalled()
  await view.show(false)
  current = tree(update.mock.lastCall![1].Data)
  expect(current.some(n => n.type === "loading")).toBe(true)
  expect(current.some(n => n.props?.text === "AI refining")).toBe(true)
  expect(window.SetOptions).toHaveBeenLastCalledWith(ctx, { Width: 208, Height: 40 })
  expect(api.CreateWindow).toHaveBeenCalledTimes(1)
  await view.destroy()
  expect(window.Close).toHaveBeenCalledTimes(1)
})

test("reopening during the exit animation cancels the pending hide", async () => {
  const { view, window, update } = setup()
  await view.show()
  const before = update.mock.calls.length
  const hiding = view.hide()
  while (update.mock.calls.length === before) await new Promise(resolve => setImmediate(resolve))
  expect(tree(update.mock.lastCall![1].Data).find(n => n.key === "panel")?.props?.style).toMatchObject({ width: 164, scale: .05, opacity: 0 })
  const showing = view.show()
  await Promise.all([hiding, showing])
  expect(window.Hide).not.toHaveBeenCalled()
  expect(tree(update.mock.lastCall![1].Data).find(n => n.key === "panel")?.props?.style).toMatchObject({ width: 164, scale: 1, opacity: 1 })
  await view.destroy()
})

test("waveform moves in silence and responds to speech; close appears on hover", async () => {
  const { view, update, option, window } = setup()
  await view.show()
  const frame = () => tree(update.mock.lastCall![1].Data)
  const heights = () => frame().filter(n => n.key?.startsWith("bar-")).map(n => n.props!.style!.height as number)
  expect(frame().find(n => n.key === "panel")?.props?.style?.backgroundColor).toBe("#202832")
  expect(frame().some(n => n.key === "close-shape")).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 330))
  expect(frame().find(n => n.key === "panel")?.props?.onHoverChange).toEqual({ $handler: "hover" })
  expect(JSON.parse(update.mock.lastCall![1].Data).root.props.onHoverChange).toBeUndefined()
  expect(frame().find(n => n.key === "cancel")?.props?.onHoverChange).toEqual({ $handler: "hover" })
  expect(frame().find(n => n.key === "cancel")?.props).toMatchObject({ disabled: true, style: { opacity: 0 } })
  expect(frame().find(n => n.key === "close-shape")?.props).toMatchObject({ progress: 0, style: { color: "#202832" } })
  expect(frame().some(n => n.key === "hover-gap")).toBe(false)
  await view.update({ status: "Listening", recording: true, level: 0 })
  const quiet = heights()
  await view.update({ status: "Listening", recording: true, level: 0 })
  expect(heights()).not.toEqual(quiet)
  await view.update({ status: "Listening", recording: true, level: 1 })
  expect(Math.max(...heights())).toBeGreaterThan(Math.max(...quiet) + 5)
  await option().OnEvent!(ctx, { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: "hover", Args: [true] } })
  expect(frame().find(n => n.key === "cancel")?.props).toMatchObject({ disabled: true, style: { opacity: 0 } })
  expect(frame().find(n => n.key === "close-shape")?.props?.progress).toBe(1)
  const closeShape = frame().find(n => n.key === "close-shape")!.props!
  expect(closeShape.keyframes).toHaveLength(4)
  expect(frame().find(n => n.key === "hover-gap")?.props).toMatchObject({ inputRegion: true, onHoverChange: { $handler: "hover" }, style: { left: 164, width: 10 } })
  expect(closeShape.duration).toBe(400)
  expect(frame().find(n => n.key === "close-position")?.props?.style?.width).toBe(206)
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(frame().find(n => n.key === "cancel")?.props).toMatchObject({ disabled: true, style: { opacity: 0 } })
  await new Promise(resolve => setTimeout(resolve, 230))
  expect(frame().find(n => n.key === "cancel")?.props).toMatchObject({ disabled: false, onPress: { $handler: "cancel" }, style: { opacity: 1 } })
  await option().OnEvent!(ctx, { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: "hover", Args: [false] } })
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(frame().find(n => n.key === "cancel")?.props).toMatchObject({ disabled: true, style: { opacity: 0 } })
  expect(frame().find(n => n.key === "close-shape")?.props).toMatchObject({ progress: 0, duration: 260 })
  expect(frame().some(n => n.key === "hover-gap")).toBe(false)
  await view.destroy()
})

test("theme changes recolor the whole shape, and a quick hover exit cancels separation", async () => {
  const { view, api, update, option, window } = setup()
  await view.show()
  await new Promise(resolve => setTimeout(resolve, 330))
  const frame = () => tree(update.mock.lastCall![1].Data)
  await option().OnEvent!(ctx, { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: "hover", Args: [true] } })
  await option().OnEvent!(ctx, { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: "hover", Args: [false] } })
  jest.mocked(api.GetThemeColors).mockResolvedValueOnce({ Background: "#f0e6da", Text: "#302010", SecondaryText: "#604830", Border: "#333333", Accent: "#4488ff", AccentText: "#ffffff", Selection: "#aaaaaa", Dark: false })
  await option().OnEvent!(ctx, { Type: "theme_changed" as never, WindowID: window.ID, Data: { Dark: false } })
  expect(frame().find(n => n.key === "panel")?.props?.style?.backgroundColor).toBe("#f0e6da")
  expect(frame().find(n => n.key === "close-shape")?.props?.style?.color).toBe("#f0e6da")
  expect(frame().find(n => n.key === "cancel")?.props?.style).toMatchObject({ backgroundColor: "#00000000", color: "#302010", opacity: 0 })
  await new Promise(resolve => setTimeout(resolve, 180))
  expect(frame().find(n => n.key === "close-shape")?.props?.progress).toBe(0)
  await view.destroy()
})

test("hover during the opening animation waits until the capsule is visible", async () => {
  const { view, update, option, window } = setup()
  await view.show()
  const event = { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: "hover", Args: [true] } }
  await option().OnEvent!(ctx, event)
  expect(tree(update.mock.lastCall![1].Data).some(n => n.key === "close-shape")).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 340))
  expect(tree(update.mock.lastCall![1].Data).find(n => n.key === "close-shape")?.props?.progress).toBe(1)
  await view.destroy()
})

test("reversing hover during the pinch cancels the previous snap", async () => {
  jest.useFakeTimers()
  try {
    const { view, update, option, window } = setup()
    const frame = () => tree(update.mock.lastCall![1].Data)
    const hover = (value: boolean) => option().OnEvent!(ctx, { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: "hover", Args: [value] } })
    await view.show()
    await jest.advanceTimersByTimeAsync(330)
    await hover(true)
    await jest.advanceTimersByTimeAsync(220)
    expect(frame().find(n => n.key === "close-shape")?.props?.progress).toBe(1)
    await hover(false)
    await jest.advanceTimersByTimeAsync(200)
    await hover(true)
    await jest.advanceTimersByTimeAsync(140)
    expect(frame().find(n => n.key === "close-shape")?.props?.progress).toBe(1)
    expect(frame().find(n => n.key === "cancel")?.props?.disabled).toBe(true)
    await jest.advanceTimersByTimeAsync(260)
    expect(frame().find(n => n.key === "close-shape")?.props?.progress).toBe(1)
    expect(frame().find(n => n.key === "cancel")?.props?.disabled).toBe(false)
    const closing = view.destroy()
    await jest.advanceTimersByTimeAsync(250)
    await closing
  } finally { jest.useRealTimers() }
})

test("returning during merge cancels absorption", async () => {
  jest.useFakeTimers()
  try {
    const { view, update, option, window } = setup()
    const frame = () => tree(update.mock.lastCall![1].Data)
    const hover = (value: boolean) => option().OnEvent!(ctx, { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: "hover", Args: [value] } })
    await view.show()
    await jest.advanceTimersByTimeAsync(330)
    await hover(true)
    await jest.advanceTimersByTimeAsync(400)
    await hover(false)
    await jest.advanceTimersByTimeAsync(180)
    expect(frame().find(n => n.key === "close-shape")?.props?.progress).toBe(0)
    await jest.advanceTimersByTimeAsync(50)
    await hover(true)
    await jest.advanceTimersByTimeAsync(60)
    expect(frame().find(n => n.key === "close-shape")?.props?.progress).toBe(1)
    const closing = view.destroy()
    await jest.advanceTimersByTimeAsync(250)
    await closing
  } finally { jest.useRealTimers() }
})

test("crossing the gap to the close button keeps it visible", async () => {
  jest.useFakeTimers()
  try {
    const { view, update, option, window } = setup()
    const frame = () => tree(update.mock.lastCall![1].Data)
    const hover = (value: boolean) => option().OnEvent!(ctx, { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: "hover", Args: [value] } })
    await view.show()
    await jest.advanceTimersByTimeAsync(330)
    await hover(true)
    await jest.advanceTimersByTimeAsync(400)
    await hover(false)
    await jest.advanceTimersByTimeAsync(100)
    await hover(true)
    await jest.advanceTimersByTimeAsync(1000)
    expect(frame().find(n => n.key === "close-shape")?.props?.progress).toBe(1)
    expect(frame().find(n => n.key === "cancel")?.props?.disabled).toBe(false)
    const closing = view.destroy()
    await jest.advanceTimersByTimeAsync(250)
    await closing
  } finally { jest.useRealTimers() }
})

test("dispatches WoxView commands without waiting for a slow stop", async () => {
  const { view, option, window } = setup()
  let finish!: () => void
  const commands: string[] = []
  view.onCommand = async command => { commands.push(command); if (command === "stop") await new Promise<void>(resolve => { finish = resolve }) }
  await view.show()
  const event = (handler: string) => option().OnEvent!(ctx, { Type: "woxview_event" as never, WindowID: window.ID, Data: { Handler: handler, Args: [] } })
  await event("stop")
  await event("cancel")
  await event("copy")
  await event("unknown")
  expect(commands).toEqual(["stop", "cancel", "copy"])
  finish()
})

test("a native close event dispatches cancellation", async () => {
  const { view, option, window } = setup()
  const commands: string[] = []
  view.onCommand = async command => { commands.push(command) }
  await view.show()
  await option().OnEvent!(ctx, { Type: "closed", WindowID: window.ID })
  expect(commands).toEqual(["cancel"])
})

test("a hide during delayed creation prevents a stale show", async () => {
  const { view, api, window } = setup()
  const create = jest.mocked(api.CreateWindow)
  const original = create.getMockImplementation()!
  let finish!: () => void
  create.mockImplementation(async (...args) => { await new Promise<void>(resolve => { finish = resolve }); return original(...args) })
  const showing = view.show(false)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  const hiding = view.close()
  finish()
  await Promise.all([showing, hiding])
  expect(window.Show).not.toHaveBeenCalled()
  await view.destroy()
})

test("stale updates and old close events cannot override the current state", async () => {
  const { view, update, option } = setup()
  const command = jest.fn(async () => {})
  view.onCommand = command
  await view.show()
  const old = option()
  let finish!: () => void
  update.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ Success: true, ErrMsg: "" }) }))
  const first = view.update({ status: "Listening", recording: true, level: .1 })
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  const stale = view.update({ status: "Listening", recording: true, level: .9 })
  const processing = view.update({ status: "AI refining", busy: true })
  finish()
  await Promise.all([first, stale, processing])
  expect(tree(update.mock.lastCall![1].Data).some(n => n.props?.text === "AI refining")).toBe(true)
  await view.destroy()
  await view.show()
  await old.OnEvent!(ctx, { Type: "closed", WindowID: "window-1" })
  expect(command).not.toHaveBeenCalled()
})
