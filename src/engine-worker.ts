import { createRequire } from "node:module"
import { join } from "node:path"
import { availableParallelism } from "node:os"

interface AudioDevice {
  deviceId: string
  name: string
}
interface AudioStream {
  close(): Promise<void>
}
interface Microphone {
  getDevices(option: { direction: string }): AudioDevice[]
  getDefaultOutputDevice(): AudioDevice
  getDefaultOutputConfig(id: string): { sampleRate: number; channels: number }
  createOutputStream(option: unknown): Promise<{ readonly bufferedFrames: number; write(data: Float32Array): boolean; play(): void; close(): Promise<void> }>
  getDefaultInputDevice(): AudioDevice
  getDefaultInputConfig(id: string): { sampleRate: number; channels: number }
  createInputStream(option: {
    deviceId: string
    config: { sampleRate: number; channels: number; sampleFormat: string }
    autoStart: boolean
    queueCapacityBuffers: number
    onData(data: Float32Array): void
    onError(error: Error & { code?: string }): void
  }): Promise<AudioStream>
}
interface Stream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
}
interface Recognizer {
  createStream(): Stream
  decodeAsync(stream: Stream): Promise<{ text: string }>
}
interface Vad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  isDetected(): boolean
  front(copy: boolean): { samples: Float32Array }
  pop(): void
  flush(): void
}
interface Sherpa {
  version: string
  OfflineRecognizer: { createAsync(config: unknown): Promise<Recognizer> }
  Vad: new (config: unknown, seconds: number) => Vad
  LinearResampler: new (from: number, to: number) => { resample(samples: Float32Array, flush?: boolean): Float32Array }
  readWave(path: string): { samples: Float32Array; sampleRate: number }
}
interface Request {
  id: number
  method: string
  option: { modelPath?: string; kind?: string; deviceId?: string; path?: string; playSound?: boolean; sound?: "start" | "stop" }
}
const requireRuntime = createRequire(join(process.env.DICTATION_RUNTIME!, "entry.js"))
const sherpa = requireRuntime("sherpa-onnx-node") as Sherpa
const cpal = (requireRuntime("node-cpal") as { convenience: Microphone }).convenience
let resampler: { resample(samples: Float32Array, flush?: boolean): Float32Array } | undefined
let audio: AudioStream | undefined
let captureStopped = false
let recognizer: Recognizer | undefined
let modelKey = ""
let vad: Vad | undefined
let pending = new Float32Array(0)
let transcript: string[] = []
let decoding = Promise.resolve()
let fatalError: Error | undefined
let sampleCount = 0
let levelTime = 0
let playSound = false
let captureGap = false

function emit(event: string, data: unknown): void {
  process.send?.({ event, data })
}

// Async decoding leaves the audio callback free to drain its bounded native queue.
function drain(): void {
  while (vad && !vad.isEmpty()) {
    const samples = new Float32Array(vad.front(false).samples)
    vad.pop()
    decoding = decoding
      .then(async () => {
        const stream = recognizer!.createStream()
        stream.acceptWaveform({ samples, sampleRate: 16000 })
        const result = await recognizer!.decodeAsync(stream)
        if (result.text.trim()) transcript.push(result.text.trim())
        emit("partial", transcript.join(" "))
      })
      .catch(error => {
        fatalError = error
        emit("error", String(error))
      })
  }
}

// Every VAD window is 512 mono float samples, independent of hardware sample rate.
function accept(samples: Float32Array): void {
  sampleCount += samples.length
  if (sampleCount > 16000 * 300) {
    emit("limit", null)
    return
  }
  if (Date.now() - levelTime > 80) {
    levelTime = Date.now()
    emit("level", Math.min(1, Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / Math.max(1, samples.length)) * 8))
  }
  const data = new Float32Array(pending.length + samples.length)
  data.set(pending)
  data.set(samples, pending.length)
  let i = 0
  for (; i + 512 <= data.length; i += 512) vad!.acceptWaveform(data.subarray(i, i + 512))
  pending = data.slice(i)
  drain()
}

