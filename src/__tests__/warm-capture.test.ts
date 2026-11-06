import { fork } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"

test("warm microphone replays recent audio and remains open until explicitly released", async () => {
  const root = await mkdtemp(join(tmpdir(), "dictation-warm-"))
  try {
    const modules = join(root, "node_modules")
    await mkdir(join(modules, "sherpa-onnx-node"), { recursive: true })
    await mkdir(join(modules, "node-cpal"), { recursive: true })
    await writeFile(join(modules, "sherpa-onnx-node", "index.js"), `
      exports.OfflineRecognizer = { createAsync: async () => ({}) };
      exports.Vad = class {
        acceptWaveform(samples) { process.send({ event: 'vad_audio', data: samples[0] }) }
        isEmpty() { return true } flush() {}
      };
      exports.LinearResampler = class { resample(samples) { return samples } };
    `)
    await writeFile(join(modules, "node-cpal", "index.js"), `
      exports.convenience = {
        getDefaultInputDevice: () => ({ deviceId: 'mic' }),
        getDefaultInputConfig: () => ({ sampleRate: 16000, channels: 1 }),
        createInputStream: async options => {
          process.send({ event: 'input_opened' });
          const timer = setInterval(() => options.onData(new Float32Array(512).fill(0.5)), 32);
          return { close: async () => { clearInterval(timer); process.send({ event: 'input_closed' }) } };
        }
      };
    `)
    const source = await readFile(join(process.cwd(), "src/engine-worker.ts"), "utf8")
    const worker = join(root, "worker.js")
    await writeFile(worker, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText)
    const child = fork(worker, [], { env: { ...process.env, DICTATION_RUNTIME: root }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    try {
      type Message = { id?: number; event?: string; error?: string; data?: unknown }
      const messages: Message[] = []
      child.on("message", (message: Message) => messages.push(message))
      const waitFor = async (predicate: (message: Message) => boolean) => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const found = messages.find(predicate)
          if (found) return found
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        throw new Error("Timed out waiting for worker")
      }
      const request = async (id: number, method: string, option: object = {}) => {
        child.send({ id, method, option })
        expect((await waitFor(message => message.id === id)).error).toBeUndefined()
      }
      await request(1, "warm-microphone")
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(messages.some(message => message.event === "vad_audio")).toBe(false)
      await request(2, "start", { modelPath: root, kind: "senseVoice", startedAt: Date.now(), preRoll: true, keepMicrophoneReady: true, traceId: "warm-trace", traceStartedAt: Date.now() })
      const startIndex = messages.findIndex(message => message.id === 2)
      expect(messages.findIndex(message => message.event === "vad_audio")).toBeLessThan(startIndex)
      expect(messages.filter(message => message.event === "input_opened")).toHaveLength(1)
      expect(messages.some(message => message.event === "diagnostic" && String(message.data).includes("session=warm-trace stage=microphone_ready") && String(message.data).includes("reused=true"))).toBe(true)
      expect(messages.some(message => message.event === "diagnostic" && String(message.data).includes("session=warm-trace stage=sound_skipped"))).toBe(true)
      await request(3, "stop-capture", { keepMicrophoneReady: true })
      await request(4, "stop")
      expect(messages.filter(message => message.event === "input_closed")).toHaveLength(0)
      await request(5, "start", { modelPath: root, kind: "senseVoice", keepMicrophoneReady: true })
      await request(6, "cancel", { keepMicrophoneReady: false })
      expect(messages.filter(message => message.event === "input_closed")).toHaveLength(1)
      await request(7, "start", { modelPath: root, kind: "senseVoice", playSound: false, keepMicrophoneReady: true })
      await request(8, "stop-capture", { keepMicrophoneReady: true })
      await request(9, "sound", { sound: "stop", traceId: "cancel-disabled", traceStartedAt: Date.now() })
      await request(10, "cancel", { keepMicrophoneReady: false })
      expect(messages.filter(message => message.event === "input_closed")).toHaveLength(2)
      expect(messages.some(message => message.event === "diagnostic" && String(message.data).includes("session=cancel-disabled stage=sound_skipped") && String(message.data).includes("kind=stop reason=disabled"))).toBe(true)
      await request(11, "start", { modelPath: root, kind: "senseVoice", keepMicrophoneReady: true })
      await request(12, "cancel", { keepMicrophoneReady: false })
    } finally {
      const exited = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
