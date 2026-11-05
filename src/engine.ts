import { spawn, type ChildProcess } from "node:child_process"
import { delimiter, join } from "node:path"
import { Downloads, platformPackage, type Model, type Progress } from "./downloads"

export interface EngineEvent {
  event: string
  data: unknown
}
export interface Device {
  deviceId: string
  name: string
}
export class Engine {
  private child?: ChildProcess
  private nextId = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private idle?: NodeJS.Timeout
  private loadedModel?: string
  onEvent: (event: EngineEvent) => void = () => {}
  constructor(
    readonly downloads: Downloads,
    readonly pluginDirectory: string
  ) {}

  async prepare(signal: AbortSignal, progress: Progress): Promise<void> {
    clearTimeout(this.idle)
    const runtime = await this.downloads.runtime(signal, progress)
    signal.throwIfAborted()
    if (this.child) {
      this.onEvent({ event: "diagnostic", data: `engine reuse pid=${this.child.pid} connected=${this.child.connected}` })
      return
    }
    const lib = join(runtime, "node_modules", platformPackage())
    const child = spawn(process.execPath, [join(this.pluginDirectory, "engine-worker.js")], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        DICTATION_RUNTIME: runtime,
        LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter),
        DYLD_LIBRARY_PATH: [lib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(delimiter)
      }
    })
    this.child = child
    this.onEvent({ event: "diagnostic", data: `engine spawned pid=${child.pid}` })
    child.stdout?.resume()
    let stderr = ""
    child.stderr?.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-4096)
    })
    child.on("message", (message: { id?: number; result?: unknown; error?: string; event?: string; data?: unknown }) => {
      if (this.child !== child) return
      if (message.event) {
        this.onEvent(message as EngineEvent)
        return
      }
      const pending = this.pending.get(message.id!)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id!)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
    })
    const failed = (error: Error) => {
      if (this.child === child) {
        this.dispose("worker failure")
        this.onEvent({ event: "error", data: error.message })
      }
    }
    child.once("error", failed)
    child.once("exit", code => failed(new Error(`Recognition process exited (${code}): ${stderr}`)))
    await this.request("status", {})
    signal.throwIfAborted()
  }

  request<T = unknown>(method: string, option: Record<string, unknown>, timeout = 120000): Promise<T> {
    if (!this.child?.connected) return Promise.reject(new Error("Engine is not ready"))
    const child = this.child,
      id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.dispose(`request timeout: ${method}`)
        reject(new Error(`Engine ${method} timed out`))
      }, timeout)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      child.send({ id, method, option }, error => {
        if (error) this.dispose(`request send failed: ${method}`)
      })
    })
  }

  async start(model: Model, deviceId: string, playSound = false, startedAt = Date.now(), preRoll = true, keepMicrophoneReady = true, traceId = "", traceStartedAt = Date.now()): Promise<void> {
    clearTimeout(this.idle)
    const child = this.child
    const started = Date.now()
    await this.request("start", { modelPath: this.downloads.modelPath(model), kind: model.kind, deviceId, playSound, startedAt, preRoll, keepMicrophoneReady, traceId, traceStartedAt })
    if (this.child === child) this.loadedModel = model.id
    this.onEvent({ event: "diagnostic", data: `engine start completed pid=${child?.pid} model=${model.id} elapsedMs=${Date.now() - started} retained=${this.child === child}` })
  }
  async warmMicrophone(deviceId: string): Promise<void> {
    await this.request("warm-microphone", { deviceId })
  }
  async preload(model: Model, keepLoaded: boolean): Promise<void> {
    const child = this.child
    await this.request("preload", { modelPath: this.downloads.modelPath(model), kind: model.kind })
    if (this.child !== child) throw new Error("Recognition cancelled")
    this.loadedModel = model.id
    if (!keepLoaded) this.idle = setTimeout(() => this.dispose("idle timeout"), 10 * 60 * 1000)
  }
  isModelLoaded(model: Model): boolean {
    const loaded = !!this.child?.connected && this.loadedModel === model.id
    this.onEvent({ event: "diagnostic", data: `engine status pid=${this.child?.pid ?? "none"} connected=${!!this.child?.connected} loadedModel=${this.loadedModel ?? "none"} requestedModel=${model.id} loaded=${loaded}` })
    return loaded
  }
  async feedback(sound: "start" | "stop", traceId = "", traceStartedAt = Date.now()): Promise<void> {
    await this.request("sound", { sound, traceId, traceStartedAt })
  }
  async stopCapture(keepMicrophoneReady = true): Promise<void> {
    await this.request("stop-capture", { keepMicrophoneReady })
  }
  async cancel(eager = false, keepMicrophoneReady = true): Promise<void> {
    await this.request("cancel", { keepMicrophoneReady }, 10000)
    this.onEvent({ event: "diagnostic", data: `engine cancel completed pid=${this.child?.pid ?? "none"} keepLoaded=${eager}` })
    if (!eager) this.idle = setTimeout(() => this.dispose("idle timeout"), 10 * 60 * 1000)
  }
  async stop(eager = false): Promise<string> {
    const result = await this.request<{ text: string }>("stop", {})
    this.onEvent({ event: "diagnostic", data: `engine stop completed pid=${this.child?.pid ?? "none"} keepLoaded=${eager}` })
    if (!eager) this.idle = setTimeout(() => this.dispose("idle timeout"), 10 * 60 * 1000)
    return result.text
  }
  // Kill also aborts startup/inference and releases every native allocation on unload.
  dispose(reason = "unspecified"): void {
    clearTimeout(this.idle)
    const child = this.child
    this.onEvent({ event: "diagnostic", data: `engine dispose reason=${reason} pid=${child?.pid ?? "none"} loadedModel=${this.loadedModel ?? "none"}` })
    this.child = undefined
    this.loadedModel = undefined
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error("Recognition cancelled"))
    }
    this.pending.clear()
    child?.kill()
  }
}
