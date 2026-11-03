import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { Context, PublicAPI } from "@wox-launcher/wox-plugin"

interface MacTarget { kind: "mac"; child: ChildProcessWithoutNullStreams; completed: Promise<void> }
interface LinuxTarget { kind: "linux"; child: ChildProcessWithoutNullStreams; completed: Promise<void>; next: (expected: string) => Promise<void> }
export type InputTarget = string | MacTarget | LinuxTarget

export class TextInsert {
  constructor(private readonly api: PublicAPI, private readonly ctx: Context, private readonly directory: string) {}

  private run(mode: "capture" | "insert", signal: AbortSignal, input = ""): Promise<string> {
    return new Promise((resolve, reject) => {
      const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(this.directory, "insert-windows.ps1"), mode], {
        windowsHide: true, signal, stdio: ["pipe", "pipe", "pipe"]
      })
      let output = "", error = ""
      const timeout = setTimeout(() => child.kill(), 10000)
      child.stdout.on("data", data => { output = (output + String(data)).slice(0, 1024) })
      child.stderr.on("data", data => { error = (error + String(data)).slice(0, 1024) })
      child.stdin.on("error", () => {})
      child.on("error", err => { clearTimeout(timeout); reject(err) })
      child.on("close", code => { clearTimeout(timeout); if (code === 0) resolve(output.trim()); else reject(new Error(error || "Could not insert text")) })
      child.stdin.end(input, "utf8")
    })
  }

  async capture(pid: number | undefined, signal: AbortSignal): Promise<InputTarget | undefined> {
    if (!pid || pid <= 0) return undefined
    if (process.platform === "darwin") return this.captureMac(pid, signal)
    if (process.platform === "linux") return this.captureLinux(pid, signal)
    if (process.platform !== "win32") return undefined
    const target = await this.run("capture", signal)
    return /^\d+:\d+:\d+$/.test(target) && Number(target.split(":")[2]) === pid ? target : undefined
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
      child.on("close", code => code === 0 ? resolve() : reject(new Error(error || "Could not insert text")))
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

  private async captureLinux(pid: number, signal: AbortSignal): Promise<LinuxTarget> {
    const child = spawn("python3", ["-u", join(this.directory, "insert-linux.py"), String(pid)], { signal, stdio: ["pipe", "pipe", "pipe"] })
    let error = ""
    child.stderr.on("data", data => { error = (error + String(data)).slice(0, 1024) })
    child.stdin.on("error", () => {})
    const lines = createInterface({ input: child.stdout })
    const pending: string[] = []
    let deliver: (() => void) | undefined
    lines.on("line", line => { pending.push(line); deliver?.() })
    const completed = new Promise<void>((resolve, reject) => {
      child.on("error", reject)
      child.on("close", code => code === 0 ? resolve() : reject(new Error(error || "Could not insert text")))
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
      return { kind: "linux", child, completed, next }
    } catch (err) {
      child.kill()
      throw err
    }
  }

  release(target: InputTarget | undefined): void {
    if (target && typeof target !== "string") target.child.kill()
  }

  async insert(target: InputTarget | undefined, text: string, signal: AbortSignal): Promise<boolean> {
    if (!target || text.length > 30000) return false
    if (typeof target !== "string") {
      signal.throwIfAborted()
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
        target.child.stdin.end(JSON.stringify({ text }), "utf8")
        await target.completed
        return true
      } finally {
        clearTimeout(timer)
      }
    }
    if (process.platform !== "win32") return false
    const paste = /[\r\n]/.test(text)
    if (paste) {
      signal.throwIfAborted()
      if (await this.run("capture", signal) !== target) return false
      await this.api.Copy(this.ctx, { type: "text", text: text.replace(/\r\n|\r|\n/g, "\r\n") })
    }
    signal.throwIfAborted()
    await this.run("insert", signal, JSON.stringify({ target, text: paste ? "" : text, paste }))
    return true
  }
}
