/* global ObjC, $ */
ObjC.import('Cocoa')
ObjC.import('ApplicationServices')
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []])
ObjC.bindFunction('CGPreflightPostEventAccess', ['bool', []])
ObjC.bindFunction('CGEventCreateKeyboardEvent', ['void *', ['void *', 'unsigned short', 'bool']])
ObjC.bindFunction('CGEventGetType', ['unsigned int', ['void *']])
ObjC.bindFunction('CGEventSetFlags', ['void', ['void *', 'unsigned long long']])
ObjC.bindFunction('CGEventGetFlags', ['unsigned long long', ['void *']])
ObjC.bindFunction('CGEventPost', ['void', ['unsigned int', 'void *']])
ObjC.bindFunction('CFRelease', ['void', ['void *']])

// osascript calls this entry point. The clipboard is prepared by the plugin.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function run(args) {
  const pid = Number(args[0])
  if (!pid) throw new Error('Input target is unavailable')
  const activate = () => {
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)
    if (app.isNil() || app.isTerminated) throw new Error('Input target is no longer running')
    app.activateWithOptions(0)
    $.NSThread.sleepForTimeInterval(0.15)
    const frontmost = Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)
    if (frontmost !== pid) throw new Error(`Could not activate input target (expected pid ${pid}, frontmost pid ${frontmost})`)
  }
  if (args[1] === 'restore') {
    activate()
    return ''
  }
  if (!$.AXIsProcessTrusted() || !$.CGPreflightPostEventAccess()) throw new Error('macOS Accessibility permission is required')
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput
  stdout.writeData($.NSString.stringWithString('ready\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))
  if (input.op !== 'paste') throw new Error('Invalid input operation')

  // Match Wox's clipboard action: activate the original application, allow it
  // to regain focus, then send a Command-V key press and release.
  activate()
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent(null, 9, down)
    // A JXA pointer is a truthy Ref even when it wraps NULL. CGEventGetType
    // safely returns 0 for NULL; a real key event is 10 (down) or 11 (up).
    if ($.CGEventGetType(event) !== (down ? 10 : 11)) throw new Error('Unable to create keyboard event')
    try {
      $.CGEventSetFlags(event, 0x100000)
      if (!($.CGEventGetFlags(event) & 0x100000)) throw new Error('Unable to set Command modifier')
      $.CGEventPost(0, event)
    } finally {
      $.CFRelease(event)
    }
  }
  return ''
}
