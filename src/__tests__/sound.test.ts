import { fork } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"

test("feedback waits for queued audio and reports a rejected write", async () => {
  const root = await mkdtemp(join(tmpdir(), "dictation-sound-"))
  try {
    const modules = join(root, "node_modules")
    await mkdir(join(modules, "sherpa-onnx-node"), { recursive: true })
    await mkdir(join(modules, "node-cpal"), { recursive: true })
    await writeFile(join(modules, "sherpa-onnx-node", "index.js"), `
      exports.OfflineRecognizer = { createAsync: async () => ({}) };
      exports.Vad = class {};
      exports.LinearResampler = class { resample(samples) { return samples } };
      exports.readWave = () => ({ sampleRate: 16000, samples: new Float32Array(1600) });
    `)
    await writeFile(join(modules, "node-cpal", "index.js"), `
      let calls = 0;
      exports.convenience = {
        getDefaultInputDevice: () => ({ deviceId: 'mic' }),
        getDefaultInputConfig: () => ({ sampleRate: 16000, channels: 1 }),
        createInputStream: async () => ({ close: async () => {} }),
        getDefaultOutputDevice: () => ({ deviceId: 'speaker' }),
        getDefaultOutputConfig: () => ({ sampleRate: 16000, channels: 1 }),
        createOutputStream: async () => {
          const call = ++calls;
          let drained = false;
          return {
            get bufferedFrames() { return drained ? 0 : 1600 },
            write() { return call === 1 },
            play() { setTimeout(() => { drained = true }, 300) },
            async close() { process.send({ event: 'output_closed', data: { call, drained } }) }
          };
        }
      };
    `)
    const source = await readFile(join(process.cwd(), "src/engine-worker.ts"), "utf8")
    const worker = join(root, "worker.js")
    await writeFile(worker, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText)
    const child = fork(worker, [], { env: { ...process.env, DICTATION_RUNTIME: root }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    try {
      type Message = { id?: number; event?: string; data?: unknown; error?: string }
      const waitFor = (predicate: (message: Message) => boolean) =>
        new Promise<Message>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out waiting for worker")), 5000)
          child.on("message", function listener(message: Message) {
            if (!predicate(message)) return
            clearTimeout(timer)
            child.off("message", listener)
            resolve(message)
          })
        })
      const started = waitFor(message => message.id === 1)
      child.send({ id: 1, method: "start", option: { modelPath: root, kind: "senseVoice", playSound: true } })
      expect((await started).error).toBeUndefined()
      const closed = waitFor(message => message.event === "output_closed" && (message.data as { call: number }).call === 1)
      child.send({ id: 2, method: "sound", option: { sound: "start" } })
      expect((await closed).data).toMatchObject({ drained: true })
      const warning = waitFor(message => message.event === "warning")
      child.send({ id: 3, method: "sound", option: { sound: "stop" } })
      expect((await warning).data).toContain("output queue is full")
    } finally {
      const exited = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
