import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { spawnSync } from "node:child_process"

const source = readFileSync(join(process.cwd(), "src/insert-macos.js"), "utf8")

function macHelper(options: { trusted?: boolean; frontmost?: number; terminated?: boolean } = {}) {
  const calls: string[] = []
  const events: { key: number; down: boolean; flags?: number }[] = []
  let frontmost = options.frontmost ?? 321
  const objc = {
    AXIsProcessTrusted: () => options.trusted !== false,
    CGPreflightPostEventAccess: () => options.trusted !== false,
    NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid: number) => ({
      isTerminated: options.terminated ?? false,
      isNil: () => false,
      activateWithOptions: () => { calls.push(`activate:${pid}`); if (options.frontmost === undefined) frontmost = pid }
    }) },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { get processIdentifier() { return frontmost } } } },
    NSThread: { sleepForTimeInterval: (seconds: number) => calls.push(`wait:${seconds}`) },
    NSUTF8StringEncoding: 4,
    NSString: { stringWithString: (value: string) => ({ dataUsingEncoding: () => value }), alloc: { initWithDataEncoding: (value: string) => value } },
    NSFileHandle: { fileHandleWithStandardOutput: { writeData: (value: string) => calls.push(value) }, fileHandleWithStandardInput: { readDataToEndOfFile: JSON.stringify({ op: "paste" }) } },
    CGEventCreateKeyboardEvent: (_source: unknown, key: number, down: boolean) => ({ key, down }),
    CGEventGetType: (event: { down: boolean }) => event.down ? 10 : 11,
    CGEventSetFlags: (event: { flags?: number }, flags: number) => { event.flags = flags },
    CGEventGetFlags: (event: { flags?: number }) => event.flags,
    CGEventPost: (_tap: number, event: { key: number; down: boolean; flags?: number }) => events.push(event),
    CFRelease: () => {}
  }
  const context = { $: objc, ObjC: { import: () => {}, bindFunction: () => {}, unwrap: (value: unknown) => value } }
  const run = runInNewContext(`${source}\nrun`, context) as (args: string[]) => void
  return { run, calls, events }
}

test("macOS activates the original app and sends Command-V like Wox clipboard", () => {
  const helper = macHelper()
  helper.run(["123"])
  expect(helper.calls).toEqual(["ready\n", "activate:123", "wait:0.15"])
  expect(helper.events).toEqual([{ key: 9, down: true, flags: 0x100000 }, { key: 9, down: false, flags: 0x100000 }])
})

const macTest = process.platform === "darwin" ? test : test.skip
macTest("the real JXA bridge creates both key events without crashing", () => {
  // Keep the real native event bridge but replace permission, activation and
  // posting so this test never changes the desktop or sends a keystroke.
  const nativeSource = source
    .replace("if (!$.AXIsProcessTrusted() || !$.CGPreflightPostEventAccess())", "if (false)")
    .replace(/const activate = \(\) => \{[\s\S]*?\n\s{2}\}/, "const activate = () => {}")
    .replace("$.CGEventPost(0, event)", "void event")
    .replace("function run(args)", "function exercise(args)")
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", `${nativeSource}\nexercise(['123'])`], {
    input: JSON.stringify({ op: "paste" }), encoding: "utf8", timeout: 5000
  })
  expect({ status: result.status, signal: result.signal }).toEqual({ status: 0, signal: null })
  expect(result.stdout).toContain("ready")
})

test("restoring focus activates the original app without posting a paste", () => {
  const helper = macHelper({ trusted: false })
  helper.run(["123", "restore"])
  expect(helper.calls).toEqual(["activate:123", "wait:0.15"])
  expect(helper.events).toHaveLength(0)
})

test("macOS does not paste without permission or when the original app cannot be activated", () => {
  const denied = macHelper({ trusted: false })
  expect(() => denied.run(["123"])).toThrow("macOS Accessibility permission is required")
  expect(denied.events).toHaveLength(0)
  const changed = macHelper({ frontmost: 456 })
  expect(() => changed.run(["123"])).toThrow("Could not activate input target")
  expect(changed.events).toHaveLength(0)
  const closed = macHelper({ terminated: true })
  expect(() => closed.run(["123"])).toThrow("no longer running")
  expect(closed.events).toHaveLength(0)
})
