const { fork } = require("node:child_process")
const { resolve, join } = require("node:path")
const { readdir } = require("node:fs/promises")
const assert = require("node:assert/strict")

// Uses downloaded model fixtures, never the microphone. Run after runtime/model provisioning.
async function main() {
  const root = resolve(process.env.DICTATION_TEST_CACHE || ".test-cache")
  const runtime = join(root, "sherpa-2.0.1-cpal-1.0.0")
  const platform = `sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`
  const lib = join(runtime, "node_modules", platform)
  const child = fork(resolve("dist/engine-worker.js"), [], { env: { ...process.env, DICTATION_RUNTIME: runtime, LD_LIBRARY_PATH: lib, DYLD_LIBRARY_PATH: lib } })
  let id = 0
  const pending = new Map()
  child.on("message", message => {
    const item = pending.get(message.id)
    if (!item) return
    clearTimeout(item.timer)
    pending.delete(message.id)
    if (message.error) item.reject(Error(message.error))
    else item.resolve(message.result)
  })
  child.on("exit", code => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(Error(`Worker exited: ${code}`))
    }
    pending.clear()
  })
  const request = (method, option = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id
      pending.set(key, {
        resolve,
        reject,
        timer: setTimeout(() => {
          child.kill()
          reject(Error("Native test timeout"))
        }, 180000)
      })
      child.send({ id: key, method, option })
    })
  try {
    assert.equal((await request("status")).version, "2.0.1")
    assert.ok(Array.isArray(await request("devices")))
    for (const [name, kind] of [
      ["sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17", "senseVoice"],
      ["sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25", "qwen3Asr"]
    ]) {
      const modelPath = join(root, "models", name)
      const fixtures = (await readdir(join(modelPath, "test_wavs"))).filter(p => p.endsWith(".wav"))
      assert.ok(fixtures.length)
      const result = await request("decode-vad", { modelPath, kind, path: join(modelPath, "test_wavs", fixtures[0]) })
      assert.ok(result.text.trim(), "Native transcription must contain speech")
      console.log(`${kind}: ${result.text}`)
    }
    await assert.rejects(request("unknown"), /Unknown engine method/)
    console.log("Native engine, device enumeration, both ASR models, protocol errors: PASS")
  } finally {
    child.kill()
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
