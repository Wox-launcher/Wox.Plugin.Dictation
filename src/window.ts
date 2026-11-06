import type { Context, CreateWindowOption, PluginWindow, PublicAPI } from "@wox-launcher/wox-plugin"

export interface ViewState {
  status: string
  text?: string
  level?: number
  recording?: boolean
  starting?: boolean
  busy?: boolean
  result?: boolean
}

// The published SDK still describes the old HTML window API.
type WoxViewWindow = Omit<PluginWindow, "Content"> & { Content: { Update(ctx: Context, option: { Data: string; Sequence: number }): Promise<{ Success: boolean; ErrMsg?: string }> } }

const animationDuration = 220
const compactWidth = 164
const compactHeight = 40
const windowWidth = 208
const splitDuration = 400
const mergeDuration = 260
const hoverLeaveDelay = 180
const bridgeFrom = [
  { op: "M", values: [0, 0] }, { op: "C", values: [.23, 0, .417, .224, .417, .5] }, { op: "C", values: [.417, .5, .625, .5, .625, .5] },
  { op: "L", values: [.625, .5] }, { op: "C", values: [.625, .5, .417, .5, .417, .5] }, { op: "C", values: [.417, .776, .23, 1, 0, 1] }, { op: "Z" }
]
const bridgeTo = [
  { op: "M", values: [0, 0] }, { op: "C", values: [.3, 0, .35, .31, .6, .35] }, { op: "C", values: [.66, .35, .66, .1, .958, .1] },
  { op: "L", values: [.958, .9] }, { op: "C", values: [.66, .9, .66, .65, .6, .65] }, { op: "C", values: [.35, .69, .3, 1, 0, 1] }, { op: "Z" }
]
const circleFrom = [
  { op: "M", values: [.4754, .5] }, { op: "C", values: [.4754, .2791, .5928, .1, .7377, .1] }, { op: "C", values: [.8826, .1, 1, .2791, 1, .5] },
  { op: "C", values: [1, .7209, .8826, .9, .7377, .9] }, { op: "C", values: [.5928, .9, .4754, .7209, .4754, .5] }, { op: "Z" }
]
const circleTo = [
  { op: "M", values: [.344, .5] }, { op: "C", values: [.45, .5, .65, .1, .7377, .1] }, { op: "C", values: [.8826, .1, 1, .2791, 1, .5] },
  { op: "C", values: [1, .7209, .8826, .9, .7377, .9] }, { op: "C", values: [.65, .9, .45, .5, .344, .5] }, { op: "Z" }
]
type Path = typeof bridgeFrom
// The paths share one coordinate space and one timeline, including the connecting neck.
function pathInShape(path: Path, width: number, offset: number): Path {
  return path.map(command => ({ ...command, values: command.values?.map((value, i) => i % 2 === 0 ? (offset + width * value) / 62 : value) }))
}
function blendPath(from: Path, to: Path, progress: number): Path {
  return from.map((command, i) => ({ ...command, values: command.values?.map((value, j) => value + (to[i].values![j] - value) * progress) }))
}
const neckClosed = pathInShape(bridgeFrom, 48, 0)
const neckOpen = pathInShape(bridgeTo, 48, 0)
const neckHidden = pathInShape([
  { op: "M", values: [0, 0] }, { op: "C", values: [.23, 0, .2083, .224, .2083, .5] }, { op: "C", values: [.2083, .5, .2083, .5, .2083, .5] },
  { op: "L", values: [.2083, .5] }, { op: "C", values: [.2083, .5, .2083, .5, .2083, .5] }, { op: "C", values: [.2083, .776, .23, 1, 0, 1] }, { op: "Z" }
], 48, 0)
const bubbleRound = pathInShape(circleFrom, 61, 1)
const bubbleStretched = pathInShape(circleTo, 61, 1)
const bubbleHidden = bubbleRound.map(command => ({ ...command, values: command.values?.map((_, i) => i % 2 === 0 ? 10 / 62 : .5) }))
const shapeFrom = [...neckHidden, ...bubbleHidden]
const shapeTo = [...neckClosed, ...bubbleRound]
const shapeKeyframes = [
  { at: 0, path: shapeFrom },
  { at: .58, path: [...neckOpen, ...bubbleStretched] },
  { at: .86, path: [...blendPath(neckClosed, neckOpen, .28), ...bubbleStretched] },
  { at: 1, path: shapeTo }
]
type WindowColors = { background: string; text: string; secondary: string }
const defaultColors: WindowColors = { background: "#191c22", text: "#f5f7fa", secondary: "#b8c1cb" }

