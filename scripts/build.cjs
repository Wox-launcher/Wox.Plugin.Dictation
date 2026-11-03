const { mkdir, writeFile, cp } = require("node:fs/promises")
const { resolve } = require("node:path")
const ncc = require("@vercel/ncc")

// Only JavaScript and authored resources enter dist; all native assets download at runtime.
async function build() {
  await mkdir("dist", { recursive: true })
  for (const name of ["index", "engine-worker"]) {
    const { code, assets } = await ncc(resolve(`src/${name}.ts`), { minify: false })
    await writeFile(`dist/${name}.js`, code)
    for (const [path, asset] of Object.entries(assets)) {
      if (/\.(node|dll|so|dylib|onnx|exe)$/i.test(path)) throw new Error(`Native asset bundled: ${path}`)
      await writeFile(resolve("dist", path), asset.source)
    }
  }
  await cp("sounds", "dist/sounds", { recursive: true })
  await cp("src/insert-windows.ps1", "dist/insert-windows.ps1")
  await cp("src/insert-macos.js", "dist/insert-macos.js")
  await cp("src/insert-linux.py", "dist/insert-linux.py")
  await cp("images", "dist/images", { recursive: true })
  await cp("plugin.json", "dist/plugin.json")
  await cp("LICENSE", "dist/LICENSE")
  await cp("README.md", "dist/README.md")
}
build().catch(error => {
  console.error(error)
  process.exitCode = 1
})
