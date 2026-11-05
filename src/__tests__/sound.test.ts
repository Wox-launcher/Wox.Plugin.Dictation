import { fork } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"

test("start cue has two audible tones and a short output-device lead", async () => {
  const wave = await readFile(join(process.cwd(), "sounds", "dictation_start.wav"))
  expect(wave.toString("ascii", 0, 4)).toBe("RIFF")
  expect(wave.readUInt16LE(22)).toBe(1)
  expect(wave.readUInt16LE(34)).toBe(16)
  const rate = wave.readUInt32LE(24)
  const samples = Array.from({ length: (wave.length - 44) / 2 }, (_, i) => wave.readInt16LE(44 + i * 2))
  const peak = (from: number, to: number) => Math.max(...samples.slice(Math.floor(from * rate), Math.floor(to * rate)).map(Math.abs))
  expect(samples.length / rate).toBeGreaterThan(0.4)
  expect(peak(0, 0.035)).toBe(0)
  expect(peak(0.05, 0.13)).toBeGreaterThan(1000)
  expect(peak(0.14, 0.155)).toBe(0)
  expect(peak(0.17, 0.28)).toBeGreaterThan(1000)
  expect(peak(0.3, samples.length / rate)).toBe(0)
})

test("stop cue has two descending tones matching the start cue", async () => {
  const wave = await readFile(join(process.cwd(), "sounds", "dictation_stop.wav"))
  expect(wave.toString("ascii", 0, 4)).toBe("RIFF")
  expect(wave.readUInt16LE(22)).toBe(1)
  expect(wave.readUInt16LE(34)).toBe(16)
  const rate = wave.readUInt32LE(24)
  const samples = Array.from({ length: (wave.length - 44) / 2 }, (_, i) => wave.readInt16LE(44 + i * 2))
  const slice = (from: number, to: number) => samples.slice(Math.floor(from * rate), Math.floor(to * rate))
  const crossings = (values: number[]) => values.reduce((count, value, i) => count + (i > 0 && values[i - 1] <= 0 && value > 0 ? 1 : 0), 0)
  expect(samples.length / rate).toBeGreaterThan(0.38)
  expect(Math.max(...slice(0.1, 0.115).map(Math.abs))).toBe(0)
  expect(crossings(slice(0.015, 0.075))).toBeGreaterThan(crossings(slice(0.135, 0.195)))
  expect(Math.max(...slice(0.26, samples.length / rate).map(Math.abs))).toBe(0)
})

test("feedback reuses its output, queues consecutive sounds, and releases it after idle", async () => {
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
      let opens = 0;
      exports.convenience = {
        getDefaultInputDevice: () => ({ deviceId: 'mic' }),
        getDefaultInputConfig: () => ({ sampleRate: 16000, channels: 1 }),
        createInputStream: async () => ({ close: async () => {} }),
        getDefaultOutputDevice: () => ({ deviceId: 'speaker' }),
        getDefaultOutputConfig: () => ({ sampleRate: 16000, channels: 1 }),
        createOutputStream: async () => {
          const id = ++opens;
          await new Promise(resolve => setTimeout(resolve, 50));
          process.send({ event: 'opened', data: id });
          let writes = 0, buffered = 0;
          return {
            get bufferedFrames() { return buffered },
            write() {
              writes++;
              process.send({ event: 'write', data: { id, writes } });
              if (writes === 2) return false;
              buffered++;
              setTimeout(() => { buffered-- }, 150);
              return true;
            },
            play() {},
            async close() { process.send({ event: 'output_closed', data: { id, buffered } }) }
          };
        }
      };
    `)
    const source = await readFile(join(process.cwd(), "src/engine-worker.ts"), "utf8")
    const worker = join(root, "worker.js")
    const timers = "const originalTimeout = global.setTimeout; global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 300000 ? 400 : ms, ...args);\n"
    await writeFile(worker, timers + ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText)
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
      child.send({ id: 1, method: "start", option: { modelPath: root, kind: "senseVoice", playSound: true, traceId: "sound-trace", traceStartedAt: Date.now() } })
      expect((await waitFor(message => message.id === 1)).error).toBeUndefined()
      child.send({ id: 2, method: "sound", option: { sound: "start" } })
      child.send({ id: 3, method: "sound", option: { sound: "stop" } })
      child.send({ id: 4, method: "sound", option: { sound: "start" } })
      expect((await waitFor(message => message.id === 4)).error).toBeUndefined()
      await waitFor(message => message.event === "write" && (message.data as { writes: number }).writes === 3)
      await waitFor(message => message.event === "diagnostic" && String(message.data).includes("session=sound-trace stage=sound_submitted") && String(message.data).includes("kind=start"))
      expect(messages.filter(message => message.event === "opened")).toHaveLength(1)
      expect(messages.filter(message => message.event === "warning").map(message => message.data)).toEqual([expect.stringContaining("output queue is full")])
      const closed = await waitFor(message => message.event === "output_closed")
      expect(closed.data).toEqual({ id: 1, buffered: 0 })
      child.send({ id: 5, method: "sound", option: { sound: "stop" } })
      await waitFor(message => message.event === "opened" && message.data === 2)
    } finally {
      const exited = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
