import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import * as tar from "tar"
import bzip from "unbzip2-stream"
import lock from "./runtime-lock.json"

export const models = [
  { id: "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25", name: "Qwen3-ASR 0.6B", size: 838, integrity: "sha256:393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96", kind: "qwen3Asr" },
  {
    id: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    name: "SenseVoice-Small",
    size: 155,
    integrity: "sha256:7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
    kind: "senseVoice"
  }
] as const
export type Model = (typeof models)[number]
export type Progress = (message: string) => void
export const runtimeVersion = "sherpa-2.0.1-cpal-1.0.0"
const releases = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// Downloads stay in staging until both integrity and extraction succeed.
export async function download(url: string, path: string, signal: AbortSignal, progress: Progress, integrity?: string): Promise<void> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const total = Number(response.headers.get("content-length"))
  let received = 0,
    last = 0
  const sha256 = integrity?.startsWith("sha256:")
  const hash = createHash(sha256 ? "sha256" : "sha512")
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > 3 * 1024 ** 3) return callback(new Error("Download exceeds size limit"))
      hash.update(chunk)
      if (Date.now() - last > 500) {
        last = Date.now()
        progress(total ? `${Math.floor((received / total) * 100)}%` : `${Math.floor(received / 1024 ** 2)} MB`)
      }
      callback(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(path, { flags: "wx" }), { signal })
  if (integrity && (sha256 ? `sha256:${hash.digest("hex")}` : `sha512-${hash.digest("base64")}`) !== integrity) throw new Error("Download integrity mismatch")
}

// Reject links and traversal before tar strips the package/model directory.
export function safeEntry(path: string, entry: { type: string }): boolean {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || /^[a-z]:/i.test(path)) throw new Error("Unsafe archive path")
  if (!["File", "Directory", "OldFile"].includes(entry.type)) throw new Error(`Unsupported archive entry: ${entry.type}`)
  return true
}

async function extract(archive: string, target: string, bz2: boolean, signal: AbortSignal): Promise<void> {
  await mkdir(target, { recursive: true })
  const unpack = tar.x({ cwd: target, strip: 1, strict: true, preservePaths: false, filter: (path, entry) => safeEntry(path, entry as tar.ReadEntry) })
  if (bz2) await pipeline(createReadStream(archive), bzip(), unpack, { signal })
  else await pipeline(createReadStream(archive), unpack, { signal })
}

export function platformPackage(platform = process.platform, arch = process.arch): string {
  const name = `sherpa-onnx-${platform === "win32" ? "win" : platform}-${arch}`
  if (!(name in lock)) throw new Error(`Unsupported native runtime: ${platform}/${arch}`)
  return name
}

// A single instance serializes mutations; an atomic rename publishes completed installations.
export class Downloads {
  private task?: Promise<string>
  constructor(readonly root: string) {}
  runtimePath(): string {
    return join(this.root, runtimeVersion)
  }
  modelPath(model: Model): string {
    return join(this.root, "models", model.id)
  }
  async ready(model: Model): Promise<boolean> {
    return (await exists(join(this.modelPath(model), ".complete"))) || exists(join(this.modelPath(model), ".wox-migrated"))
  }

  // Older installations can contain a model without the separately downloaded VAD.
  async finishMigratedModel(model: Model, signal: AbortSignal, progress: Progress): Promise<void> {
    const target = this.modelPath(model)
    if (!(await exists(join(target, ".wox-migrated")))) return
    const stage = await mkdtemp(join(this.root, ".vad-"))
    try {
      const vad = join(stage, "silero_vad.onnx")
      await download(`${releases}silero_vad.onnx`, vad, signal, progress, "sha256:9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6")
      signal.throwIfAborted()
      await rm(join(target, "silero_vad.onnx"), { force: true })
      await rename(vad, join(target, "silero_vad.onnx"))
      await writeFile(join(target, ".complete"), JSON.stringify({ source: "legacy", id: model.id }))
      await rm(join(target, ".wox-migrated"), { force: true })
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  async runtime(signal: AbortSignal, progress: Progress): Promise<string> {
    const target = this.runtimePath()
    if (await exists(join(target, ".complete"))) return target
    if (this.task) return this.task
    this.task = this.installRuntime(target, signal, progress).finally(() => {
      this.task = undefined
    })
    return this.task
  }

  private async installRuntime(target: string, signal: AbortSignal, progress: Progress): Promise<string> {
    if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Dictation requires Node.js 22 or later")
    const platform = platformPackage()
    await mkdir(this.root, { recursive: true })
    const stage = await mkdtemp(join(this.root, ".runtime-"))
    try {
      const packages = ["sherpa-onnx-node", platform, "node-cpal"] as (keyof typeof lock)[]
      for (const [index, name] of packages.entries()) {
        const item = lock[name]
        const label = `Preparing speech components (${index + 1}/${packages.length})`
        progress(label)
        const archive = join(stage, `${name}.tgz`)
        await download(item.url, archive, signal, p => progress(`${label}: ${p}`), item.integrity)
        await extract(archive, join(stage, "node_modules", name), false, signal)
        await rm(archive)
      }
      signal.throwIfAborted()
      await writeFile(join(stage, ".complete"), runtimeVersion)
      await rename(stage, target)
      return target
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  async installModel(model: Model, signal: AbortSignal, progress: Progress): Promise<void> {
    if (await this.ready(model)) return
    const parent = join(this.root, "models")
    await mkdir(parent, { recursive: true })
    const stage = await mkdtemp(join(parent, ".download-"))
    try {
      const archive = join(stage, "model.tar.bz2"),
        unpacked = join(stage, "model")
      await download(`${releases}${model.id}.tar.bz2`, archive, signal, progress, model.integrity)
      progress("Extracting model")
      await extract(archive, unpacked, true, signal)
      const required =
        model.kind === "senseVoice" ? ["model.int8.onnx", "tokens.txt"] : ["conv_frontend.onnx", "encoder.int8.onnx", "decoder.int8.onnx", "tokenizer/vocab.json", "tokenizer/merges.txt"]
      for (const file of required) if (!(await exists(join(unpacked, file)))) throw new Error(`Incomplete model: ${file}`)
      await download(`${releases}silero_vad.onnx`, join(unpacked, "silero_vad.onnx"), signal, progress, "sha256:9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6")
      signal.throwIfAborted()
      await writeFile(join(unpacked, ".complete"), JSON.stringify({ source: releases, id: model.id }))
      await rename(unpacked, this.modelPath(model))
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  async removeModel(model: Model): Promise<void> {
    await rm(this.modelPath(model), { recursive: true, force: true })
  }
}
