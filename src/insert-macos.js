/* global ObjC, $, Ref */
ObjC.import('Cocoa')
ObjC.import('ApplicationServices')
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []])
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']])
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id *']])
ObjC.bindFunction('CFEqual', ['bool', ['id', 'id']])
ObjC.bindFunction('CGEventCreateKeyboardEvent', ['id', ['id', 'unsigned short', 'bool']])
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['id', 'unsigned long', 'void *']])
ObjC.bindFunction('CGEventPost', ['void', ['unsigned int', 'id']])
ObjC.bindFunction('CFRelease', ['void', ['id']])

// osascript calls this entry point.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function run(args) {
  const pid = Number(args[0])
  if (!$.AXIsProcessTrusted() || !pid || Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) !== pid) throw new Error('Input target is unavailable')
  const app = $.AXUIElementCreateApplication(pid)
  const attribute = (object, name) => {
    const ref = Ref()
    if ($.AXUIElementCopyAttributeValue(object, name, ref) !== 0 || !ref[0]) throw new Error('Input target is unavailable')
    return ref[0]
  }
  const originalWindow = attribute(app, 'AXFocusedWindow')
  const originalInput = attribute(app, 'AXFocusedUIElement')
  const sameTarget = () => Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) === pid &&
    $.CFEqual(originalWindow, attribute(app, 'AXFocusedWindow')) && $.CFEqual(originalInput, attribute(app, 'AXFocusedUIElement'))
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput
  const write = text => stdout.writeData($.NSString.stringWithString(text).dataUsingEncoding($.NSUTF8StringEncoding))
  write('ready\n')
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))
  if (typeof input.text !== 'string' || input.text.length > 30000 || !sameTarget()) throw new Error('The original input is no longer focused')
  for (let i = 0; i < input.text.length;) {
    let length = Math.min(20, input.text.length - i)
    if (i + length < input.text.length && /[\uD800-\uDBFF]/.test(input.text[i + length - 1])) length--
    const chunk = input.text.slice(i, i + length)
    if (!sameTarget()) throw new Error('The original input is no longer focused')
    const bytes = $.NSString.stringWithString(chunk).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding)
    for (const down of [true, false]) {
      const event = $.CGEventCreateKeyboardEvent(null, 0, down)
      if (!event) throw new Error('Unable to create keyboard event')
      $.CGEventKeyboardSetUnicodeString(event, chunk.length, bytes.bytes)
      $.CGEventPost(0, event)
      $.CFRelease(event)
    }
    i += length
  }
  return ''
}
