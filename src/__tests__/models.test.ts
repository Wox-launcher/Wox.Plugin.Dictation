import type { Context, PublicAPI, Query, Result, ExecuteResultAction } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import { Controller } from "../controller"
import { Downloads, models } from "../downloads"
import * as downloads from "../downloads"
import { Engine } from "../engine"
import { DictationWindow } from "../window"

const ctx = {} as Context
const query = async (search: string) => await plugin.query(ctx, { Type: "input", Command: "", Search: search } as Query) as { Results: Result[] }
const execute = (action: ExecuteResultAction) => action.Action(ctx, { ResultId: "", ResultActionId: "", ContextData: {} })

test("guides first-time users and restores background download progress after changing queries", async () => {
  let ready = false
  jest.spyOn(Downloads.prototype, "ready").mockImplementation(async model => ready && model.id === models[0].id)
  let report!: (message: string) => void
  let finish!: () => void
  jest.spyOn(Controller.prototype, "download").mockImplementation((_modelId, progress) => {
    report = progress
    return new Promise<void>(resolve => { finish = resolve })
  })
  jest.spyOn(downloads, "exists").mockResolvedValue(true)
  jest.spyOn(Engine.prototype, "prepare").mockResolvedValue()
  jest.spyOn(Engine.prototype, "request").mockResolvedValue([{ name: "Test microphone", deviceId: "mic" }])
  jest.spyOn(Engine.prototype, "dispose").mockImplementation(() => {})
  jest.spyOn(Controller.prototype, "warmup").mockImplementation(() => {})
  jest.spyOn(DictationWindow.prototype, "prepare").mockResolvedValue()
  let dynamic!: (context: Context, key: string) => Promise<{ Type: string; Value: { Options?: { Label: string; Value: string }[]; Key?: string }; IsPlatformSpecific?: boolean }>
  let changed!: (context: Context, key: string, value: string) => Promise<void>
  const api = {
    GetSetting: jest.fn(async () => ""), GetCacheFolder: jest.fn(async () => "cache"),
    CreateWindow: jest.fn(), OnHotkey: jest.fn(async () => ({ Success: true })),
    OnUnload: jest.fn(), OnSettingChanged: jest.fn(async (_ctx, callback) => { changed = callback }),
    OnGetDynamicSetting: jest.fn(async (_ctx, callback) => { dynamic = callback }), OnMRURestore: jest.fn(), OnDeepLink: jest.fn(),
    RegisterPluginTool: jest.fn(async () => ({})), ChangeQuery: jest.fn(), UpdateResult: jest.fn(async () => true), ShowToastMsg: jest.fn(),
    SetSetting: jest.fn(async () => ({ Success: true })), RefreshQuery: jest.fn()
  } as unknown as PublicAPI
  await plugin.init(ctx, { API: api, PluginDirectory: "" } as never)
  const inputSetting = await dynamic(ctx, "inputDevice")
  expect(inputSetting.IsPlatformSpecific).toBe(true)
  expect(inputSetting.Value.Options).toEqual([{ Label: "i18n:plugin_dictation_system_default", Value: "" }, { Label: "Test microphone", Value: "mic" }])
  await changed(ctx, "inputDevice", "missing")
  expect((await dynamic(ctx, "inputDevice")).Value.Options).toContainEqual({ Label: "Unavailable: missing", Value: "missing" })
  await changed(ctx, "inputDevice", "")
  expect(await dynamic(ctx, "dictionary")).toEqual({})
  await changed(ctx, "defaultAIRefineEnabled", "true")
  expect((await dynamic(ctx, "dictionary")).Value.Key).toBe("dictionary")
  const initial = await query("")
  expect(initial.Results).toHaveLength(1)
  await execute(initial.Results[0].Actions![0] as ExecuteResultAction)
  expect(api.ChangeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: "dictate model " })

  await changed(ctx, "model", models[1].id)
  const listing = await query("model")
  await execute(listing.Results[0].Actions![0] as ExecuteResultAction)
  report("42%")
  expect(api.UpdateResult).toHaveBeenCalledWith(ctx, { Id: listing.Results[0].Id, SubTitle: "42%" })
  await query("history")
  report("63%")
  const returned = await query("model")
  expect(returned.Results[0].SubTitle).toBe("63%")
  report("80%")
  expect(api.UpdateResult).toHaveBeenCalledWith(ctx, { Id: returned.Results[0].Id, SubTitle: "80%" })
  ready = true
  finish()
  await new Promise(resolve => setImmediate(resolve))
  expect(jest.mocked(api.UpdateResult).mock.calls.some(([, result]) => result.Id === returned.Results[0].Id && result.SubTitle === "Downloaded • select to use")).toBe(true)
  const downloaded = (await query("model")).Results[0]
  expect(downloaded.Tails).toEqual([])
  await execute(downloaded.Actions![0] as ExecuteResultAction)
  const selected = (await query("model")).Results[0]
  expect(selected.Title).toBe(models[0].name)
  expect(selected.Tails).toEqual([{ Type: "text", Text: "Selected", TextCategory: "success" }])
  expect((await query("")).Results[0].Title).toBe("i18n:plugin_dictation_history_empty_title")
  await changed(ctx, "history", JSON.stringify([
    { id: "1", content: "Hello world", originalContent: "Unpolished words", timestamp: Date.now() },
    { id: "2", content: "devices and history", timestamp: Date.now() - 86400000 }
  ]))
  expect((await query("")).Results.map(item => item.Title)).toEqual(["Hello world", "devices and history"])
  expect((await query("UNPOLISHED")).Results.map(item => item.Title)).toEqual(["Hello world"])
  expect((await query("devices")).Results.map(item => item.Title)).toEqual(["devices and history"])
  expect((await query("history")).Results.map(item => item.Title)).toEqual(["devices and history"])
  expect((await query("not found")).Results).toEqual([])
  expect((await query("model hello")).Results).toEqual([])
  jest.restoreAllMocks()
})
