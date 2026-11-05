import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const windowsTest = process.platform === "win32" ? test : test.skip
windowsTest("Windows paste restores an unchanged clipboard and never overwrites a later copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "dictation-clipboard-"))
  try {
    const source = await readFile(join(process.cwd(), "src/insert-windows.ps1"), "utf8")
    const mocks = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Windows.Forms;
public static class FakeInput {
    public static uint sequence = 10;
    public static string Snapshot() { return "1:2:123"; }
    public static uint GetClipboardSequenceNumber() { return sequence; }
    public static void Validate(string target) { if (target != "1:2:123") throw new Exception("wrong focus"); }
    public static void Send(string target, string text, bool paste) {
        Validate(target);
        if (Environment.GetEnvironmentVariable("DICTATION_TEST_MODE") == "focus") throw new Exception("focus changed");
        Console.Error.WriteLine("sent:" + paste);
        if (Environment.GetEnvironmentVariable("DICTATION_TEST_MODE") == "changed") sequence++;
    }
}
public static class FakeClipboard {
    public static IDataObject GetDataObject() {
        var data = new DataObject();
        if (Environment.GetEnvironmentVariable("DICTATION_TEST_MODE") == "unsupported") data.SetData("custom", false, new object());
        else if (Environment.GetEnvironmentVariable("DICTATION_TEST_MODE") == "image") data.SetData("PNG", false, new System.IO.MemoryStream(new byte[] {1, 2, 3}));
        else if (Environment.GetEnvironmentVariable("DICTATION_TEST_MODE") == "files") data.SetData("FileDrop", false, new string[] {"C:\\\\example.txt"});
        else data.SetData("UnicodeText", false, "original");
        return data;
    }
    public static void SetText(string text) { FakeInput.sequence++; Console.Error.WriteLine("copied"); }
    public static void SetDataObject(object data, bool copy) {
        FakeInput.sequence++;
        var restored = (IDataObject)data;
        string mode = Environment.GetEnvironmentVariable("DICTATION_TEST_MODE");
        if (mode == "image" && !(((System.IO.MemoryStream)restored.GetData("PNG", false)).Length == 3)) throw new Exception("image changed");
        if (mode == "files" && !(((string[])restored.GetData("FileDrop", false)).Length == 1)) throw new Exception("files changed");
        Console.Error.WriteLine("restored");
    }
    public static void Clear() { FakeInput.sequence++; Console.Error.WriteLine("cleared"); }
}
'@ -ReferencedAssemblies System.Windows.Forms
`
    const script = source.replace("param([string]$Mode, [int]$TargetPid = 0)", "param([string]$Mode, [int]$TargetPid = 0)\n" + mocks)
      .split("[DictationInput]::").join("[FakeInput]::")
      .split("[System.Windows.Forms.Clipboard]::").join("[FakeClipboard]::")
    const path = join(root, "helper.ps1")
    await writeFile(path, script)
    const run = (mode: string, text = "hello", session = false, pid = 123) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", path, ...(session ? ["session", String(pid)] : ["insert"])], { env: { ...process.env, DICTATION_TEST_MODE: mode }, windowsHide: true })
      let stdout = "", stderr = ""
      child.stdout.on("data", data => { stdout += String(data) })
      child.stderr.on("data", data => { stderr += String(data) })
      child.on("error", reject)
      child.on("close", code => resolve({ code, stdout, stderr }))
      child.stdin.end(JSON.stringify(session ? { text, traceId: "11111111-1111-1111-1111-111111111111", traceStartedAt: Date.now() } : { target: "1:2:123", text }) + (session ? "\n" : ""), "utf8")
    })
    const normal = await run("normal")
    expect(normal.code).toBe(0)
    expect(normal.stdout).toContain("done")
    expect(normal.stderr).toContain("sent:True")
    expect(normal.stderr).toContain("restored")
    const warmSession = await run("normal", "hello", true)
    expect(warmSession.code).toBe(0)
    expect(warmSession.stdout).toMatch(/ready[\s\S]*done/)
    expect(warmSession.stdout).toContain("stage=helper_input_sent")
    expect(warmSession.stdout).toContain("stage=clipboard_restore_complete")
    expect(warmSession.stdout).not.toContain("hello")
    expect(warmSession.stderr).toContain("restored")
    const wrongApp = await run("normal", "hello", true, 456)
    expect(wrongApp.code).not.toBe(0)
    expect(wrongApp.stdout).not.toContain("ready")
    expect(wrongApp.stderr).not.toContain("sent:")
    for (const mode of ["image", "files"]) {
      const restored = await run(mode)
      expect(restored.code).toBe(0)
      expect(restored.stderr).toContain("sent:True")
      expect(restored.stderr).toContain("restored")
    }
    const changed = await run("changed")
    expect(changed.code).toBe(0)
    expect(changed.stderr).toContain("sent:True")
    expect(changed.stderr).not.toContain("restored")
    const unsupported = await run("unsupported")
    expect(unsupported.code).toBe(0)
    expect(unsupported.stderr).toContain("sent:False")
    expect(unsupported.stderr).not.toContain("copied")
    const focus = await run("focus")
    expect(focus.code).not.toBe(0)
    expect(focus.stderr).toContain("restored")
    const multiline = await run("unsupported", "one\ntwo")
    expect(multiline.code).not.toBe(0)
    expect(multiline.stderr).not.toContain("sent:")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