async function load(option: Request["option"]): Promise<void> {
  const key = `${option.kind}:${option.modelPath}`
  if (recognizer && key === modelKey) {
    emit("diagnostic", "worker model cache hit")
    return
  }
  const started = Date.now()
  emit("diagnostic", `worker model load started kind=${option.kind}`)
  const file = (name: string) => join(option.modelPath!, name)
  const modelConfig =
    option.kind === "qwen3Asr"
      ? { qwen3Asr: { convFrontend: file("conv_frontend.onnx"), encoder: file("encoder.int8.onnx"), decoder: file("decoder.int8.onnx"), tokenizer: file("tokenizer") }, tokens: "" }
      : { senseVoice: { model: file("model.int8.onnx"), useInverseTextNormalization: 1 }, tokens: file("tokens.txt") }
  recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...modelConfig, numThreads: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))), provider: "cpu", debug: 0 }
  })
  modelKey = key
  emit("diagnostic", `worker model load completed elapsedMs=${Date.now() - started}`)
}

// Reset only between sessions; decoded segments retain their own sample buffers.
function resetPipeline(option: Request["option"]): void {
  transcript = []
  pending = new Float32Array(0)
  fatalError = undefined
  captureGap = false
  sampleCount = 0
  levelTime = 0
  vad = new sherpa.Vad(
    {
      sileroVad: { model: join(option.modelPath!, "silero_vad.onnx"), threshold: 0.35, minSpeechDuration: 0.15, minSilenceDuration: 0.5, maxSpeechDuration: 20, windowSize: 512 },
      sampleRate: 16000,
      numThreads: 1,
      debug: false
    },
    60
  )
}

// Flush the partial VAD window and await every queued segment before returning the final text.
async function finishPipeline(): Promise<{ text: string }> {
  if (pending.length) {
    const tail = new Float32Array(512)
    tail.set(pending)
    vad!.acceptWaveform(tail)
    pending = new Float32Array(0)
  }
  vad!.flush()
  drain()
  await decoding
  if (fatalError) throw fatalError
  return { text: transcript.join(" ") }
}

