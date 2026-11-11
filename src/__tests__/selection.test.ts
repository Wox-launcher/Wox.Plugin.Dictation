import type { Context, PublicAPI, Query, Result } from "@wox-launcher/wox-plugin"
import { Controller } from "../controller"
import { plugin } from "../index"
import { DictationWindow } from "../window"

afterEach(() => jest.restoreAllMocks())

test("text selections show enabled custom actions without the built-in dictation action", async () => {
  jest.spyOn(Controller.prototype, "warmup").mockImplementation(() => {})
  jest.spyOn(DictationWindow.prototype, "prepare").mockResolvedValue()
  let changeSetting!: Parameters<PublicAPI["OnSettingChanged"]>[1]
  const api = {
    GetSetting: jest.fn(async () => ""),
    GetCacheFolder: jest.fn(async () => "cache"),
    CreateWindow: jest.fn(),
    OnGetDynamicSetting: jest.fn(),
    OnUnload: jest.fn(),
    OnSettingChanged: jest.fn((_ctx, callback) => { changeSetting = callback }),
    OnHotkey: jest.fn(async () => ({ Success: true })),
    OnMRURestore: jest.fn(),
    OnDeepLink: jest.fn(),
    RegisterPluginTool: jest.fn(async () => ({}))
  } as unknown as PublicAPI
  const ctx = {} as Context
  await plugin.init(ctx, { API: api, PluginDirectory: "" } as never)
  const query: Query = {
    Id: "selection",
    Type: "selection",
    RawQuery: "",
    Search: "",
    Selection: { Type: "text", Text: "Selected text", FilePaths: [] },
    Env: { ActiveWindowTitle: "", ActiveWindowPid: 0, ActiveWindowIcon: { ImageType: "relative", ImageData: "" }, ActiveBrowserUrl: "" },
    IsGlobalQuery: () => true
  }

  expect(await plugin.query(ctx, query)).toEqual({ Results: [] })

  await changeSetting(ctx, "actions", JSON.stringify([
    { name: "Rewrite selection", prompt: "{wox:selected_text}\n{wox:dictation_text}" },
    { name: "Copy transcript", output: "clipboard" },
    { name: "Disabled action", disabled: true }
  ]))
  const { Results } = await plugin.query(ctx, query) as { Results: Result[] }
  expect(Results.map(result => result.Title)).toEqual(["Start Rewrite selection", "Start Copy transcript"])
})