function content(state: ViewState, open: boolean, shapesReady: boolean, hovered: boolean, iconVisible: boolean, phase: number, colors: WindowColors): string {
  const listening = state.recording || state.starting
  const level = Number.isFinite(state.level) ? Math.max(0, Math.min(1, state.level!)) : 0
  const bars = Array.from({ length: 13 }, (_, i) => {
    const envelope = .4 + .6 * Math.sin(Math.PI * (i + 1) / 14)
    const motion = .35 + .65 * (1 + Math.sin(phase * .55 - i * .72)) / 2
    return { type: "view", key: `bar-${i}`, props: { transition: { properties: ["height"], duration: 100, curve: "easeInOut" }, animation: { type: "pulse", duration: 850 + i * 73 }, style: { width: 3, height: 3 + envelope * motion * (2 + level * 17), borderRadius: 3, backgroundColor: colors.text } } }
  })
  const body = state.result
    ? { type: "column", props: { style: { left: 18, right: 18, top: 18, bottom: 18, gap: 10, alignItems: "stretch" } }, children: [
      { type: "text", props: { text: state.status, style: { color: colors.secondary, fontSize: 14, maxLines: 2, margin: { right: 35 } } } },
      { type: "scroll", key: "result-scroll", props: { style: { flex: 1 } }, children: [{ type: "text", key: "result-text", props: { text: state.text || "", selectable: true, style: { color: colors.text, fontSize: 15 } } }] },
      { type: "row", props: { style: { justifyContent: "end" } }, children: [{ type: "button", key: "copy", props: { label: "Copy", onPress: { $handler: "copy" } } }] }
    ] }
    : { type: "column", props: { style: { left: 8, right: listening ? 8 : 30, top: 0, bottom: 0, alignItems: "stretch", justifyContent: "center" } }, children: [
      { type: "row", props: { style: { gap: 8, alignItems: "center", justifyContent: "center" } }, children: listening
        ? [{ type: "row", key: "wave", props: { label: state.starting ? "Preparing microphone" : "Stop dictation", onPress: { $handler: "stop" }, style: { width: 110, padding: { vertical: 8 }, gap: 4, alignItems: "center", justifyContent: "center" } }, children: bars }]
        : [...(state.busy ? [{ type: "loading", props: { style: { width: 16, height: 16, color: colors.text } } }] : []), { type: "text", props: { text: state.status, style: { color: colors.secondary, fontSize: 12, maxLines: 2, textAlign: "center" } } }] }
    ] }
  const height = state.result ? 300 : compactHeight
  return JSON.stringify({ version: 1, root: { type: "stack", props: { style: { width: state.result ? 440 : windowWidth, height } }, children: [
    ...(!state.result && shapesReady ? [{ type: "morph-path", key: "close-shape", props: { keyframes: shapeKeyframes, progress: hovered ? 1 : 0, duration: hovered ? splitDuration : mergeDuration, curve: "linear", style: { left: 144, top: 0, width: 62, height: 40, color: colors.background } } }] : []),
    { type: "stack", key: "panel", props: { onHoverChange: { $handler: "hover" }, transition: { properties: ["scale", "opacity"], duration: animationDuration, curve: "easeInOut" }, style: { left: 0, top: 0, width: state.result ? 440 : compactWidth, height, borderRadius: state.result ? 12 : 20, backgroundColor: colors.background, scale: open ? 1 : .05, opacity: open ? 1 : 0, overflow: "hidden" } }, children: [body,
      ...(state.result && hovered ? [{ type: "icon-button", key: "cancel-result", props: { icon: "control.close", iconColorMode: "tint", label: state.busy ? "Cancel dictation" : "Close", onPress: { $handler: "cancel" }, enter: { type: "fade", duration: 140 }, exit: { type: "fade", duration: 140 }, style: { right: 8, top: 12, width: 28, height: 28, color: colors.text } } }] : [])
    ] },
    ...(!state.result && hovered && shapesReady ? [{ type: "view", key: "hover-gap", props: { inputRegion: true, onHoverChange: { $handler: "hover" }, style: { left: 164, top: 0, width: 10, height: 40 } } }] : []),
    ...(!state.result && shapesReady ? [{ type: "stack", key: "close-position", props: { transition: { properties: ["width"], duration: hovered ? splitDuration : mergeDuration, curve: "easeInOut" }, style: { left: 0, top: 0, width: hovered ? 206 : 178, height: 40 } }, children: [
      { type: "icon-button", key: "cancel", props: { icon: "control.close", iconColorMode: "tint", label: state.busy ? "Cancel dictation" : "Close", disabled: !hovered || !iconVisible, onPress: { $handler: "cancel" }, onHoverChange: { $handler: "hover" }, transition: { properties: ["opacity"], duration: 100, curve: "easeInOut" }, style: { right: 0, top: 4, width: 32, height: 32, borderRadius: 16, backgroundColor: "#00000000", color: colors.text, opacity: open && hovered && iconVisible ? 1 : 0 } } }
    ] }] : [])
  ] } })
}

