import type { Context, HotkeyEvent, PublicAPI } from "@wox-launcher/wox-plugin"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { exists, models } from "./downloads"
import type { Engine } from "./engine"
import { chat, cleanTranscript, expandPrompt, parseModel, refineInput, refinePrompt, sanitize } from "./refine"
import { recentContext, type Action, type Store } from "./store"
import type { DictationWindow } from "./window"
import { MediaPause } from "./media"
import { TextInsert, type InputTarget } from "./insert"

export type State = "idle" | "starting" | "recording" | "stopping" | "processing"
const processingIndicatorDelay = 500
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
  private captureTask?: Promise<void>
  private captureStopping?: AbortController
  private warmupOperation?: AbortController
  private warmupTask?: Promise<void>
  private targetPid?: number
  private captureError = ""
  private trace?: { id: string; startedAt: number }
  private timing(trace: { id: string; startedAt: number }, stage: string, details = ""): void {
    const now = Date.now()
    void this.api.Log(this.ctx, "Info", `[Dictation timing] session=${trace.id} stage=${stage} atMs=${now} elapsedMs=${now - trace.startedAt}${details ? ` ${details}` : ""}`).catch(() => {})
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
      if (event.event === "capture_gap") void api.ShowToastMsg(ctx, { Message: "Audio capture was interrupted; the transcript may be missing some words." }).catch(() => {})
      if (event.event === "limit") void this.stop().catch(error => this.fail(error))
      if (event.event === "error" && this.operation && !this.operation.signal.aborted) void this.fail(event.data)
      if (event.event === "partial" && this.state === "recording") this.text = String(event.data)
      if ((event.event === "level" || event.event === "partial") && this.state === "recording") {
        const operation = this.operation
        void view.update({ status: "Listening…", text: this.text, recording: true, busy: true, ...(event.event === "level" ? { level: Number(event.data) } : {}) }).catch(async error => {
          if (operation && this.operation === operation && !operation.signal.aborted && this.state === "recording") await this.fail(error)
        })
      }
    }
  }

  warmup(): void {
    if (this.warmupTask || this.state !== "idle") return
    const operation = new AbortController()
    const model = models.find(m => m.id === this.store.settings.model) || models[0]
    this.warmupOperation = operation
    const task = (async () => {
      if (!(await exists(join(this.engine.downloads.runtimePath(), ".complete"))) || !(await exists(join(this.engine.downloads.modelPath(model), ".complete")))) return
      operation.signal.throwIfAborted()
      await this.engine.prepare(operation.signal, () => {})
      operation.signal.throwIfAborted()
      await this.engine.preload(model, this.store.settings.modelLoadMode !== "lazy")
      operation.signal.throwIfAborted()
      if (this.store.settings.keepMicrophoneReady !== "false") await this.engine.warmMicrophone(this.store.settings.inputDevice || "")
    })().catch(error => {
      if (!operation.signal.aborted) void this.api.Log(this.ctx, "Warning", `Could not prewarm dictation: ${String(error)}`).catch(() => {})
    }).finally(() => {
      if (this.warmupTask === task) {
        this.warmupTask = undefined
        this.warmupOperation = undefined
      }
    })
    this.warmupTask = task
  }

  cancelWarmup(): void {
    if (!this.warmupOperation) return
    this.warmupOperation.abort()
    this.warmupOperation = undefined
    this.warmupTask = undefined
    this.engine.dispose("prewarm cancelled")
  }

  // Release is matched to its own recording, including release while models are loading.
  async onHotkey(event: HotkeyEvent): Promise<void> {
    if (event.Phase === "ended") {
      if (event.ActivationID !== this.hotkeyActivation) return
      if (this.trace) this.timing(this.trace, "hotkey_ended", `eventToPluginMs=${Date.now() - event.Timestamp} reason=${event.EndReason || "unknown"}`)
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
      if (this.trace) this.timing(this.trace, "hotkey_stop", `eventToPluginMs=${Date.now() - event.Timestamp}`)
      await this.stop()
      return
    }
    if (this.state !== "idle") return
    await this.start(action, "", event.Phase === "started" ? event.ActivationID : "", event.Env?.ActiveWindowPid, false, event.Timestamp, event.Kind)
  }

  async start(action: Action, selection = "", activationID = "", targetPid?: number, captureAfterHide = false, hotkeyTime?: number, hotkeyKind?: string): Promise<void> {
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
    const startedAt = Date.now()
    const trace = { id: randomUUID(), startedAt }
    this.trace = trace
    const eventDelay = hotkeyTime && hotkeyTime > 0 ? startedAt - hotkeyTime : undefined
    this.timing(trace, "start_received", `source=${hotkeyKind || "action"} eventToPluginMs=${eventDelay ?? "unknown"} sound=${this.store.settings.playSound === "true"} keepMic=${this.store.settings.keepMicrophoneReady !== "false"}`)
    const capture = () => action.output === "input" ? this.insertion.capture(targetPid, operation.signal).catch(async error => {
      if (!operation.signal.aborted) {
        this.captureError = String(error)
        await this.api.Log(this.ctx, "Warning", `Could not capture dictation input target: ${this.captureError}`).catch(() => {})
      }
      return undefined
    }) : Promise.resolve(undefined)
    let startupMessage = this.engine.isModelLoaded(model) ? "Preparing microphone…" : "Loading speech engine…"
    let showStartupMessage = false
    let startupTimer: NodeJS.Timeout | undefined
    const progress = (message: string) => {
      startupMessage = message
      if (showStartupMessage && this.operation === operation && this.state === "starting" && !operation.signal.aborted)
        void this.view.update({ status: message, busy: true }).catch(() => {})
    }
    try {
      const modelReady = await this.engine.downloads.ready(model)
      operation.signal.throwIfAborted()
      if (!modelReady) {
        this.operation = undefined
        this.hotkeyActivation = ""
        this.state = "idle"
        await this.api.ShowToastMsg(this.ctx, { Message: "Error: Download a speech model first: dictate model" })
        return
      }
      startupTimer = setTimeout(() => {
        if (this.operation !== operation || this.state !== "starting" || operation.signal.aborted) return
        showStartupMessage = true
        void this.view.update({ status: startupMessage, busy: true }).catch(() => {})
      }, 800)
      const capturing = (async () => {
        if (captureAfterHide) {
          await this.api.HideApp(this.ctx)
          operation.signal.throwIfAborted()
        }
        const target = await capture()
        if (operation.signal.aborted) {
          this.insertion.release(target)
          operation.signal.throwIfAborted()
        }
        this.target = target
        this.timing(trace, "target_capture_complete", `available=${!!target}`)
      })()
      this.captureTask = capturing
      const showing = (async () => {
        await this.view.update({ status: "Preparing…", starting: true, busy: true, level: 0 })
        operation.signal.throwIfAborted()
        await this.view.show(false)
        this.timing(trace, "window_show_requested")
      })()
      const presentation = Promise.all([capturing, showing]).then(async () => {
        operation.signal.throwIfAborted()
        if (this.operation !== operation || (this.state !== "starting" && this.state !== "recording")) return
        if (!captureAfterHide) await this.api.HideApp(this.ctx)
        operation.signal.throwIfAborted()
        if (this.operation === operation && (this.state === "starting" || this.state === "recording")) await this.view.show()
      })
      // Attach a handler immediately while audio startup runs independently.
      void presentation.catch(() => {})
      this.timing(trace, "model_check_complete", `warmupPending=${!!this.warmupTask}`)
      operation.signal.throwIfAborted()
      await this.warmupTask
      this.timing(trace, "warmup_wait_complete")
      operation.signal.throwIfAborted()
      await this.engine.downloads.finishMigratedModel(model, operation.signal, progress)
      await this.engine.prepare(operation.signal, progress)
      this.timing(trace, "engine_prepared")
      operation.signal.throwIfAborted()
      if (this.engine.isModelLoaded(model)) progress("Preparing microphone…")
      if (this.store.settings.duckVolume === "true") await this.media.pause(operation.signal)
      this.timing(trace, "media_ready", `pauseEnabled=${this.store.settings.duckVolume === "true"}`)
      operation.signal.throwIfAborted()
      this.timing(trace, "engine_start_requested")
      await this.engine.start(model, this.store.settings.inputDevice || "", this.store.settings.playSound === "true", hotkeyTime || startedAt, this.store.settings.duckVolume !== "true", this.store.settings.keepMicrophoneReady !== "false", trace.id, trace.startedAt)
      operation.signal.throwIfAborted()
      this.timing(trace, "recording_started")
      void this.api.Log(this.ctx, "Info", `[Dictation] Microphone started in ${Date.now() - startedAt}ms`).catch(() => {})
      this.state = "recording"
      this.maximum = setTimeout(() => {
        void this.stop().catch(error => this.fail(error))
      }, 300000)
      await this.view.update({ status: "Listening…", recording: true, busy: true })
      await presentation
    } catch (error) {
      this.timing(trace, "start_failed", `aborted=${operation.signal.aborted}`)
      if (!operation.signal.aborted && this.operation === operation) await this.fail(error)
    } finally {
      clearTimeout(startupTimer)
    }
  }

  // A release during startup cancels. Stop is single-flight and captures a short trailing tail.
  async stop(): Promise<void> {
    const trace = this.trace
    if (trace) this.timing(trace, "stop_requested", `state=${this.state}`)
    this.hotkeyActivation = ""
    if (this.state === "starting") {
      await this.cancel()
      return
    }
    if (this.state !== "recording" || !this.operation) return
    const operation = this.operation,
      action = this.action!
    this.state = "stopping"
    this.captureStopping = operation
    clearTimeout(this.maximum)
    let processingTimer: NodeJS.Timeout | undefined
    let processingActive = true
    let processingVisible = false
    let statusRevision = 0
    let processingStatus = { key: "plugin_dictation_processing", fallback: "Processing dictation…" }
    const finishProcessing = () => { processingActive = false; clearTimeout(processingTimer) }
    const publishProcessing = async () => {
      const revision = statusRevision
      const { key, fallback } = processingStatus
      const status = await this.api.GetTranslation(this.ctx, key).catch(() => fallback)
      if (!processingActive || operation.signal.aborted || this.operation !== operation || revision !== statusRevision) return
      await this.view.update({ status: status || fallback, busy: true })
    }
    const updateProcessing = (key: string, fallback: string) => {
      processingStatus = { key, fallback }
      statusRevision++
      if (processingVisible) void publishProcessing().catch(reportProcessingError)
    }
    const reportProcessingError = (error: unknown) => {
      if (processingActive && !operation.signal.aborted && this.operation === operation) void this.fail(error).catch(() => {})
    }
    try {
      await new Promise(resolve => setTimeout(resolve, 250))
      operation.signal.throwIfAborted()
      processingTimer = setTimeout(() => {
        if (!processingActive || operation.signal.aborted || this.operation !== operation) return
        processingVisible = true
        void publishProcessing().catch(reportProcessingError)
      }, processingIndicatorDelay)
      await this.engine.stopCapture(this.store.settings.keepMicrophoneReady !== "false")
      operation.signal.throwIfAborted()
      if (this.captureStopping === operation) this.captureStopping = undefined
      if (trace) this.timing(trace, "capture_stopped")
      void this.engine.feedback("stop", trace?.id, trace?.startedAt).catch(() => {})
      if (trace) this.timing(trace, "media_resume_requested")
      void this.media.resume().then(() => { if (trace) this.timing(trace, "media_resume_completed") }).catch(() => {})
      operation.signal.throwIfAborted()
      if (trace) this.timing(trace, "asr_finalize_requested")
      const original = cleanTranscript(await this.engine.stop(this.store.settings.modelLoadMode !== "lazy"))
      if (trace) this.timing(trace, "asr_finalize_completed")
      operation.signal.throwIfAborted()
      this.text = original
      this.state = "processing"
      if (!original) {
        operation.abort()
        this.insertion.release(this.target)
        this.target = undefined
        this.state = "idle"
        this.operation = undefined
        this.hotkeyActivation = ""
        await this.view.close()
        return
      }
      let text = original
      if (this.store.actions[0].aiRefineEnabled ?? this.store.settings.defaultAIRefineEnabled === "true") {
        try {
          if (trace) this.timing(trace, "ai_refine_started")
          const model = parseModel(this.store.actions[0].model || this.store.settings.defaultAIModel)
          updateProcessing("plugin_dictation_ai_refining", "Refining with AI…")
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
          if (trace) this.timing(trace, "ai_refine_completed")
        } catch (error) {
          if (trace) this.timing(trace, "ai_refine_failed", `aborted=${operation.signal.aborted}`)
          operation.signal.throwIfAborted()
          await this.api.ShowToastMsg(this.ctx, { Message: `AI refinement failed; keeping the transcript. ${String(error)}` })
        }
      }
      if (action.type === "custom" && action.prompt.trim()) {
        try {
          if (trace) this.timing(trace, "action_ai_started")
          const model = parseModel(action.model || this.store.settings.defaultAIModel)
          updateProcessing("plugin_dictation_action_ai_processing", "Processing with AI…")
          text = await chat(
            this.api,
            this.ctx,
            model,
            "Follow the user's transformation instructions. Return only the result.",
            expandPrompt(action.prompt, text, this.selection),
            operation.signal
          )
          if (trace) this.timing(trace, "action_ai_completed")
        } catch (error) {
          if (trace) this.timing(trace, "action_ai_failed", `aborted=${operation.signal.aborted}`)
          operation.signal.throwIfAborted()
          await this.store.addHistory(original, original)
          throw error
        }
      }
      operation.signal.throwIfAborted()
      if (!text.trim()) throw new Error("The action returned no text")
      this.text = text
      if (trace) this.timing(trace, "history_save_started")
      await this.store.addHistory(text, original)
      if (trace) this.timing(trace, "history_save_completed")
      operation.signal.throwIfAborted()
      finishProcessing()
      if (trace) this.timing(trace, "output_ready")
      let inserted = false
      if (action.output === "input") {
        try {
          await this.captureTask
          operation.signal.throwIfAborted()
          await this.view.hide()
          // Give the previous window time to regain focus before checking it.
          await new Promise(resolve => setTimeout(resolve, 150))
          operation.signal.throwIfAborted()
          if (trace) this.timing(trace, "insert_requested")
          inserted = await this.insertion.insert(this.target, text, operation.signal, trace)
          if (trace) this.timing(trace, "insert_completed", `inserted=${inserted}`)
        } catch (error) {
          if (trace) this.timing(trace, "insert_failed", `aborted=${operation.signal.aborted}`)
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
      if (inserted || fallbackCopied) {
        await this.view.close()
        if (fallbackCopied) {
          const permission = this.captureError.includes("macOS Accessibility permission is required")
          const key = permission ? "plugin_dictation_insert_accessibility" : "plugin_dictation_insert_fallback"
          const fallback = permission ? "Copied to clipboard. Allow Accessibility access for Wox and its Node.js runtime in System Settings, then try again." : "Could not insert automatically. Copied to clipboard."
          const message = await this.api.GetTranslation(this.ctx, key).catch(() => fallback)
          await this.api.ShowToastMsg(this.ctx, { Message: message && (!permission || message !== key) ? message : fallback })
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
      finishProcessing()
      if (!operation.signal.aborted) await this.fail(error)
    } finally {
      if (this.captureStopping === operation) this.captureStopping = undefined
      finishProcessing()
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
    const detail = String(error)
    const microphone = detail.includes("MICROPHONE_UNAVAILABLE:")
    this.operation?.abort()
    this.cancelWarmup()
    this.insertion.release(this.target)
    this.target = undefined
    this.operation = undefined
    this.hotkeyActivation = ""
    clearTimeout(this.maximum)
    this.engine.dispose(`controller failure state=${this.state}`)
    await this.media.resume()
    this.state = "idle"
    let message = detail
    if (microphone) {
      void this.api.Log(this.ctx, "Warning", `Microphone error: ${detail}`).catch(() => {})
      const threading = /RPC_E_CHANGED_MODE|2147417850|0x80010106/i.test(detail)
      const key = threading ? "plugin_dictation_audio_init_failed" : "plugin_dictation_microphone_unavailable"
      const fallback = threading ? "Could not initialize audio. Please try again; if the problem continues, restart Wox." : "Microphone unavailable. Check its connection and Dictation input device, then try again."
      const translated = await this.api.GetTranslation(this.ctx, key).catch(() => fallback)
      message = translated && translated !== key ? translated : fallback
    }
    if (microphone && !this.text) await this.view.close().catch(() => {})
    else await this.view.update({ status: message, text: this.text, result: !!this.text }).catch(() => {})
    await this.api.ShowToastMsg(this.ctx, { Message: message })
  }
  async cancel(restoreFocus = false): Promise<void> {
    if (this.cancelTask) return this.cancelTask
    this.cancelTask = this.cancelSession(restoreFocus).finally(() => { this.cancelTask = undefined })
    return this.cancelTask
  }
  private async cancelSession(restoreFocus: boolean): Promise<void> {
    const state = this.state
    const operation = this.operation
    const cancellingCapture = !!operation && (state === "recording" || (state === "stopping" && this.captureStopping === operation))
    const trace = this.trace
    const targetPid = this.targetPid
    this.targetPid = undefined
    this.state = "stopping"
    this.operation?.abort()
    this.cancelWarmup()
    this.insertion.release(this.target)
    this.target = undefined
    this.operation = undefined
    this.hotkeyActivation = ""
    clearTimeout(this.maximum)
    if (cancellingCapture) void this.engine.feedback("stop", trace?.id, trace?.startedAt).catch(() => {})
    if (state === "starting" || (state === "stopping" && !cancellingCapture)) this.engine.dispose(`controller cancel state=${state}`)
    const cancelEngine = cancellingCapture
      ? this.engine.cancel(this.store.settings.modelLoadMode !== "lazy", this.store.settings.keepMicrophoneReady !== "false").catch(() => this.engine.dispose("cancel failed"))
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
      if (state === "starting" || (state === "stopping" && !cancellingCapture)) this.warmup()
    }
  }
}