// Feedback playback is optional; an unavailable speaker must not stop transcription.
async function sound(name: "start" | "stop"): Promise<void> {
  if (!playSound) return
  let output: Awaited<ReturnType<Microphone["createOutputStream"]>> | undefined
  try {
    const wave = sherpa.readWave(join(__dirname, "sounds", `dictation_${name}.wav`))
    const device = cpal.getDefaultOutputDevice(),
      config = cpal.getDefaultOutputConfig(device.deviceId)
    const mono = new sherpa.LinearResampler(wave.sampleRate, config.sampleRate).resample(wave.samples, true)
    const samples = new Float32Array(mono.length * config.channels)
    for (let i = 0; i < mono.length; i++) for (let ch = 0; ch < config.channels; ch++) samples[i * config.channels + ch] = mono[i]
    output = await cpal.createOutputStream({ deviceId: device.deviceId, config: { ...config, sampleFormat: "f32" }, autoStart: false, onError: (error: Error) => emit("warning", error.message) })
    if (!output.write(samples)) throw new Error("Feedback sound output queue is full")
    output.play()
    const deadline = Date.now() + (mono.length / config.sampleRate) * 1000 + 2000
    while (output.bufferedFrames > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    if (output.bufferedFrames > 0) throw new Error("Feedback sound output timed out")
    await new Promise(resolve => setTimeout(resolve, 100))
  } catch (error) {
    emit("warning", `Feedback sound unavailable: ${String(error)}`)
  } finally {
    await output?.close()
  }
}

async function handle(request: Request): Promise<unknown> {
  const { method, option } = request
  if (method === "status") return { version: sherpa.version }
  if (method === "sound") {
    if (option.sound === "start" || option.sound === "stop") void sound(option.sound).catch(error => emit("warning", `Feedback sound unavailable: ${String(error)}`))
    return {}
  }
  if (method === "devices") return cpal.getDevices({ direction: "input" })
  if (method === "preload") {
    await load(option)
    return {}
  }
  if (method === "decode") {
    await load(option)
    const stream = recognizer!.createStream()
    stream.acceptWaveform(sherpa.readWave(option.path!))
    return recognizer!.decodeAsync(stream)
  }
  if (method === "decode-vad") {
    await load(option)
    resetPipeline(option)
    const wave = sherpa.readWave(option.path!)
    const converter = new sherpa.LinearResampler(wave.sampleRate, 16000)
    for (let i = 0; i < wave.samples.length; i += 1024) accept(converter.resample(wave.samples.subarray(i, i + 1024)))
    accept(converter.resample(new Float32Array(0), true))
    return finishPipeline()
  }
  if (method === "start") {
    if (audio) throw new Error("Already recording")
    await load(option)
    resetPipeline(option)
    captureStopped = false
    playSound = option.playSound === true
    const device = option.deviceId ? cpal.getDevices({ direction: "input" }).find(d => d.deviceId === option.deviceId) : cpal.getDefaultInputDevice()
    if (!device) throw new Error("Selected microphone is unavailable")
    const config = cpal.getDefaultInputConfig(device.deviceId)
    resampler = new sherpa.LinearResampler(config.sampleRate, 16000)
    let receivedAudio = false, ignoredInitialXrun = false
    audio = await cpal.createInputStream({
      deviceId: device.deviceId,
      config: { ...config, sampleFormat: "f32" },
      autoStart: true,
      queueCapacityBuffers: 128,
      onData(data) {
        try {
          if (data.length) receivedAudio = true
          const mono = new Float32Array(Math.floor(data.length / config.channels))
          for (let i = 0; i < mono.length; i++) for (let ch = 0; ch < config.channels; ch++) mono[i] += data[i * config.channels + ch] / config.channels
          accept(resampler!.resample(mono))
        } catch (error) {
          fatalError = error as Error
          emit("error", String(error))
        }
      },
      onError(error) {
        if (error.code === "XRUN" || error.code === "INPUT_OVERFLOW") {
          // WASAPI's discontinuity flag is undefined on its first capture buffer.
          if (process.platform === "win32" && error.code === "XRUN" && !receivedAudio && !ignoredInitialXrun) {
            ignoredInitialXrun = true
            return
          }
          if (!captureGap) emit("warning", `Audio capture interruption: ${error.message}`)
          captureGap = true
          return
        }
        fatalError = error
        emit("error", error.message)
      }
    })
    return {}
  }
  if (method === "stop-capture") {
    if (!audio) throw new Error("Not recording")
    await audio.close()
    audio = undefined
    captureStopped = true
    return {}
  }
  if (method === "cancel") {
    if (!audio) throw new Error("Not recording")
    await audio.close()
    audio = undefined
    captureStopped = false
    await decoding
    transcript = []
    pending = new Float32Array(0)
    vad = undefined
    resampler = undefined
    return {}
  }
  if (method === "stop") {
    if (audio) {
      await audio.close()
      audio = undefined
      captureStopped = true
    }
    if (!captureStopped) throw new Error("Not recording")
    captureStopped = false
    accept(resampler!.resample(new Float32Array(0), true))
    const result = await finishPipeline()
    if (captureGap) emit("capture_gap", null)
    return result
  }
  throw new Error(`Unknown engine method: ${method}`)
}

// Serialize commands; cancellation is process termination so native inference cannot delay it.
let commands = Promise.resolve()
process.on("message", (request: Request) => {
  commands = commands.then(async () => {
    try {
      process.send?.({ id: request.id, result: await handle(request) })
    } catch (error) {
      process.send?.({ id: request.id, error: String(error) })
    }
  })
})
process.on("disconnect", () => {
  void audio?.close().finally(() => process.exit())
  if (!audio) process.exit()
})
