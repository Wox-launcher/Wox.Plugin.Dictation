const { resolve } = require("node:path")
const { mkdir, writeFile } = require("node:fs/promises")
const ncc = require("@vercel/ncc")

// Explicit integration-test provisioning uses the same verified downloader as the plugin.
async function main() {
  const { code } = await ncc(resolve("src/downloads.ts"))
  await mkdir(".download-build", { recursive: true })
  await writeFile(".download-build/index.js", code)
  const { Downloads, models } = require("../.download-build/index.js")
  const downloads = new Downloads(resolve(process.env.DICTATION_TEST_CACHE || ".test-cache"))
  const signal = AbortSignal.timeout(30 * 60 * 1000)
  await downloads.runtime(signal, console.log)
  for (const model of models) await downloads.installModel(model, signal, message => console.log(`${model.name}: ${message}`))
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
