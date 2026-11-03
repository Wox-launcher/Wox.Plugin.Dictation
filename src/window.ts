import type { Context, PluginWindow, PublicAPI } from "@wox-launcher/wox-plugin"

export interface ViewState {
  status: string
  text?: string
  level?: number
  recording?: boolean
  busy?: boolean
  result?: boolean
}
export class DictationWindow {
  private generation = 0
  private ready = false
  private window?: PluginWindow
  private creating?: Promise<void>
  private expanded = false
  private resizing: Promise<void> = Promise.resolve()
  private posting: Promise<void> = Promise.resolve()
  private revision = 0
  private state: ViewState = { status: "Dictation" }
  onCommand: (command: string) => Promise<void> = async () => {}
  constructor(
    readonly api: PublicAPI,
    readonly ctx: Context
  ) {}

  async show(): Promise<void> {
    if (this.creating) await this.creating
    if (!this.window) {
      this.creating = this.create().finally(() => {
        this.creating = undefined
      })
      await this.creating
    }
    const result = await this.window!.Show(this.ctx, { Activate: true })
    if (!result.Success) throw new Error(result.ErrMsg || "Cannot show Dictation window")
  }

  async hide(): Promise<void> {
    if (!this.window) return
    const result = await this.window.Hide(this.ctx, {})
    if (!result.Success) throw new Error(result.ErrMsg || "Cannot hide Dictation window")
  }

