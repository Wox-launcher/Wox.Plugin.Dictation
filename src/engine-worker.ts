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
  option: { modelPath?: string; kind?: string; deviceId?: string; path?: string; playSound?: boolean; sound?: "start" | "stop"; startedAt?: number; preRoll?: boolean; keepMicrophoneReady?: boolean; traceId?: string; traceStartedAt?: number }
  receivedAt?: number
}
const requireRuntime = createRequire(join(process.env.DICTATION_RUNTIME!, "entry.js"))
const sherpa = requireRuntime("sherpa-onnx-node") as Sherpa
const cpal = (requireRuntime("node-cpal") as { convenience: Microphone }).convenience
let resampler: { resample(samples: Float32Array, flush?: boolean): Float32Array } | undefined
let audio: AudioStream | undefined
let audioDevice = ""
let recording = false
let keepMicrophoneReady = false
let inputError: Error | undefined
let inputGeneration = 0
let lastInputAt = 0
let recentAudio: { samples: Float32Array; end: number }[] = []
let recentSamples = 0
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
let soundOutput: { deviceId: string; config: { sampleRate: number; channels: number }; stream: Awaited<ReturnType<Microphone["createOutputStream"]>>; playing: boolean } | undefined
let soundTasks = Promise.resolve()
let soundIdle: NodeJS.Timeout | undefined
let recordingTrace: { id: string; startedAt: number } | undefined
let pipelineTrace: { id: string; startedAt: number } | undefined
let segmentCount = 0
let firstLiveAudio = false

function emit(event: string, data: unknown): void {
  process.send?.({ event, data })
}

function timing(trace: { id: string; startedAt: number } | undefined, stage: string, details = ""): void {
  if (!trace?.id) return
  const now = Date.now()
  emit("diagnostic", `[Dictation timing] session=${trace.id} stage=${stage} atMs=${now} elapsedMs=${now - trace.startedAt}${details ? ` ${details}` : ""}`)
}

// Async decoding leaves the audio callback free to drain its bounded native queue.
function drain(): void {
  while (vad && !vad.isEmpty()) {
    const samples = new Float32Array(vad.front(false).samples)
    vad.pop()
    const queuedAt = Date.now(), trace = pipelineTrace, segment = ++segmentCount
    decoding = decoding
      .then(async () => {
        const startedAt = Date.now()
        try {
          const stream = recognizer!.createStream()
          stream.acceptWaveform({ samples, sampleRate: 16000 })
          const result = await recognizer!.decodeAsync(stream)
          if (result.text.trim()) transcript.push(result.text.trim())
          emit("partial", transcript.join(" "))
        } finally {
          timing(trace, "asr_segment_completed", `segment=${segment} audioMs=${Math.round(samples.length / 16)} queueMs=${startedAt - queuedAt} decodeMs=${Date.now() - startedAt}`)
        }
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
  segmentCount = 0
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
  const startedAt = Date.now(), trace = pipelineTrace
  timing(trace, "asr_flush_started")
  if (pending.length) {
    const tail = new Float32Array(512)
    tail.set(pending)
    vad!.acceptWaveform(tail)
    pending = new Float32Array(0)
  }
  vad!.flush()
  drain()
  await decoding
  timing(trace, "asr_flush_completed", `waitMs=${Date.now() - startedAt} segments=${segmentCount}`)
  if (fatalError) throw fatalError
  return { text: transcript.join(" ") }
}

async function openMicrophoneOnce(deviceId = ""): Promise<boolean> {
  const device = deviceId ? cpal.getDevices({ direction: "input" }).find(d => d.deviceId === deviceId) : cpal.getDefaultInputDevice()
  if (!device) throw new Error("Selected microphone is unavailable")
  if (audio && audioDevice === device.deviceId && !inputError && Date.now() - lastInputAt < 2000) return true
  const generation = ++inputGeneration
  if (audio) await audio.close()
  audio = undefined
  recentAudio = []
  recentSamples = 0
  inputError = undefined
  const config = cpal.getDefaultInputConfig(device.deviceId)
  resampler = new sherpa.LinearResampler(config.sampleRate, 16000)
  let receivedAudio = false, ignoredInitialXrun = false
  audio = await cpal.createInputStream({
    deviceId: device.deviceId,
    config: { ...config, sampleFormat: "f32" },
    autoStart: true,
    queueCapacityBuffers: 128,
    onData(data) {
      if (generation !== inputGeneration) return
      try {
        if (data.length) { receivedAudio = true; lastInputAt = Date.now() }
        const mono = new Float32Array(Math.floor(data.length / config.channels))
        for (let i = 0; i < mono.length; i++) for (let ch = 0; ch < config.channels; ch++) mono[i] += data[i * config.channels + ch] / config.channels
        const samples = resampler!.resample(mono)
        if (recording) {
          if (!firstLiveAudio && samples.length) { firstLiveAudio = true; timing(recordingTrace, "first_live_audio") }
          accept(samples)
        }
        else {
          const end = Date.now()
          recentAudio.push({ samples, end })
          recentSamples += samples.length
          while (recentAudio.length && (recentAudio[0].end < end - 5000 || recentSamples > 80000)) {
            const first = recentAudio[0]
            if (first.end >= end - 5000 && recentSamples - first.samples.length < 80000) {
              const trim = recentSamples - 80000
              first.samples = first.samples.slice(trim)
              recentSamples -= trim
              break
            }
            recentSamples -= recentAudio.shift()!.samples.length
          }
        }
      } catch (error) {
        inputError = error as Error
        if (recording) { fatalError = inputError; emit("error", `MICROPHONE_UNAVAILABLE: ${String(error)}`) }
        else emit("warning", `Microphone unavailable: ${String(error)}`)
      }
    },
    onError(error) {
      if (generation !== inputGeneration) return
      if (error.code === "XRUN" || error.code === "INPUT_OVERFLOW") {
        if (process.platform === "win32" && error.code === "XRUN" && !receivedAudio && !ignoredInitialXrun) {
          ignoredInitialXrun = true
          return
        }
        if (recording) {
          if (!captureGap) emit("warning", `Audio capture interruption: ${error.message}`)
          captureGap = true
        }
        return
      }
      inputError = error
      if (recording) { fatalError = error; emit("error", `MICROPHONE_UNAVAILABLE: ${error.message}`) }
      else emit("warning", `Microphone unavailable: ${error.message}`)
    }
  })
  audioDevice = device.deviceId
  if (!receivedAudio) lastInputAt = Date.now()
  if (inputError) throw inputError
  return false
}

async function openMicrophone(deviceId = "", retry = false): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await openMicrophoneOnce(deviceId)
    } catch (error) {
      const detail = String(error)
      if (!retry || attempt >= 2 || /RPC_E_CHANGED_MODE|2147417850|0x80010106|permission|access denied/i.test(detail)) {
        throw new Error(`MICROPHONE_UNAVAILABLE: ${detail}`)
      }
      emit("diagnostic", `Microphone open failed; retrying: ${detail}`)
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 150 : 300))
    }
  }
}

