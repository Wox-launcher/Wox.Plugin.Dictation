import { fork } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"

test("ASR timing reports segment and finalization costs without transcript text", async () => {
  const root = await mkdtemp(join(tmpdir(), "dictation-asr-timing-"))
  try {
    const modules = join(root, "node_modules")
    await mkdir(join(modules, "sherpa-onnx-node"), { recursive: true })
    await mkdir(join(modules, "node-cpal"), { recursive: true })
    await writeFile(join(modules, "sherpa-onnx-node", "index.js"), `
      exports.OfflineRecognizer = { createAsync: async () => ({
        createStream: () => ({ acceptWaveform() {} }),
        decodeAsync: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { text: 'private transcript' } }
      }) };
      exports.Vad = class {
        constructor() { this.ready = false }
        acceptWaveform() { this.ready = true }
        isEmpty() { return !this.ready }
        front() { return { samples: new Float32Array(512) } }
        pop() { this.ready = false }
        flush() {}
      };
      exports.LinearResampler = class { resample(samples) { return samples } };
    `)
    await writeFile(join(modules, "node-cpal", "index.js"), `
      exports.convenience = {
        getDefaultInputDevice: () => ({ deviceId: 'mic' }),
        getDefaultInputConfig: () => ({ sampleRate: 16000, channels: 1 }),
        createInputStream: async options => {
          setTimeout(() => options.onData(new Float32Array(512)), 20);
          return { close: async () => {} };
        }
      };
    `)
    const source = await readFile(join(process.cwd(), "src/engine-worker.ts"), "utf8")
    const worker = join(root, "worker.js")
    await writeFile(worker, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText)
    const child = fork(worker, [], { env: { ...process.env, DICTATION_RUNTIME: root }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    try {
      type Message = { id?: number; event?: string; data?: unknown; error?: string }
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
      child.send({ id: 1, method: "start", option: { modelPath: root, kind: "senseVoice", keepMicrophoneReady: true, traceId: "timing-test", traceStartedAt: Date.now() } })
      expect((await waitFor(message => message.id === 1)).error).toBeUndefined()
      await waitFor(message => message.event === "diagnostic" && String(message.data).includes("stage=asr_segment_completed"))
      child.send({ id: 2, method: "stop", option: {} })
      expect((await waitFor(message => message.id === 2)).error).toBeUndefined()
      const timings = messages.filter(message => message.event === "diagnostic" && String(message.data).includes("session=timing-test")).map(message => String(message.data))
      expect(timings.some(line => /stage=asr_segment_completed.*audioMs=\d+ queueMs=\d+ decodeMs=\d+/.test(line))).toBe(true)
      expect(timings.some(line => /stage=asr_flush_completed.*waitMs=\d+ segments=\d+/.test(line))).toBe(true)
      expect(timings.every(line => !line.includes("private transcript"))).toBe(true)
    } finally {
      const exited = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
