import type { Context, HotkeyEvent, PublicAPI } from "@wox-launcher/wox-plugin"
import { models } from "./downloads"
import type { Engine } from "./engine"
import { chat, cleanTranscript, expandPrompt, parseModel, refineInput, refinePrompt, sanitize } from "./refine"
import { recentContext, type Action, type Store } from "./store"
import type { DictationWindow } from "./window"
import { MediaPause } from "./media"
import { TextInsert, type InputTarget } from "./insert"

export type State = "idle" | "starting" | "recording" | "stopping" | "processing"
export class Controller {
  state: State = "idle"
  private operation?: AbortController
  private downloadOperation?: AbortController
  private cancelTask?: Promise<void>
  private hotkeyActivation = ""
  private action?: Action
  private selection = ""
  private maximum?: NodeJS.Timeout
  private text = ""
  private readonly media: MediaPause
  private readonly insertion: TextInsert
  private target?: InputTarget
  private targetPid?: number
  private captureError = ""
  private async showProcessing(operation: AbortController, key: string, fallback: string): Promise<void> {
    const status = await this.api.GetTranslation(this.ctx, key).catch(() => fallback)
    operation.signal.throwIfAborted()
    await this.view.update({ status: status || fallback, busy: true })
    operation.signal.throwIfAborted()
  }
  constructor(
    readonly api: PublicAPI,
    readonly ctx: Context,
    readonly store: Store,
    readonly engine: Engine,
    readonly view: DictationWindow
  ) {
    this.media = new MediaPause(api, ctx)
    this.insertion = new TextInsert(api, ctx, engine.pluginDirectory)
    view.onCommand = async command => {
      try {
        if (command === "stop") await this.stop()
        if (command === "cancel") await this.cancel(true)
        if (command === "copy") await api.Copy(ctx, { type: "text", text: this.text })
      } catch (error) {
        await this.fail(error)
      }
    }
    engine.onEvent = event => {
      if (event.event === "diagnostic") void api.Log(ctx, "Info", `[Dictation engine] ${String(event.data)}`).catch(() => {})
      if (event.event === "warning") void api.Log(ctx, "Warning", String(event.data)).catch(() => {})
      if (event.event === "capture_gap") void api.Notify(ctx, "Audio capture was interrupted; the transcript may be missing some words.").catch(() => {})
      if (event.event === "limit") void this.stop().catch(error => this.fail(error))
      if (event.event === "error" && this.operation && !this.operation.signal.aborted) void this.fail(event.data)
      if (event.event === "partial" && this.state === "recording") this.text = String(event.data)
      if ((event.event === "level" || event.event === "partial") && this.state === "recording")
        void view.update({ status: "Listening…", text: this.text, recording: true, busy: true, ...(event.event === "level" ? { level: Number(event.data) } : {}) }).catch(error => this.fail(error))
    }
  }

  // Release is matched to its own recording, including release while models are loading.
  async onHotkey(event: HotkeyEvent): Promise<void> {
    if (event.Phase === "ended") {
      if (event.ActivationID !== this.hotkeyActivation) return
      this.hotkeyActivation = ""
      if (event.EndReason === "released") await this.stop()
      else await this.cancel()
      return
    }
    const action =
      event.SettingKey === "defaultHotkey"
        ? this.store.actions[0]
        : event.SettingKey === "actions" && event.ColumnKey === "hotkey"
          ? this.store.actions.find(item => item.id === event.ItemID && !item.disabled)
          : undefined
    if (!action) return
    if (event.Phase === "triggered" && (this.state === "starting" || this.state === "recording")) {
      await this.stop()
      return
    }
    if (this.state !== "idle") return
    await this.start(action, "", event.Phase === "started" ? event.ActivationID : "", event.Env?.ActiveWindowPid)
  }

