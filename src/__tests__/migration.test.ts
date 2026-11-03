import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Downloads, models } from "../downloads"

test("finishes a migrated model without downloading it again, and retries failed VAD downloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "wox-model-migration-"))
  const originalFetch = global.fetch
  try {
    const downloads = new Downloads(root), model = models[1], target = downloads.modelPath(model)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, "model.int8.onnx"), "existing model")
    await writeFile(join(target, ".wox-migrated"), "legacy")
    expect(await downloads.ready(model)).toBe(true)
    global.fetch = jest.fn(async () => { throw new Error("offline") }) as typeof fetch
    await expect(downloads.finishMigratedModel(model, new AbortController().signal, () => {})).rejects.toThrow("offline")
    expect(await readFile(join(target, "model.int8.onnx"), "utf8")).toBe("existing model")
    expect(await downloads.ready(model)).toBe(true)
    expect((await readdir(root)).filter(name => name.startsWith(".vad-"))).toEqual([])

    const vadPath = process.env.WOX_TEST_LEGACY_VAD
    if (vadPath) {
      const vad = await readFile(vadPath)
      global.fetch = jest.fn(async () => new Response(vad)) as typeof fetch
      await downloads.finishMigratedModel(model, new AbortController().signal, () => {})
      expect(await readFile(join(target, "silero_vad.onnx"))).toEqual(vad)
      expect(await readFile(join(target, "model.int8.onnx"), "utf8")).toBe("existing model")
      expect(await downloads.ready(model)).toBe(true)
      expect(await readdir(target)).toContain(".complete")
      expect(await readdir(target)).not.toContain(".wox-migrated")
      expect(global.fetch).toHaveBeenCalledTimes(1)
    }
  } finally {
    global.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
