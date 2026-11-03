import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"

const mediaPlayerId = "b8f3d4e5-6c7a-4b9c-8d1e-2f3a4b5c6d7e"

export class MediaPause {
  private paused = false
  private queue = Promise.resolve()
  constructor(private readonly api: PublicAPI, private readonly ctx: Context) {}

  private run(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).catch(async error => {
      await this.api.Log(this.ctx, "Warning", `Dictation media control: ${String(error)}`).catch(() => {})
    })
    return this.queue
  }

  pause(signal: AbortSignal): Promise<void> {
    return this.run(async () => {
      if (signal.aborted) return
      const status = await this.api.InvokePluginTool(this.ctx, { PluginId: mediaPlayerId, Name: "get_status" })
      if (status.Error) throw new Error(status.Error.Message)
      if (status.Output?.status !== "playing" || signal.aborted) return
      const result = await this.api.InvokePluginTool(this.ctx, { PluginId: mediaPlayerId, Name: "pause" })
      if (result.Error) throw new Error(result.Error.Message)
      this.paused = true
    })
  }

  resume(): Promise<void> {
    return this.run(async () => {
      if (!this.paused) return
      this.paused = false
      const result = await this.api.InvokePluginTool(this.ctx, { PluginId: mediaPlayerId, Name: "play" })
      if (result.Error) throw new Error(result.Error.Message)
    })
  }
}
