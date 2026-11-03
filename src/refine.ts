import type { AI, Context, PublicAPI } from "@wox-launcher/wox-plugin"
import prompt from "./refine-prompt.json"

// Strip decoder control tokens before classifying speech or sending it to an LLM.
export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/^(?:language\s+[A-Za-z][A-Za-z0-9_-]*\s*)?<asr_text>/i, "")
    .replace(/<\|[^|>]+?\|>|<blank\d+>|<tts_[a-z_]+>|<asr_text>|<think>|<\/think>|¶/gi, "")
    .trim()
  if (!/[\p{L}\p{N}]/u.test(text)) return ""
  const collapsed = text.replace(/(.)\1{5,}/gu, "$1$1")
  const content = [...collapsed.replace(/[\s\p{P}]/gu, "")]
  if (collapsed !== text && content.length >= 4 && !/[a-z\p{N}]/iu.test(content.join("")) && new Set(content).size <= 2) return ""
  return text
}

export function sanitize(original: string, refined: string): string {
  refined = refined
    .trim()
    .replace(/^```[^\n]{0,11}\n([\s\S]*?)\n?```$/, "$1")
    .trim()
  if (
    !cleanTranscript(original) ||
    /(nothing to (edit|refine|transcribe)|no (actual )?dictation|no content to refine|please provide|user'?s message contains|i( am|'m) (ready|waiting)|cannot (edit|refine))/i.test(refined)
  )
    return ""
  const length = [...original.trim()].length,
    resultLength = [...refined].length
  return length <= 8 && resultLength > length * 4 && resultLength > 24 ? "" : refined
}

export function expandPrompt(template: string, text: string, selection: string): string {
  return template.replace(/\{wox:(dictation_text|selected_text)\}/g, (_, variable) => (variable === "dictation_text" ? text : selection))
}

export function refineInput(raw: string, history: string[], phrases: string[]): string {
  return (
    (phrases.length ? `Preferred spellings (use only when the new dictation is clearly a mishearing of one of these): ${phrases.join(", ")}\n\n` : "") +
    (history.length ? `Earlier dictations, oldest first (context only):\n${history.map(t => `- ${t}`).join("\n")}\n\n` : "") +
    `New dictation:\n<transcript>\n${raw}\n</transcript>\n\nOutput only the cleaned transcript.`
  )
}

export function parseModel(value: string): AI.AIModel {
  const model = JSON.parse(value) as AI.AIModel
  if (!model?.Provider || !model.Name) throw new Error("Choose an AI model in Dictation settings")
  return model
}

// Wox streams complete snapshots. Local abort must reject even after the RPC has returned.
export function chat(api: PublicAPI, ctx: Context, model: AI.AIModel, system: string, text: string, signal: AbortSignal, timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error?: Error, result = "") => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(new Error("Cancelled"))
    const timer = setTimeout(() => finish(new Error("AI request timed out")), timeout)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    void api
      .AIChatStream(
        ctx,
        model,
        [
          { Role: "system", Text: system, Timestamp: Date.now() },
          { Role: "user", Text: text, Timestamp: Date.now() }
        ],
        { ThinkingMode: "non_thinking" },
        data => {
          if (data.Status === "finished") finish(undefined, data.Data)
          if (data.Status === "error") finish(new Error(data.Data || "AI request failed"))
        }
      )
      .catch(error => finish(error))
  })
}
export { prompt as refinePrompt }
