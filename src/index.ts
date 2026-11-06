import type { Context, Plugin, PublicAPI, Query, Result } from "@wox-launcher/wox-plugin"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Downloads, exists, models } from "./downloads"
import { Engine, type Device } from "./engine"
import { Store, type Action, type History } from "./store"
import { DictationWindow } from "./window"
import { Controller } from "./controller"

let api: PublicAPI, store: Store, engine: Engine, controller: Controller
let download: { modelId: string; status: string } | undefined
let visibleModel: { ctx: Context; ids: Map<string, string> } | undefined
const icon = { ImageType: "relative" as const, ImageData: "images/app.svg" }

// All UI entry points share failure reporting, including callbacks restored by MRU.
function guarded(ctx: Context, work: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await work()
    } catch (error) {
      await api.ShowToastMsg(ctx, { Message: String(error) })
    }
  }
}
function historyResult(ctx: Context, item: History): Result {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const group = item.timestamp >= today.getTime() ? "today" : item.timestamp >= yesterday.getTime() ? "yesterday" : "history"
  return {
    Title: [...item.content].slice(0, 80).join(""),
    SubTitle: new Date(item.timestamp).toLocaleString(),
    Icon: icon,
    IdentityKey: `history:${item.id}`,
    Score: item.timestamp,
    Group: `i18n:plugin_dictation_group_${group}`,
    GroupScore: group === "today" ? 90 : group === "yesterday" ? 80 : 70,
    Preview: { PreviewType: "text", PreviewData: item.originalContent ? `${item.content}\n\nOriginal transcript:\n${item.originalContent}` : item.content },
    Actions: [
      {
        Name: "Copy",
        ContextData: { historyId: item.id },
        Action: guarded(ctx, async () => {
          await api.Copy(ctx, { type: "text", text: item.content })
        })
      },
      {
        Name: "Delete",
        Action: guarded(ctx, async () => {
          await store.deleteHistory(item.id)
          await api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
        })
      }
    ]
  }
}
function actionResult(ctx: Context, action: Action, selection = "", targetPid?: number): Result {
  return {
    Title: `Start ${action.name}`,
    SubTitle: action.output === "input" ? "Offline recognition" : `Offline recognition • ${action.output}`,
    Icon: icon,
    IdentityKey: selection ? undefined : `action:${action.id}`,
    Actions: [{ Name: "Start dictation", ContextData: selection ? {} : { actionId: action.id }, Action: guarded(ctx, () => controller.start(action, selection, "", targetPid, true)) }]
  }
}
function row(ctx: Context, title: string, subtitle: string, work: () => Promise<void>): Result {
  return { Title: title, SubTitle: subtitle, Icon: icon, Actions: [{ Name: title, Action: guarded(ctx, work) }] }
}

async function modelResult(ctx: Context, model: (typeof models)[number], id: string): Promise<Result> {
  const ready = await engine.downloads.ready(model)
  const result = row(ctx, model.name,
    download?.modelId === model.id ? download.status : ready ? "Downloaded • select to use" : `${model.size} MB • download speech model`,
    async () => {
      if (await engine.downloads.ready(model)) {
        if (controller.state !== "idle") throw new Error("Stop dictation before changing models")
        controller.cancelWarmup()
        engine.dispose("model selected")
        await store.set("model", model.id)
        controller.warmup()
        await api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
        return
      }
      if (download) throw new Error("A model is already downloading")
      download = { modelId: model.id, status: "Starting download…" }
      updateProgress(model.id)
      void controller.download(model.id, status => {
        if (download?.modelId !== model.id) return
        download.status = status
        updateProgress(model.id)
      }).then(async () => {
        download = undefined
        controller.warmup()
        await Promise.all(models.map(updateModel))
      }, async error => {
        download = undefined
        await updateModel(model)
        await api.ShowToastMsg(ctx, { Message: `Model download failed: ${String(error)}` })
      }).catch(() => {})
    })
  result.Id = id
  result.Tails = ready && store.settings.model === model.id ? [{ Type: "text", Text: "Selected", TextCategory: "success" }] : []
  result.Actions![0].PreventHideAfterAction = true
  if (ready) result.Actions!.push({
    Name: "Delete downloaded model",
    PreventHideAfterAction: true,
    Action: guarded(ctx, async () => {
      if (controller.state !== "idle") throw new Error("Stop dictation first")
      controller.cancelWarmup()
      engine.dispose("model deleted")
      await engine.downloads.removeModel(model)
      await api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
    })
  })
  return result
}