export class DictationWindow {
  private generation = 0
  private window?: WoxViewWindow
  private creating?: Promise<void>
  private visibility = 0
  private visible = false
  private visibilityTask: Promise<void> = Promise.resolve()
  private expanded = false
  private resizing: Promise<void> = Promise.resolve()
  private posting: Promise<void> = Promise.resolve()
  private revision = 0
  private sequence = 0
  private cancelHide?: () => void
  private iconTimer?: ReturnType<typeof setTimeout>
  private appearTimer?: ReturnType<typeof setTimeout>
  private hoverTimer?: ReturnType<typeof setTimeout>
  private hoverLeaveTimer?: ReturnType<typeof setTimeout>
  private hoverRevision = 0
  private hovered = false
  private activeHover = false
  private shapesReady = false
  private hoverReady = false
  private iconVisible = false
  private colors = defaultColors
  private phase = 0
  private state: ViewState = { status: "Dictation" }
  onCommand: (command: string) => Promise<void> = async () => {}
  constructor(readonly api: PublicAPI, readonly ctx: Context) {}

  async prepare(): Promise<void> {
    if (!this.window && !this.creating) this.creating = this.create().finally(() => { this.creating = undefined })
    await this.creating
  }

  async show(activate = true): Promise<void> {
    const visibility = ++this.visibility
    this.cancelHide?.()
    const task = this.visibilityTask.catch(() => {}).then(async () => {
      await this.prepare()
      if (visibility !== this.visibility) return
      await this.posting.catch(() => {})
      const opening = !this.visible
      if (opening) await this.send(this.window!, this.state, false)
      if (visibility !== this.visibility) return
      const result = await this.window!.Show(this.ctx, { Activate: activate })
      if (!result.Success) throw new Error(result.ErrMsg || "Cannot show Dictation window")
      if (visibility !== this.visibility) return
      this.visible = true
      await this.update(this.state)
      if (!this.hoverReady && visibility === this.visibility) {
        clearTimeout(this.appearTimer)
        clearTimeout(this.hoverTimer)
        this.appearTimer = setTimeout(() => {
          if (!this.visible || visibility !== this.visibility) return
          this.shapesReady = true
          void this.update(this.state).then(() => {
            if (!this.visible || visibility !== this.visibility) return
            this.hoverTimer = setTimeout(() => {
              if (!this.visible || visibility !== this.visibility) return
              this.hoverReady = true
              if (this.hovered) void this.animateHover(true)
            }, 32)
          }).catch(error => this.logAnimationError(error))
        }, animationDuration + 40)
      }
    })
    this.visibilityTask = task
    await task
  }

