import { fork } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"

test("starting capture starts the input stream and publishes microphone levels", async () => {
  const root = await mkdtemp(join(tmpdir(), "dictation-capture-"))
  const modules = join(root, "node_modules")
  const worker = join(root, "worker.js")
  try {
    await mkdir(join(modules, "sherpa-onnx-node"), { recursive: true })
    await mkdir(join(modules, "node-cpal"), { recursive: true })
    await writeFile(join(modules, "sherpa-onnx-node", "index.js"), `
      exports.version = 'test';
      exports.OfflineRecognizer = { createAsync: async () => ({}) };
      exports.Vad = class { constructor(config) { process.send({ event: 'vad_config', data: config.sileroVad }); } acceptWaveform() {} isEmpty() { return true } flush() {} };
      exports.LinearResampler = class { resample(samples) { return samples } };
    `)
    await writeFile(join(modules, "node-cpal", "index.js"), `
      exports.convenience = {
        getDefaultInputDevice: () => ({ deviceId: 'mic' }),
        getDevices: () => [{ deviceId: 'bad' }, { deviceId: 'quiet' }],
        getDefaultInputConfig: () => ({ sampleRate: 16000, channels: 1 }),
        createInputStream: async options => {
          if (!options.autoStart) throw new Error('input stream was not started');
          if (options.queueCapacityBuffers !== 128) throw new Error('input queue is too small');
          setImmediate(() => {
            if (options.deviceId === 'bad') return options.onError(Object.assign(new Error('device lost'), { code: 'DEVICE_NOT_AVAILABLE' }));
            options.onError(Object.assign(new Error('buffer interruption'), { code: 'XRUN' }));
            options.onData(new Float32Array(512).fill(0.05));
            if (options.deviceId !== 'quiet') options.onError(Object.assign(new Error('buffer interruption'), { code: 'XRUN' }));
          });
          return { close: async () => { process.send({ event: 'capture_closed' }); } };
        }
      };
    `)
    const source = await readFile(join(process.cwd(), "src/engine-worker.ts"), "utf8")
    await writeFile(worker, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText)
    const child = fork(worker, [], { env: { ...process.env, DICTATION_RUNTIME: root }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    try {
      const events: string[] = []
      let vadConfig: unknown
      child.on("message", (message: { event?: string; data?: unknown }) => { if (message.event === "vad_config") vadConfig = message.data })
      child.on("message", (message: { event?: string }) => { if (message.event) events.push(message.event) })
      const level = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for audio level")), 5000)
        child.on("message", (message: { id?: number; error?: string; event?: string; data?: number }) => {
          if (message.error) { clearTimeout(timer); reject(new Error(message.error)) }
          if (message.event === "level") { clearTimeout(timer); resolve(message.data!) }
        })
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`Worker exited: ${code}`)) })
        child.send({ id: 1, method: "start", option: { modelPath: root, kind: "senseVoice" } })
      })
      expect(level).toBeGreaterThan(0)
      expect(vadConfig).toMatchObject({ threshold: 0.35, minSpeechDuration: 0.15, minSilenceDuration: 0.5, maxSpeechDuration: 20, windowSize: 512 })
      const captureClosed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for capture to stop")), 5000)
        child.on("message", (message: { id?: number; error?: string }) => {
          if (message.id === 4) { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve() }
        })
      })
      child.send({ id: 4, method: "stop-capture", option: {} })
      await captureClosed
      const stopped = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for stop")), 5000)
        child.on("message", (message: { id?: number; error?: string }) => {
          if (message.id === 2) { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve() }
        })
      })
      child.send({ id: 2, method: "stop", option: {} })
      await stopped
      expect(events).toContain("capture_gap")
      expect(events).toContain("warning")
      expect(events).not.toContain("error")
      const request = (id: number, method: string, option: object = {}) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5000)
        child.on("message", function listener(message: { id?: number; error?: string }) {
          if (message.id !== id) return
          child.off("message", listener)
          clearTimeout(timer)
          if (message.error) reject(new Error(message.error)); else resolve()
        })
        child.send({ id, method, option })
      })
      await request(7, "start", { modelPath: root, kind: "senseVoice" })
      const closedBefore = events.filter(event => event === "capture_closed").length
      await request(8, "cancel")
      expect(events.filter(event => event === "capture_closed")).toHaveLength(closedBefore + 1)
      await request(9, "start", { modelPath: root, kind: "senseVoice" })
      await request(10, "cancel")
      if (process.platform === "win32") {
        const gapsBefore = events.filter(event => event === "capture_gap").length
        const quietLevel = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out waiting for second capture")), 5000)
          child.on("message", (message: { event?: string }) => {
            if (message.event === "level") { clearTimeout(timer); resolve() }
          })
        })
        child.send({ id: 5, method: "start", option: { modelPath: root, kind: "senseVoice", deviceId: "quiet" } })
        await quietLevel
        const quietStop = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out waiting for second stop")), 5000)
          child.on("message", (message: { id?: number; error?: string }) => {
            if (message.id === 6) { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve() }
          })
        })
        child.send({ id: 6, method: "stop", option: {} })
        await quietStop
        expect(events.filter(event => event === "capture_gap")).toHaveLength(gapsBefore)
      }
      const fatal = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for device error")), 5000)
        child.on("message", (message: { event?: string; data?: string }) => {
          if (message.event === "error") { clearTimeout(timer); if (message.data === "MICROPHONE_UNAVAILABLE: device lost") resolve(); else reject(new Error(String(message.data))) }
        })
      })
      child.send({ id: 3, method: "start", option: { modelPath: root, kind: "senseVoice", deviceId: "bad" } })
      await fatal
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once("exit", resolve))
        child.kill()
        await exited
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
