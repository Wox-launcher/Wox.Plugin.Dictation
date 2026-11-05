import { fork } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"

test("retries reconnects, reopens a failed warm stream, and never switches the chosen microphone", async () => {
  const root = await mkdtemp(join(tmpdir(), "dictation-reconnect-"))
  try {
    const modules = join(root, "node_modules")
    await mkdir(join(modules, "sherpa-onnx-node"), { recursive: true })
    await mkdir(join(modules, "node-cpal"), { recursive: true })
    await writeFile(join(modules, "sherpa-onnx-node", "index.js"), `
      exports.OfflineRecognizer = { createAsync: async () => ({}) };
      exports.Vad = class { acceptWaveform() {} isEmpty() { return true } flush() {} };
      exports.LinearResampler = class { resample(samples) { return samples } };
    `)
    await writeFile(join(modules, "node-cpal", "index.js"), `
      const fs = require('fs'), path = require('path');
      const mode = () => fs.readFileSync(path.join(process.env.DICTATION_RUNTIME, 'mode'), 'utf8');
      let attempts = 0;
      exports.convenience = {
        getDevices: () => mode() === 'missing' ? [] : [{ deviceId: 'wireless' }],
        getDefaultInputDevice: () => { process.send({ event: 'default_used' }); return { deviceId: 'fallback' } },
        getDefaultInputConfig: () => ({ sampleRate: 16000, channels: 1 }),
        createInputStream: async options => {
          attempts++;
          process.send({ event: 'open_attempt', data: options.deviceId });
          if (mode() === 'com') throw new Error('os error -2147417850');
          if (mode() === 'reconnect' && attempts < 3) throw new Error('device not ready');
          let failed = false;
          const timer = setInterval(() => {
            if (mode() === 'lost' && !failed) { failed = true; options.onError(new Error('disconnected')); }
            if (!failed && mode() !== 'stall') options.onData(new Float32Array(512));
          }, 20);
          return { close: async () => { clearInterval(timer); process.send({ event: 'closed' }) } };
        }
      };
    `)
    const source = await readFile(join(process.cwd(), "src/engine-worker.ts"), "utf8")
    const worker = join(root, "worker.js")
    await writeFile(worker, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText)
    await writeFile(join(root, "mode"), "reconnect")
    const child = fork(worker, [], { env: { ...process.env, DICTATION_RUNTIME: root }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    try {
      type Message = { id?: number; event?: string; error?: string; data?: unknown }
      const messages: Message[] = []
      child.on("message", (message: Message) => messages.push(message))
      const waitFor = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error("Timed out waiting for microphone")
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      const request = async (id: number, method: string, option: object = {}) => {
        child.send({ id, method, option })
        await waitFor(() => messages.some(message => message.id === id))
        return messages.find(message => message.id === id)!
      }
      const start = { modelPath: root, kind: "senseVoice", deviceId: "wireless", keepMicrophoneReady: true }
      expect((await request(1, "start", start)).error).toBeUndefined()
      expect(messages.filter(message => message.event === "open_attempt")).toHaveLength(3)
      await request(2, "cancel", { keepMicrophoneReady: true })
      await writeFile(join(root, "mode"), "lost")
      await waitFor(() => messages.some(message => message.event === "warning" && String(message.data).includes("disconnected")))
      await writeFile(join(root, "mode"), "ready")
      expect((await request(3, "start", start)).error).toBeUndefined()
      expect(messages.filter(message => message.event === "open_attempt")).toHaveLength(4)
      expect(messages.filter(message => message.event === "closed")).toHaveLength(1)
      await request(4, "cancel", { keepMicrophoneReady: false })
      await writeFile(join(root, "mode"), "missing")
      expect((await request(5, "start", start)).error).toContain("MICROPHONE_UNAVAILABLE")
      expect(messages.some(message => message.event === "default_used")).toBe(false)
      await writeFile(join(root, "mode"), "com")
      const before = messages.filter(message => message.event === "open_attempt").length
      expect((await request(6, "start", start)).error).toContain("-2147417850")
      expect(messages.filter(message => message.event === "open_attempt")).toHaveLength(before + 1)
      await writeFile(join(root, "mode"), "stall")
      expect((await request(7, "start", start)).error).toBeUndefined()
      await request(8, "cancel", { keepMicrophoneReady: true })
      await new Promise(resolve => setTimeout(resolve, 2100))
      const staleAttempts = messages.filter(message => message.event === "open_attempt").length
      expect((await request(9, "start", start)).error).toBeUndefined()
      expect(messages.filter(message => message.event === "open_attempt")).toHaveLength(staleAttempts + 1)
      await request(10, "cancel", { keepMicrophoneReady: false })
    } finally {
      const exited = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