  async start(action: Action, selection = "", activationID = "", targetPid?: number, captureAfterHide = false): Promise<void> {
    if (this.state !== "idle") throw new Error("Dictation is already busy")
    if (action.output === "chat") throw new Error("AI Chat output is unavailable. Choose the result window or clipboard instead.")
    if (action.prompt.includes("{wox:selected_text}") && !selection) throw new Error("This action requires a text selection query")
    const model = models.find(m => m.id === this.store.settings.model) || models[0]
    const operation = new AbortController()
    this.operation = operation
    this.hotkeyActivation = activationID
    this.state = "starting"
    this.action = action
    this.selection = selection
    this.text = ""
    this.target = undefined
    this.targetPid = targetPid
    this.captureError = ""
    const capture = () => action.output === "input" ? this.insertion.capture(targetPid, operation.signal).catch(async error => {
      if (!operation.signal.aborted) {
        this.captureError = String(error)
        await this.api.Log(this.ctx, "Warning", `Could not capture dictation input target: ${this.captureError}`).catch(() => {})
      }
      return undefined
    }) : Promise.resolve(undefined)
    try {
      if (!captureAfterHide) {
        const target = await capture()
        if (operation.signal.aborted) {
          this.insertion.release(target)
          operation.signal.throwIfAborted()
        }
        this.target = target
      }
      if (!(await this.engine.downloads.ready(model))) throw new Error("Download a speech model first: dictate model")
      operation.signal.throwIfAborted()
      await this.view.update({ status: this.engine.isModelLoaded(model) ? "Preparing microphone…" : "Loading speech engine…", busy: true })
      await this.api.HideApp(this.ctx)
      operation.signal.throwIfAborted()
      if (captureAfterHide) {
        const target = await capture()
        if (operation.signal.aborted) {
          this.insertion.release(target)
          operation.signal.throwIfAborted()
        }
        this.target = target
      }
      operation.signal.throwIfAborted()
      await this.view.show()
      operation.signal.throwIfAborted()
      await this.engine.downloads.finishMigratedModel(model, operation.signal, message => {
        void this.view.update({ status: message, busy: true }).catch(() => {})
      })
      await this.engine.prepare(operation.signal, message => {
        void this.view.update({ status: message, busy: true }).catch(() => {})
      })
      operation.signal.throwIfAborted()
      if (this.store.settings.duckVolume === "true") await this.media.pause(operation.signal)
      operation.signal.throwIfAborted()
      await this.engine.start(model, this.store.settings.inputDevice || "", this.store.settings.playSound === "true")
      operation.signal.throwIfAborted()
      this.state = "recording"
      await this.view.update({ status: "Listening…", recording: true, busy: true })
      void this.engine.feedback("start").catch(() => {})
      this.maximum = setTimeout(() => {
        void this.stop().catch(error => this.fail(error))
      }, 300000)
    } catch (error) {
      if (!operation.signal.aborted) await this.fail(error)
    }
  }

  // A release during startup cancels. Stop is single-flight and captures a short trailing tail.
  async stop(): Promise<void> {
    this.hotkeyActivation = ""
    if (this.state === "starting") {
      await this.cancel()
      return
    }
    if (this.state !== "recording" || !this.operation) return
    const operation = this.operation,
      action = this.action!
    this.state = "stopping"
    clearTimeout(this.maximum)
    try {
      await new Promise(resolve => setTimeout(resolve, 250))
      operation.signal.throwIfAborted()
      await this.showProcessing(operation, "plugin_dictation_processing", "Processing dictation…")
      await this.engine.stopCapture()
      await this.media.resume()
      operation.signal.throwIfAborted()
      const original = cleanTranscript(await this.engine.stop(this.store.settings.modelLoadMode === "eager"))
      operation.signal.throwIfAborted()
      this.text = original
      this.state = "processing"
      if (!original) {
        this.insertion.release(this.target)
        this.target = undefined
        this.state = "idle"
        this.operation = undefined
        this.hotkeyActivation = ""
        void this.engine.feedback("stop").catch(() => {})
        await this.view.update({ status: "No speech detected" })
        return
      }
      let text = original
      if (this.store.actions[0].aiRefineEnabled ?? this.store.settings.defaultAIRefineEnabled === "true") {
        try {
          const model = parseModel(this.store.actions[0].model || this.store.settings.defaultAIModel)
          await this.showProcessing(operation, "plugin_dictation_ai_refining", "Refining with AI…")
          const refined = await chat(
            this.api,
            this.ctx,
            model,
            refinePrompt,
            refineInput(original, recentContext(this.store.history), this.store.dictionary),
            operation.signal,
            15000
          )
          text = sanitize(original, refined) || original
        } catch (error) {
          operation.signal.throwIfAborted()
          await this.api.Notify(this.ctx, `AI refinement failed; keeping the transcript. ${String(error)}`)
        }
      }
      if (action.type === "custom" && action.prompt.trim()) {
        try {
          const model = parseModel(action.model || this.store.settings.defaultAIModel)
          await this.showProcessing(operation, "plugin_dictation_action_ai_processing", "Processing with AI…")
          text = await chat(
            this.api,
            this.ctx,
            model,
            "Follow the user's transformation instructions. Return only the result.",
            expandPrompt(action.prompt, text, this.selection),
            operation.signal
          )
        } catch (error) {
          operation.signal.throwIfAborted()
          await this.store.addHistory(original, original)
          throw error
        }
      }
      operation.signal.throwIfAborted()
      if (!text.trim()) throw new Error("The action returned no text")
      this.text = text
      await this.store.addHistory(text, original)
      operation.signal.throwIfAborted()
      let inserted = false
      if (action.output === "input") {
        try {
          await this.view.hide()
          // Give the previous window time to regain focus before checking it.
          await new Promise(resolve => setTimeout(resolve, 150))
          operation.signal.throwIfAborted()
          inserted = await this.insertion.insert(this.target, text, operation.signal)
        } catch (error) {
          operation.signal.throwIfAborted()
          await this.api.Log(this.ctx, "Warning", `Could not insert dictation: ${String(error)}`).catch(() => {})
        } finally {
          this.insertion.release(this.target)
          this.target = undefined
        }
        operation.signal.throwIfAborted()
      }
      let fallbackCopied = false
      if (action.output === "input" && !inserted) {
        try {
          await this.api.Copy(this.ctx, { type: "text", text })
          fallbackCopied = true
        } catch (error) {
          await this.api.Log(this.ctx, "Warning", `Could not copy dictation: ${String(error)}`).catch(() => {})
        }
        operation.signal.throwIfAborted()
      }
      if (action.output === "clipboard") await this.api.Copy(this.ctx, { type: "text", text })
      this.state = "idle"
      this.operation = undefined
      this.hotkeyActivation = ""
      void this.engine.feedback("stop").catch(() => {})
      if (inserted || fallbackCopied) {
        await this.view.close()
        if (fallbackCopied) {
          const permission = this.captureError.includes("macOS Accessibility permission is required")
          const key = permission ? "plugin_dictation_insert_accessibility" : "plugin_dictation_insert_fallback"
          const fallback = permission ? "Copied to clipboard. Allow Accessibility access for Wox and its Node.js runtime in System Settings, then try again." : "Could not insert automatically. Copied to clipboard."
          const message = await this.api.GetTranslation(this.ctx, key).catch(() => fallback)
          await this.api.Notify(this.ctx, message && (!permission || message !== key) ? message : fallback)
        }
        return
      }
      await this.view.update({
        status: action.output === "input" ? "Could not copy automatically. Click Copy to try again." : action.output === "clipboard" ? "Copied to clipboard" : "Ready",
        text,
        result: true
      })
      if (action.output === "input") await this.view.show()
    } catch (error) {
      if (!operation.signal.aborted) await this.fail(error)
    }
  }