  async hide(): Promise<void> {
    const visibility = ++this.visibility
    this.cancelHide?.()
    const wasVisible = this.visible
    this.visible = false
    this.hovered = false
    this.hoverRevision++
    this.activeHover = false
    this.shapesReady = false
    this.hoverReady = false
    this.iconVisible = false
    clearTimeout(this.iconTimer)
    clearTimeout(this.appearTimer)
    clearTimeout(this.hoverTimer)
    clearTimeout(this.hoverLeaveTimer)
    const task = this.visibilityTask.catch(() => {}).then(async () => {
      if (!this.window || visibility !== this.visibility) return
      if (wasVisible) {
        await this.posting.catch(() => {})
        if (!this.window || visibility !== this.visibility) return
        await this.send(this.window, this.state, false)
        if (visibility !== this.visibility) return
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { this.cancelHide = undefined; resolve() }, animationDuration)
          this.cancelHide = () => { clearTimeout(timer); this.cancelHide = undefined; resolve() }
        })
      }
      if (!this.window || visibility !== this.visibility) return
      const result = await this.window.Hide(this.ctx, {})
      if (!result.Success) throw new Error(result.ErrMsg || "Cannot hide Dictation window")
    })
    this.visibilityTask = task
    await task
  }

  private async create(): Promise<void> {
    const generation = ++this.generation
    await this.refreshColors()
    const api = this.api as unknown as { CreateWindow(ctx: Context, option: Omit<CreateWindowOption, "Content" | "Window"> & { Window: NonNullable<CreateWindowOption["Window"]> & { Transparent: boolean; PassThroughTransparent?: boolean }; Content: { Type: "woxview"; Data: string } }): Promise<{ Success: boolean; ErrMsg?: string; Window?: WoxViewWindow }> }
    const result = await api.CreateWindow(this.ctx, {
      Window: { Title: "Dictation", Presentation: "overlay", Width: windowWidth, Height: compactHeight, Anchor: "bottom-center", OffsetX: (windowWidth - compactWidth) / 2, OffsetY: -60, Topmost: true, Focusable: true, Resizable: false, Movable: true, HideChrome: true, DragContent: true, Closable: true, Transparent: true, PassThroughTransparent: process.platform === "win32" },
      Content: { Type: "woxview", Data: content(this.state, false, false, false, false, this.phase, this.colors) },
      OnEvent: async (_ctx, event) => {
        if (generation !== this.generation) return
        if (event.Type === "error") {
          void this.onCommand("cancel").catch(() => {})
          await this.api.ShowToastMsg(this.ctx, { Message: event.ErrMsg || "Dictation window failed" })
        }
        if (event.Type === "closed") {
          this.visible = false
          this.window = undefined
          this.hovered = false
          this.hoverRevision++
          this.activeHover = false
          this.shapesReady = false
          this.hoverReady = false
          this.iconVisible = false
          clearTimeout(this.iconTimer)
          clearTimeout(this.appearTimer)
          clearTimeout(this.hoverTimer)
          clearTimeout(this.hoverLeaveTimer)
          void this.onCommand("cancel").catch(() => {})
        }
        if ((event.Type as string) === "theme_changed") {
          await this.refreshColors()
          if (generation === this.generation && this.visible) await this.update(this.state)
        }
        if ((event.Type as string) === "woxview_event") {
          const data = event.Data as { Handler?: string; Args?: unknown[] } | undefined
          if (data?.Handler === "hover" && typeof data.Args?.[0] === "boolean" && this.visible) {
            clearTimeout(this.hoverLeaveTimer)
            if (data.Args[0]) {
              if (!this.hovered) {
                this.hovered = true
                if (this.hoverReady) await this.animateHover(true)
              }
            } else {
              // Allow the pointer to cross the transparent gap between the panel and close button.
              this.hoverLeaveTimer = setTimeout(() => {
                if (!this.visible || !this.hovered) return
                this.hovered = false
                if (this.hoverReady) void this.animateHover(false)
              }, hoverLeaveDelay)
            }
          }
          if (data?.Handler && ["stop", "cancel", "copy"].includes(data.Handler)) void this.onCommand(data.Handler).catch(() => {})
        }
      }
    })
    if (!result.Success || !result.Window) throw new Error(result.ErrMsg || "Unable to open the dictation window")
    if (generation !== this.generation) {
      await result.Window.Close(this.ctx, {})
      throw new Error("Window creation cancelled")
    }
    this.window = result.Window
    this.sequence = 0
    this.expanded = false
    await this.update(this.state)
  }

  async update(state: ViewState): Promise<void> {
    if (state.recording && Number.isFinite(state.level)) this.phase++
    if (state.recording && state.level === undefined && this.state.recording) state = { ...state, level: this.state.level }
    this.state = state
    const revision = ++this.revision
    if (this.window && this.expanded !== !!state.result) {
      this.expanded = !!state.result
      const window = this.window
      const expanded = this.expanded
      this.resizing = this.resizing.catch(() => {}).then(async () => {
        const result = await window.SetOptions(this.ctx, expanded ? { Width: 440, Height: 300 } : { Width: windowWidth, Height: compactHeight })
        if (!result.Success) throw new Error(result.ErrMsg || "Window resize failed")
      })
      await this.resizing
    }
    if (this.window && this.visible) {
      const window = this.window
      const visibility = this.visibility
      this.posting = this.posting.catch(() => {}).then(async () => {
        if (revision !== this.revision || window !== this.window || !this.visible || visibility !== this.visibility) return
        try {
          await this.send(window, state, true)
        } catch (error) {
          if (revision === this.revision && window === this.window && this.visible && visibility === this.visibility) throw error
        }
      })
      await this.posting
    }
  }
  private async send(window: WoxViewWindow, state: ViewState, open: boolean): Promise<void> {
    const result = await window.Content.Update(this.ctx, { Data: content(state, open, this.shapesReady, this.activeHover, this.iconVisible, this.phase, this.colors), Sequence: ++this.sequence })
    if (!result.Success) throw new Error(result.ErrMsg || "Window update failed")
  }
  private async refreshColors(): Promise<void> {
    try {
      const colors = await this.api.GetThemeColors(this.ctx, {})
      const safe = (color: string, fallback: string) => /^#[0-9a-f]{6}$/i.test(color) ? color : fallback
      this.colors = { background: safe(colors.Background, defaultColors.background), text: safe(colors.Text, defaultColors.text), secondary: safe(colors.SecondaryText, defaultColors.secondary) }
    } catch { /* Keep the last valid palette if the theme is unavailable. */ }
  }
  private async animateHover(hovered: boolean): Promise<void> {
    if (!this.visible || !this.hoverReady || this.hovered !== hovered) return
    const revision = ++this.hoverRevision
    this.activeHover = hovered
    clearTimeout(this.iconTimer)
    this.iconVisible = false
    try {
      await this.update(this.state)
      if (!this.visible || !this.hoverReady || this.hoverRevision !== revision || this.state.result) return
      if (hovered) this.iconTimer = setTimeout(() => {
        if (!this.visible || this.hoverRevision !== revision || !this.hovered || this.state.result) return
        this.iconVisible = true
        void this.update(this.state).catch(error => this.logAnimationError(error))
      }, splitDuration)
    } catch (error) { await this.logAnimationError(error) }
  }
  private async logAnimationError(error: unknown): Promise<void> {
    await this.api.Log(this.ctx, "Warning", `Dictation window animation: ${String(error)}`).catch(() => {})
  }
  async close(): Promise<void> { await this.hide() }

  async destroy(): Promise<void> {
    await this.hide()
    this.generation++
    this.revision++
    this.expanded = false
    const window = this.window
    this.window = undefined
    if (window) await window.Close(this.ctx, {})
  }
}