// Serialize output changes independently of capture and recognition.
function queueSound(task: () => Promise<void>): void {
  soundTasks = soundTasks.then(task).catch(error => emit("warning", `Feedback sound unavailable: ${String(error)}`))
}

async function closeSoundOutput(): Promise<void> {
  const output = soundOutput
  soundOutput = undefined
  if (output) await output.stream.close()
}

function sound(name: "start" | "stop", trace?: { id: string; startedAt: number }): void {
  if (!playSound) { timing(trace, "sound_skipped", `kind=${name} reason=disabled`); return }
  const queuedAt = Date.now()
  timing(trace, "sound_queued", `kind=${name}`)
  clearTimeout(soundIdle)
  queueSound(async () => {
    timing(trace, "sound_dequeued", `kind=${name} queueMs=${Date.now() - queuedAt}`)
    clearTimeout(soundIdle)
    try {
      const device = cpal.getDefaultOutputDevice()
      if (soundOutput && soundOutput.deviceId !== device.deviceId) {
        const deadline = Date.now() + 2000
        while (soundOutput.stream.bufferedFrames > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        await new Promise(resolve => setTimeout(resolve, 150))
        await closeSoundOutput()
      }
      const reused = !!soundOutput
      const openStarted = Date.now()
      if (!soundOutput) {
        const config = cpal.getDefaultOutputConfig(device.deviceId)
        let failed = false
        const stream = await cpal.createOutputStream({ deviceId: device.deviceId, config: { ...config, sampleFormat: "f32" }, autoStart: false, onError: (error: Error) => {
          failed = true
          emit("warning", `Feedback sound unavailable: ${error.message}`)
          queueSound(async () => { if (soundOutput?.stream === stream) await closeSoundOutput() })
        } })
        if (failed) { await stream.close(); throw new Error("Audio output failed to open") }
        soundOutput = { deviceId: device.deviceId, config, stream, playing: false }
      }
      timing(trace, "sound_device_ready", `kind=${name} reused=${reused} openMs=${Date.now() - openStarted}`)
      const output = soundOutput
      const { config, stream } = output
      const wave = sherpa.readWave(join(__dirname, "sounds", `dictation_${name}.wav`))
      const mono = new sherpa.LinearResampler(wave.sampleRate, config.sampleRate).resample(wave.samples, true)
      const samples = new Float32Array(mono.length * config.channels)
      for (let i = 0; i < mono.length; i++) for (let ch = 0; ch < config.channels; ch++) samples[i * config.channels + ch] = mono[i]
      let written: boolean
      try {
        written = stream.write(samples)
        if (written && !output.playing) {
          stream.play()
          output.playing = true
        }
      } catch (error) {
        await closeSoundOutput()
        throw error
      }
      if (!written) throw new Error("Feedback sound output queue is full")
      timing(trace, "sound_submitted", `kind=${name} frames=${mono.length} sampleRate=${config.sampleRate}`)
    } catch (error) {
      timing(trace, "sound_failed", `kind=${name}`)
      throw error
    } finally {
      if (soundOutput) {
        soundIdle = setTimeout(() => queueSound(closeSoundOutput), 5 * 60 * 1000)
        soundIdle.unref()
      }
    }
  })
}

async function handle(request: Request): Promise<unknown> {
  const { method, option } = request
  if (method === "status") return { version: sherpa.version }
  if (method === "sound") {
    if (option.sound === "start" || option.sound === "stop") sound(option.sound, { id: option.traceId || "", startedAt: option.traceStartedAt || Date.now() })
    return {}
  }
  if (method === "devices") return cpal.getDevices({ direction: "input" })
  if (method === "preload") {
    await load(option)
    return {}
  }
  if (method === "warm-microphone") {
    if (recording) throw new Error("Already recording")
    await openMicrophone(option.deviceId)
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
    pipelineTrace = undefined
    resetPipeline(option)
    const wave = sherpa.readWave(option.path!)
    const converter = new sherpa.LinearResampler(wave.sampleRate, 16000)
    for (let i = 0; i < wave.samples.length; i += 1024) accept(converter.resample(wave.samples.subarray(i, i + 1024)))
    accept(converter.resample(new Float32Array(0), true))
    return finishPipeline()
  }
  if (method === "start") {
    const trace = { id: option.traceId || "", startedAt: option.traceStartedAt || Date.now() }
    timing(trace, "worker_start_dequeued", `queueMs=${request.receivedAt ? Date.now() - request.receivedAt : 0}`)
    if (recording || captureStopped) throw new Error("Already recording")
    await load(option)
    timing(trace, "worker_model_ready")
    pipelineTrace = trace
    resetPipeline(option)
    timing(trace, "worker_vad_ready")
    captureStopped = false
    playSound = option.playSound === true
    keepMicrophoneReady = option.keepMicrophoneReady === true
    const microphoneStarted = Date.now()
    const reused = await openMicrophone(option.deviceId, true)
    timing(trace, "microphone_ready", `reused=${reused} openMs=${Date.now() - microphoneStarted} bufferedMs=${Math.round(recentSamples / 16)}`)
    if (inputError) throw inputError
    recording = true
    recordingTrace = trace
    firstLiveAudio = false
    sound("start", trace)
    const now = Date.now()
    const start = typeof option.startedAt === "number" && option.startedAt <= now && option.startedAt >= now - 5000 ? option.startedAt : now
    const cutoff = start - (option.preRoll ? 450 : 0)
    for (const chunk of recentAudio) {
      const skip = Math.max(0, Math.min(chunk.samples.length, Math.floor((cutoff - (chunk.end - chunk.samples.length / 16)) * 16)))
      if (skip < chunk.samples.length) accept(chunk.samples.subarray(skip))
    }
    recentAudio = []
    recentSamples = 0
    timing(trace, "worker_recording_ready")
    return {}
  }
  if (method === "stop-capture") {
    if (!recording) throw new Error("Not recording")
    recording = false
    recordingTrace = undefined
    if (option.keepMicrophoneReady === false) keepMicrophoneReady = false
    if (!keepMicrophoneReady && audio) { await audio.close(); audio = undefined; recentAudio = []; recentSamples = 0 }
    captureStopped = true
    return {}
  }
  if (method === "cancel") {
    if (!recording && !captureStopped) throw new Error("Not recording")
    recording = false
    recordingTrace = undefined
    if (option.keepMicrophoneReady === false) keepMicrophoneReady = false
    if (!keepMicrophoneReady && audio) { await audio.close(); audio = undefined; recentAudio = []; recentSamples = 0 }
    captureStopped = false
    await decoding
    transcript = []
    pending = new Float32Array(0)
    vad = undefined
    return {}
  }
  if (method === "stop") {
    if (recording) {
      recording = false
      recordingTrace = undefined
      if (!keepMicrophoneReady && audio) { await audio.close(); audio = undefined; recentAudio = []; recentSamples = 0 }
      captureStopped = true
    }
    if (!captureStopped) throw new Error("Not recording")
    captureStopped = false
    if (!keepMicrophoneReady) accept(resampler!.resample(new Float32Array(0), true))
    const result = await finishPipeline()
    if (captureGap) emit("capture_gap", null)
    return result
  }
  throw new Error(`Unknown engine method: ${method}`)
}

// Serialize commands; cancellation is process termination so native inference cannot delay it.
let commands = Promise.resolve()
process.on("message", (request: Request) => {
  request.receivedAt = Date.now()
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
