import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

const source = readFileSync(join(process.cwd(), "src/insert-macos.js"), "utf8")

function macHelper(text: string, options: { trusted?: boolean; focused?: boolean } = {}) {
  const events: { down: boolean; text?: string; length?: number }[] = []
  const window = {}, input = {}, app = {}
  let writes = ""
  const objc = {
    AXIsProcessTrusted: () => options.trusted !== false,
    AXUIElementCreateApplication: () => app,
    AXUIElementCopyAttributeValue: (_obj: unknown, name: string, ref: unknown[]) => { ref[0] = name === "AXFocusedWindow" ? window : options.focused === false ? {} : input; return 0 },
    CFEqual: (a: unknown, b: unknown) => a === b,
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 123 } } },
    NSUTF8StringEncoding: 4, NSUTF16LittleEndianStringEncoding: 5,
    NSString: {
      stringWithString: (value: string) => ({ dataUsingEncoding: () => ({ bytes: value }) }),
      alloc: { initWithDataEncoding: (value: string) => value }
    },
    NSFileHandle: { fileHandleWithStandardOutput: { writeData: (value: { bytes: string }) => { writes += value.bytes } }, fileHandleWithStandardInput: { readDataToEndOfFile: JSON.stringify({ text }) } },
    CGEventCreateKeyboardEvent: (_source: unknown, _key: number, down: boolean) => ({ down }),
    CGEventKeyboardSetUnicodeString: (event: { text?: string; length?: number }, length: number, value: string) => { event.text = value; event.length = length },
    CGEventPost: (_tap: number, event: { down: boolean; text?: string; length?: number }) => events.push(event),
    CFRelease: () => {}
  }
  const context = { $: objc, ObjC: { import: () => {}, bindFunction: () => {}, unwrap: (value: unknown) => value }, Ref: () => [] }
  const run = runInNewContext(`${source}\nrun`, context) as (args: string[]) => void
  return { run, events, writes: () => writes }
}

test("macOS helper sends Unicode in bounded chunks without splitting emoji", () => {
  const text = `${"a".repeat(19)}😀 中文\nsecond line`
  const helper = macHelper(text)
  helper.run(["123"])
  expect(helper.writes()).toBe("ready\n")
  const downs = helper.events.filter(event => event.down)
  expect(downs.map(event => event.text).join("")).toBe(text)
  expect(downs.every(event => event.length! <= 20 && !/[\uD800-\uDBFF]$/.test(event.text!))).toBe(true)
  expect(helper.events).toHaveLength(downs.length * 2)
})

test("macOS helper rejects missing accessibility permission or a changed focused input", () => {
  const denied = macHelper("text", { trusted: false })
  expect(() => denied.run(["123"])).toThrow()
  expect(denied.events).toHaveLength(0)
  const changed = macHelper("text", { focused: false })
  expect(() => changed.run(["123"])).toThrow()
  expect(changed.events).toHaveLength(0)
})