  async download(modelId: string, progress: (message: string) => void): Promise<void> {
    if (this.downloadOperation) throw new Error("A model is already downloading")
    const model = models.find(m => m.id === modelId)
    if (!model) throw new Error("Unknown model")
    const operation = new AbortController()
    this.downloadOperation = operation
    try {
      await this.engine.downloads.runtime(operation.signal, progress)
      await this.engine.downloads.installModel(model, operation.signal, progress)
      operation.signal.throwIfAborted()
    } finally {
      if (this.downloadOperation === operation) this.downloadOperation = undefined
    }
  }

  cancelDownload(): void {
    this.downloadOperation?.abort()
  }

  async fail(error: unknown): Promise<void> {
    this.operation?.abort()
    this.insertion.release(this.target)
    this.target = undefined
    this.operation = undefined
    this.hotkeyActivation = ""
    clearTimeout(this.maximum)
    this.engine.dispose(`controller failure state=${this.state}`)
    await this.media.resume()
    this.state = "idle"
    await this.view.update({ status: String(error), text: this.text, result: !!this.text }).catch(() => {})
    await this.api.Notify(this.ctx, String(error))
  }
  async cancel(restoreFocus = false): Promise<void> {
    if (this.cancelTask) return this.cancelTask
    this.cancelTask = this.cancelSession(restoreFocus).finally(() => { this.cancelTask = undefined })
    return this.cancelTask
  }
  private async cancelSession(restoreFocus: boolean): Promise<void> {
    const state = this.state
    const targetPid = this.targetPid
    this.targetPid = undefined
    this.state = "stopping"
    this.operation?.abort()
    this.insertion.release(this.target)
    this.target = undefined
    this.operation = undefined
    this.hotkeyActivation = ""
    clearTimeout(this.maximum)
    if (state === "starting" || state === "stopping") this.engine.dispose(`controller cancel state=${state}`)
    const cancelEngine = state === "recording"
      ? this.engine.cancel(this.store.settings.modelLoadMode === "eager").catch(() => this.engine.dispose("cancel failed"))
      : Promise.resolve()
    const closeWindow = async () => {
      await this.view.close()
      if (restoreFocus && state !== "idle") {
        await this.insertion.restoreFocus(targetPid).catch(error => this.api.Log(this.ctx, "Warning", `Could not restore dictation focus: ${String(error)}`).catch(() => {}))
      }
    }
    try {
      await Promise.all([cancelEngine, this.media.resume(), closeWindow()])
    } finally {
      await cancelEngine
      this.state = "idle"
    }
  }
}