function updateProgress(modelId: string): void {
  const visible = visibleModel
  const id = visible?.ids.get(modelId)
  if (visible && id && download?.modelId === modelId)
    void api.UpdateResult(visible.ctx, { Id: id, SubTitle: download.status }).catch(() => {})
}

async function updateModel(model: (typeof models)[number]): Promise<void> {
  const visible = visibleModel
  const id = visible?.ids.get(model.id)
  if (!visible || !id) return
  const result = await modelResult(visible.ctx, model, id)
  if (visibleModel !== visible) return
  await api.UpdateResult(visible.ctx, { Id: id, Title: result.Title, SubTitle: result.SubTitle, Tails: result.Tails, Actions: result.Actions })
}

export const plugin: Plugin = {
  init: async (ctx, params) => {
    api = params.API
    if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Dictation requires Node.js 22 or later")
    if (typeof api.CreateWindow !== "function" || typeof api.OnHotkey !== "function") throw new Error("This version of Wox does not support dictation. Please update Wox.")
    store = new Store(api, ctx)
    await store.load()
    engine = new Engine(new Downloads(await api.GetCacheFolder(ctx)), params.PluginDirectory)
    const view = new DictationWindow(api, ctx)
    controller = new Controller(api, ctx, store, engine, view)
    await api.OnGetDynamicSetting(ctx, (async (_context: Context, key: string) => {
      if (key === "inputDevice") {
        let available: Device[] = []
        const runtimeReady = await exists(join(engine.downloads.runtimePath(), ".complete"))
        if (runtimeReady) {
          const discovery = new Engine(engine.downloads, params.PluginDirectory)
          try {
            await discovery.prepare(new AbortController().signal, () => {})
            available = await discovery.request<Device[]>("devices", {}, 10000)
          } catch (error) {
            await api.Log(ctx, "Warning", `Could not list microphones: ${String(error)}`).catch(() => {})
          } finally {
            discovery.dispose()
          }
        }
        const selected = store.settings.inputDevice || ""
        const options = [{ Label: "i18n:plugin_dictation_system_default", Value: "" }, ...available.map(device => ({ Label: device.name, Value: device.deviceId }))]
        if (selected && !available.some(device => device.deviceId === selected)) options.splice(1, 0, { Label: `Unavailable: ${selected}`, Value: selected })
        return {
          Type: "select", IsPlatformSpecific: true, DisabledInPlatforms: [],
          Value: { Key: "inputDevice", Label: "i18n:plugin_dictation_input_device", Tooltip: runtimeReady ? "i18n:plugin_dictation_input_device_tooltip" : "i18n:plugin_dictation_input_device_requires_model", DefaultValue: "", Options: options }
        }
      }
      if (key === "dictionary" && (store.actions[0].aiRefineEnabled ?? store.settings.defaultAIRefineEnabled === "true")) {
        return {
          Type: "table", IsPlatformSpecific: false, DisabledInPlatforms: [],
          Value: { Key: "dictionary", DefaultValue: "[]", Title: "i18n:plugin_dictation_dictionary", Tooltip: "i18n:plugin_dictation_dictionary_tooltip", MaxHeight: 260,
            Columns: [{ Key: "phrase", Label: "i18n:plugin_dictation_dictionary_phrase", Type: "text", TextMaxLines: 1, Validators: [{ Type: "not_empty", Value: {} }] }] }
        }
      }
      return {} as never
    }) as unknown as Parameters<PublicAPI["OnGetDynamicSetting"]>[1])
    await api.OnUnload(ctx, async () => {
      controller.cancelDownload()
      controller.cancelWarmup()
      await controller.cancel()
      controller.cancelWarmup()
      engine.dispose("plugin unload")
      await view.destroy()
    })
    await api.OnSettingChanged(ctx, async (_context, key, value) => {
      try {
        store.changed(key, value)
        if ((key === "model" || key === "inputDevice" || key === "keepMicrophoneReady") && controller.state === "idle") {
          controller.cancelWarmup()
          engine.dispose(`${key} changed`)
          controller.warmup()
        }
      } catch (error) {
        await api.ShowToastMsg(ctx, { Message: String(error) })
      }
    })
    const hotkeys = await api.OnHotkey(ctx, { Callback: (context, event) => guarded(context, () => controller.onHotkey(event))() })
    if (!hotkeys.Success) throw new Error(hotkeys.ErrMsg || "Unable to subscribe to hotkeys")
    await api.OnMRURestore(ctx, async (context, data) => {
      if (data.ContextData.historyId) {
        const item = store.history.find(h => h.id === data.ContextData.historyId)
        return item ? historyResult(context, item) : null
      }
      const action = store.actions.find(a => a.id === data.ContextData.actionId && !a.disabled && !a.prompt.includes("{wox:selected_text}"))
      return action ? actionResult(context, action) : null
    })
    await api.OnDeepLink(ctx, async (context, data) => {
      await guarded(context, async () => {
        if (data.command === "stop") await controller.stop()
        else if (data.command === "cancel") await controller.cancel()
        else if (data.command === "start") await controller.start(store.actions[0])
      })()
    })
    const registration = await api.RegisterPluginTool(ctx, {
      Tool: {
        Name: "search_history",
        Description: "Search saved dictation transcripts without opening UI",
        InputSchema: { type: "object", properties: { search: { type: "string" } }, additionalProperties: false },
        OutputSchema: { type: "object", properties: { entries: { type: "array", items: { type: "object" } } }, required: ["entries"] },
        Annotations: { ReadOnly: true, Destructive: false, Idempotent: true, RequiresUI: false }
      },
      Handler: async (_context, input) => ({ Output: { entries: store.history.filter(h => h.content.toLowerCase().includes(String(input.Arguments.search || "").toLowerCase())).slice(0, 20) } })
    })
    if (registration.Error) throw new Error(registration.Error.Message)
    controller.warmup()
    void view.prepare().catch(error => api.Log(ctx, "Warning", `Could not prepare dictation window: ${String(error)}`).catch(() => {}))
  },
  query: async (ctx: Context, query: Query) => {
    visibleModel = undefined
    if (query.Type === "selection") {
      if (query.Selection?.Type !== "text" || !query.Selection.Text?.trim()) return { Results: [] }
      return { Results: store.actions.filter(a => !a.disabled).map(a => actionResult(ctx, a, query.Selection.Text, query.Env?.ActiveWindowPid)) }
    }
    const search = [query.Command, query.Search].filter(Boolean).join(" ").trim()
    if (search === "model") {
      const visible = { ctx, ids: new Map(models.map(model => [model.id, randomUUID()])) }
      visibleModel = visible
      return { Results: await Promise.all(models.map(model => modelResult(ctx, model, visible.ids.get(model.id)!))) }
    }
    if (!search) {
      const selected = models.find(model => model.id === store.settings.model) || models[0]
      if (!(await engine.downloads.ready(selected))) {
        const result = row(ctx, "Download an offline speech model first", "Press Enter to choose a model", () =>
          api.ChangeQuery(ctx, { QueryType: "input", QueryText: "dictate model " }))
        result.Actions![0].PreventHideAfterAction = true
        return { Results: [result] }
      }
    }
    if (!search && !store.history.length) return { Results: [{ Title: "i18n:plugin_dictation_history_empty_title", SubTitle: "i18n:plugin_dictation_history_empty_subtitle", Icon: icon }] }
    return { Results: store.history.filter(h => `${h.content} ${h.originalContent || ""}`.toLowerCase().includes(search.toLowerCase())).map(h => historyResult(ctx, h)) }
  }
}