  private async create(): Promise<void> {
    const generation = ++this.generation
    this.ready = false
    const colors = await this.api.GetThemeColors(this.ctx, {})
    const color = (value: string) => (/^#[0-9a-f]{3,8}$/i.test(value) ? value : "#888888")
    const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
      *{box-sizing:border-box}html,body{background:transparent}body{margin:0;color:${color(colors.Text)};font:14px system-ui;user-select:none;-webkit-user-select:none}main{height:100vh;display:flex;align-items:center;justify-content:center;padding:16px 48px}#status{color:${color(colors.SecondaryText)};text-align:center;overflow-wrap:anywhere}#wave{display:flex;align-items:center;justify-content:center;gap:8px;width:180px;height:48px;border:0;background:transparent;color:inherit;cursor:pointer}.bar{width:7px;height:12px;border-radius:8px;background:currentColor;transition:height 100ms ease-out}#cancel{position:absolute;right:16px;top:50%;transform:translateY(-50%);width:32px;height:32px;border:0;background:transparent;color:inherit;cursor:pointer;font-size:25px;line-height:1;border-radius:6px}#cancel:hover{background:${color(colors.Selection)}}button:focus-visible{outline:2px solid ${color(colors.Accent)}}#result{display:none;width:100%;min-height:0;flex:1;flex-direction:column;gap:10px}body.expanded main{padding:18px;display:flex;align-items:stretch;flex-direction:column;gap:10px}body.expanded #result{display:flex}body.expanded #cancel{top:18px;transform:none}body.expanded #status{text-align:left;padding-right:35px}pre{font:15px/1.6 system-ui;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;user-select:text;-webkit-user-select:text;flex:1;margin:0}footer{display:flex;justify-content:flex-end}#copy{border:1px solid ${color(colors.Border)};border-radius:7px;padding:7px 14px;background:${color(colors.Selection)};color:inherit;cursor:pointer}[hidden]{display:none!important}
      main{gap:8px;padding:8px 36px 8px 8px}#status{font-size:12px;line-height:16px;max-height:40px;overflow:auto}body.expanded #status{font-size:14px;max-height:none}#wave{width:100%;max-width:132px;height:24px;gap:5px}.bar{width:4px;height:8px}#cancel{right:8px;width:28px;height:28px;font-size:22px}#spinner{width:16px;height:16px;flex:none;border:2px solid ${color(colors.Border)};border-top-color:${color(colors.Text)};border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#spinner{animation:none}}
      </style><main><button id="wave" type="button" title="Stop dictation" aria-label="Stop dictation" hidden><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span></button><span id="spinner" aria-hidden="true" hidden></span><div id="status" role="status"></div><div id="result"><pre id="text"></pre><footer><button id="copy" type="button">Copy</button></footer></div></main><button id="cancel" type="button" aria-label="Cancel dictation" title="Cancel dictation">×</button><script>
      const el=id=>document.getElementById(id),bars=document.querySelectorAll('.bar'),weights=[.55,.8,.65,1,.65,.8,.55];
      woxWindow.onMessage(s=>{document.body.classList.toggle('expanded',!!s.result);el('status').textContent=s.status;el('status').hidden=!!s.recording;el('spinner').hidden=!s.busy||!!s.recording||!!s.result;el('text').textContent=s.text||'';el('wave').hidden=!s.recording;el('cancel').setAttribute('aria-label',s.busy?'Cancel dictation':'Close');if(typeof s.level==='number'){const level=Math.max(0,Math.min(1,s.level));bars.forEach((bar,i)=>bar.style.height=(5+level*19*weights[i])+'px')}});
      el('wave').onclick=()=>woxWindow.postMessage({command:'stop'});for(const id of ['cancel','copy'])el(id).onclick=()=>woxWindow.postMessage({command:id});
      document.addEventListener('keydown',e=>{if(e.key==='Escape')woxWindow.postMessage({command:'cancel'})});
      </script></html>`
    const result = await this.api.CreateWindow(this.ctx, {
      Window: { Title: "Dictation", Presentation: "overlay", Width: 200, Height: 56, Anchor: "bottom-center", OffsetY: -60, Topmost: true, Focusable: true, Resizable: false, Movable: true, HideChrome: true, DragContent: true, Closable: true },
      Content: { Type: "html", Data: html },
      OnEvent: async (_ctx, event) => {
        if (generation !== this.generation) return
        if (event.Type === "ready") {
          this.ready = true
          await this.update(this.state)
        }
        if (event.Type === "error") {
          void this.onCommand("cancel").catch(() => {})
          await this.api.Notify(this.ctx, event.ErrMsg || "Dictation window failed")
        }
        if (event.Type === "closed") {
          this.window = undefined
          void this.onCommand("cancel").catch(() => {})
        }
        if (event.Type === "message") {
          const data = event.Data as { command?: string } | undefined
          if (data?.command && ["stop", "cancel", "copy"].includes(data.command)) void this.onCommand(data.command).catch(() => {})
        }
      }
    })
    if (!result.Success || !result.Window) throw new Error(result.ErrMsg || "Unable to open the dictation window")
    if (generation !== this.generation) {
      await result.Window.Close(this.ctx, {})
      throw new Error("Window creation cancelled")
    }
    this.window = result.Window
    await this.update(this.state)
  }

  async update(state: ViewState): Promise<void> {
    this.state = state
    const revision = ++this.revision
    if (this.window && this.expanded !== !!state.result) {
      this.expanded = !!state.result
      const window = this.window
      const expanded = this.expanded
      this.resizing = this.resizing.catch(() => {}).then(async () => {
        const result = await window.SetOptions(this.ctx, expanded ? { Width: 440, Height: 300 } : { Width: 200, Height: 56 })
        if (!result.Success) throw new Error(result.ErrMsg || "Window resize failed")
      })
      await this.resizing
    }
    if (this.window && this.ready) {
      const window = this.window
      this.posting = this.posting.catch(() => {}).then(async () => {
        if (revision !== this.revision || window !== this.window || !this.ready) return
        const result = await window.Content.PostMessage(this.ctx, { Data: state })
        if (!result.Success) throw new Error(result.ErrMsg || "Window update failed")
      })
      await this.posting
    }
  }
  async close(): Promise<void> {
    this.generation++
    this.revision++
    this.ready = false
    this.expanded = false
    const window = this.window
    this.window = undefined
    if (window) await window.Close(this.ctx, {})
  }
}
