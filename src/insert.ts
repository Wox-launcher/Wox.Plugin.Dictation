import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"

interface MacTarget { kind: "mac"; child: ChildProcessWithoutNullStreams; completed: Promise<void> }
interface LinuxTarget { kind: "linux"; child: ChildProcessWithoutNullStreams; completed: Promise<void>; next: (expected: string) => Promise<void> }
interface WindowsTarget { kind: "windows"; child: ChildProcessWithoutNullStreams; completed: Promise<void>; next: (expected: string) => Promise<void>; pasted: boolean }
export type InputTarget = string | MacTarget | LinuxTarget | WindowsTarget

export class TextInsert {
  private clipboardRestore: Promise<void> = Promise.resolve()
  constructor(private readonly api: PublicAPI, private readonly ctx: Context, private readonly directory: string) {}

  private run(mode: "capture" | "insert", signal: AbortSignal, input = ""): Promise<string> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", join(this.directory, "insert-windows.ps1"), mode], {
        windowsHide: true, ...(mode === "capture" ? { signal } : {}), stdio: ["pipe", "pipe", "pipe"]
      })
      let output = "", error = ""
      let reported = false
      let finishRestore!: () => void
      const abort = () => child.kill()
      const warnRestore = () => { if (typeof this.api.Log === "function") void this.api.Log(this.ctx, "Warning", "Could not restore the clipboard after dictation paste").catch(() => {}) }
      if (mode === "insert") this.clipboardRestore = new Promise(resolve => { finishRestore = resolve })
      if (mode === "insert") signal.addEventListener("abort", abort, { once: true })
      if (mode === "insert" && signal.aborted) child.kill()
      const timeout = setTimeout(() => child.kill(), 10000)
      child.stdout.on("data", data => {
        output = (output + String(data)).slice(0, 1024)
        if (mode === "insert" && !reported && /^done\r?\n/.test(output)) {
          reported = true
          signal.removeEventListener("abort", abort)
          resolve("done")
        }
      })
      child.stderr.on("data", data => { error = (error + String(data)).slice(0, 1024) })
      child.stdin.on("error", () => {})
      child.on("error", err => { clearTimeout(timeout); signal.removeEventListener("abort", abort); finishRestore?.(); if (!reported) reject(err); else warnRestore() })
      child.on("close", code => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        finishRestore?.()
        if (reported && code !== 0) warnRestore()
        if (!reported) {
          if (mode === "capture" && code === 0) resolve(output.trim())
          else reject(new Error(error || "Could not insert text"))
        }
      })
      child.stdin.end(input, "utf8")
    })
  }

  async capture(pid: number | undefined, signal: AbortSignal): Promise<InputTarget | undefined> {
    if (!pid || pid <= 0) return undefined
    if (process.platform === "darwin") return this.captureMac(pid, signal)
    if (process.platform === "linux") return this.captureHelper("linux", pid, signal)
    if (process.platform !== "win32") return undefined
    return this.captureHelper("windows", pid, signal)
  }

  private async captureMac(pid: number, signal: AbortSignal): Promise<MacTarget> {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", join(this.directory, "insert-macos.js"), String(pid)], { signal, stdio: ["pipe", "pipe", "pipe"] })
    let output = "", error = "", isReady = false
    let ready!: () => void, failed!: (error: Error) => void
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
    const timer = setTimeout(() => { child.kill(); failed(new Error("Input target timed out")) }, 10000)
    child.stdout.on("data", data => {
      output = (output + String(data)).slice(0, 1024)
      if (output.startsWith("ready\n")) { isReady = true; clearTimeout(timer); ready() }
    })
    child.stderr.on("data", data => { error = (error + String(data)).slice(0, 1024) })
    child.stdin.on("error", () => {})
    const completed = new Promise<void>((resolve, reject) => {
      child.on("error", reject)
      child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(error || `macOS input helper exited (code ${code}, signal ${signal || "none"})`)))
    })
    void completed.then(() => {
      if (!isReady) { clearTimeout(timer); failed(new Error("Input target is unavailable")) }
    }, err => { clearTimeout(timer); failed(err) })
    try {
      await started
      return { kind: "mac", child, completed }
    } catch (err) {
      child.kill()
      throw err
    }
  }

  private async captureHelper(kind: "linux" | "windows", pid: number, signal: AbortSignal): Promise<LinuxTarget | WindowsTarget> {
    signal.throwIfAborted()
    const executable = kind === "linux" ? "python3" : join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const args = kind === "linux" ? ["-u", join(this.directory, "insert-linux.py"), String(pid)] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", join(this.directory, "insert-windows.ps1"), "session", String(pid)]
    const child = spawn(executable, args, { ...(kind === "linux" ? { signal } : { windowsHide: true }), stdio: ["pipe", "pipe", "pipe"] })
    const abort = () => child.kill()
    if (kind === "windows") signal.addEventListener("abort", abort, { once: true })
    if (kind === "windows" && signal.aborted) child.kill()
    let error = ""
    child.stderr.on("data", data => { error = (error + String(data)).slice(0, 1024) })
    child.stdin.on("error", () => {})
    const lines = createInterface({ input: child.stdout })
    const pending: string[] = []
    let deliver: (() => void) | undefined
    let pasted = false
    let restoreTimer: NodeJS.Timeout | undefined
    lines.on("line", line => {
      if (kind === "windows" && line.startsWith("timing ")) {
        if (typeof this.api.Log === "function") void this.api.Log(this.ctx, "Info", `[Dictation timing] ${line.slice(7)}`).catch(() => {})
        return
      }
      if (kind === "windows" && line === "done") {
        pasted = true
        signal.removeEventListener("abort", abort)
        restoreTimer = setTimeout(() => child.kill(), 10000)
      }
      pending.push(line)
      deliver?.()
    })
    const completed = new Promise<void>((resolve, reject) => {
      child.on("error", err => { clearTimeout(restoreTimer); signal.removeEventListener("abort", abort); reject(err) })
      child.on("close", code => { clearTimeout(restoreTimer); signal.removeEventListener("abort", abort); if (code === 0) resolve(); else reject(new Error(error || "Could not insert text")) })
    })
    void completed.catch(() => {})
    const next = async (expected: string) => {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          new Promise<void>(resolve => { if (pending.length) resolve(); else deliver = resolve }),
          completed.then(() => { throw new Error("Input helper closed") }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Input helper timed out")), 10000) })
        ])
        if (pending.shift() !== expected) throw new Error("Unexpected input helper response")
      } finally {
        deliver = undefined
        clearTimeout(timer)
      }
    }
    try {
      await next("ready")
      return kind === "linux" ? { kind, child, completed, next } : { kind, child, completed, next, get pasted() { return pasted } }
    } catch (err) {
      child.kill()
      throw err
    }
  }

  release(target: InputTarget | undefined): void {
    if (target && typeof target !== "string" && !(target.kind === "windows" && target.pasted)) target.child.kill()
  }

  async restoreFocus(pid: number | undefined): Promise<void> {
    if (process.platform !== "darwin" || !pid || pid <= 0) return
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", join(this.directory, "insert-macos.js"), String(pid), "restore"], { stdio: ["ignore", "ignore", "pipe"] })
      let error = ""
      const timer = setTimeout(() => child.kill(), 5000)
      child.stderr.on("data", data => { error = (error + String(data)).slice(0, 1024) })
      child.on("error", err => { clearTimeout(timer); reject(err) })
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(error || `Could not restore focus (code ${code}, signal ${signal || "none"})`))
      })
    })
  }

  async insert(target: InputTarget | undefined, text: string, signal: AbortSignal, trace?: { id: string; startedAt: number }): Promise<boolean> {
    if (!target || text.length > 30000) return false
    if (typeof target !== "string") {
      signal.throwIfAborted()
      if (target.kind === "windows") {
        await this.clipboardRestore
        signal.throwIfAborted()
        this.clipboardRestore = target.completed.catch(() => {
          if (target.pasted && typeof this.api.Log === "function") void this.api.Log(this.ctx, "Warning", "Could not restore the clipboard after dictation paste").catch(() => {})
        })
        const done = target.next("done")
        target.child.stdin.end(`${JSON.stringify({ text: text.replace(/\r\n|\r|\n/g, "\r\n"), traceId: trace?.id, traceStartedAt: trace?.startedAt })}\n`)
        await done
        return true
      }
      if (target.kind === "linux") {
        const checked = target.next("checked")
        target.child.stdin.write(`${JSON.stringify({ op: "check" })}\n`)
        await checked
        signal.throwIfAborted()
        await this.api.Copy(this.ctx, { type: "text", text })
        signal.throwIfAborted()
        const done = target.next("done")
        target.child.stdin.end(`${JSON.stringify({ op: "paste" })}\n`)
        await done
        await target.completed
        return true
      }
      const timer = setTimeout(() => target.child.kill(), 10000)
      try {
        await this.api.Copy(this.ctx, { type: "text", text })
        signal.throwIfAborted()
        target.child.stdin.end(JSON.stringify({ op: "paste" }), "utf8")
        await target.completed
        return true
      } finally {
        clearTimeout(timer)
      }
    }
    if (process.platform !== "win32") return false
    await this.clipboardRestore
    signal.throwIfAborted()
    await this.run("insert", signal, JSON.stringify({ target, text: text.replace(/\r\n|\r|\n/g, "\r\n") }))
    return true
  }
}
