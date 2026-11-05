import { createHash, randomUUID } from "node:crypto"
import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"

export interface Action {
  id: string
  type: "default" | "custom"
  name: string
  output: "input" | "overlay" | "chat" | "clipboard"
  prompt: string
  model?: string
  aiRefineEnabled?: boolean
  hotkey?: string
  disabled?: boolean
}
export interface History {
  id: string
  content: string
  originalContent?: string
  timestamp: number
}
export const defaultAction: Action = { id: "default", type: "default", name: "Dictation", output: "input", prompt: "" }

export function normalizeActions(value: unknown): Action[] {
  if (!Array.isArray(value)) throw new Error("Actions must be a JSON array")
  const result: Action[] = [{ ...defaultAction }]
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.name !== "string") continue
    if (item.type === "default" || item.id === "default") {
      result[0] = {
        ...defaultAction,
        model: typeof item.model === "string" ? item.model : undefined,
        aiRefineEnabled: typeof item.aiRefineEnabled === "boolean" ? item.aiRefineEnabled : undefined,
        hotkey: typeof item.hotkey === "string" ? item.hotkey : undefined
      }
      continue
    }
    result.push({
      id:
        typeof item.id === "string" && item.id
          ? item.id
          : createHash("sha256")
              .update(JSON.stringify([item.name, item.prompt || "", item.model || "", result.length]))
              .digest("hex")
              .slice(0, 24),
      type: "custom",
      name: item.name.trim(),
      output: ["input", "overlay", "chat", "clipboard"].includes(item.output) ? item.output : "input",
      prompt: typeof item.prompt === "string" ? item.prompt : "",
      model: typeof item.model === "string" ? item.model : "",
      hotkey: typeof item.hotkey === "string" ? item.hotkey : undefined,
      disabled: item.disabled === true
    })
  }
  return result
}

export function recentContext(history: History[], now = Date.now()): string[] {
  const recent = history
    .filter(h => now - h.timestamp <= 600000 && h.timestamp <= now)
    .slice(0, 10)
    .reverse()
  const result: string[] = []
  recent.forEach((h, i) => {
    if (i && h.timestamp - recent[i - 1].timestamp >= 120000) result.push("--- (topic changed) ---")
    result.push(h.content)
  })
  return result
}

// Persist through Wox; update memory only after a successful write, serialize competing edits.
export class Store {
  history: History[] = []
  dictionary: string[] = []
  actions: Action[] = [{ ...defaultAction }]
  settings: Record<string, string> = {}
  private writes = Promise.resolve()
  constructor(
    readonly api: PublicAPI,
    readonly ctx: Context
  ) {}

  async load(): Promise<void> {
    const keys = ["history", "dictionary", "actions", "model", "inputDevice", "keepMicrophoneReady", "defaultAIModel", "defaultAIRefineEnabled", "modelLoadMode", "playSound", "duckVolume"]
    const values = await Promise.all(keys.map(key => this.api.GetSetting(this.ctx, key)))
    const settings = Object.fromEntries(keys.map((key, i) => [key, values[i] || ""]))
    const history = JSON.parse(settings.history || "[]")
    if (!Array.isArray(history)) throw new Error("Invalid Dictation history settings; original data was not modified")
    this.history = history.filter(h => h && typeof h.id === "string" && typeof h.content === "string" && Number.isFinite(h.timestamp)).slice(0, 500)
    this.dictionary = dictionaryPhrases(settings.dictionary)
    this.actions = normalizeActions(JSON.parse(settings.actions || "[]"))
    this.settings = settings
  }

  async set(key: string, value: string, platform = false): Promise<void> {
    const result = await this.api.SetSetting(this.ctx, { Key: key, Value: value, PlatformSpecific: platform })
    if (!result.Success) throw new Error(`Could not save ${key}`)
    this.settings[key] = value
  }

  // Host notifications carry the changed value; avoid re-reading unrelated keys mid-write.
  changed(key: string, value: string): void {
    if (key === "actions") this.actions = normalizeActions(JSON.parse(value || "[]"))
    if (key === "dictionary") this.dictionary = dictionaryPhrases(value)
    if (key === "history") {
      const entries = JSON.parse(value || "[]")
      if (!Array.isArray(entries)) throw new Error(`Invalid ${key} setting`)
      this.history = entries.filter(h => h && typeof h.id === "string" && typeof h.content === "string" && Number.isFinite(h.timestamp)).slice(0, 500)
    }
    this.settings[key] = value
  }

  private edit(operation: () => Promise<void>): Promise<void> {
    const task = this.writes.then(operation)
    this.writes = task.catch(() => {})
    return task
  }

  addHistory(content: string, originalContent: string): Promise<void> {
    return this.edit(async () => {
      const next = [{ id: randomUUID(), content, originalContent: originalContent === content ? undefined : originalContent, timestamp: Date.now() }, ...this.history].slice(0, 500)
      await this.set("history", JSON.stringify(next))
      this.history = next
    })
  }
  deleteHistory(id: string): Promise<void> {
    return this.edit(async () => {
      const next = this.history.filter(h => h.id !== id)
      await this.set("history", JSON.stringify(next))
      this.history = next
    })
  }
}

function dictionaryPhrases(value: string): string[] {
  const entries = JSON.parse(value || "[]")
  if (!Array.isArray(entries)) throw new Error("Invalid Dictation dictionary settings; original data was not modified")
  return entries.filter(item => item && typeof item.phrase === "string" && item.phrase.trim()).slice(0, 100).map(item => item.phrase.trim())
}
