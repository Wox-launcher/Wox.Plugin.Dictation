param([string]$Mode)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DictationInput {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
        public int cbSize; public int flags; public IntPtr active, focus, capture, menu, move, caret; public RECT rect;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int x, y; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint msg; public ushort low, high; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
        [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public HARDWAREINPUT hardware;
    }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] input, int size);
    public static string Snapshot() {
        var hwnd = GetForegroundWindow(); uint pid;
        var thread = GetWindowThreadProcessId(hwnd, out pid);
        var info = new GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(GUITHREADINFO)) };
        if (hwnd == IntPtr.Zero || thread == 0 || !GetGUIThreadInfo(thread, ref info) || info.focus == IntPtr.Zero) throw new Exception("No focused input target");
        return hwnd.ToInt64() + ":" + info.focus.ToInt64() + ":" + pid;
    }
    static INPUT Key(ushort vk, ushort scan, uint flags) {
        return new INPUT { type = 1, data = new INPUTUNION { keyboard = new KEYBDINPUT { vk = vk, scan = scan, flags = flags } } };
    }
    static bool ModifierHeld() {
        return GetAsyncKeyState(0x10) < 0 || GetAsyncKeyState(0x11) < 0 || GetAsyncKeyState(0x12) < 0 || GetAsyncKeyState(0x5B) < 0 || GetAsyncKeyState(0x5C) < 0;
    }
    public static void Send(string target, string text, bool paste) {
        for (int i = 0; i < 50 && ModifierHeld(); i++) System.Threading.Thread.Sleep(10);
        if (ModifierHeld()) throw new Exception("Keyboard shortcut is still pressed");
        if (Snapshot() != target) throw new Exception("The original input is no longer focused");
        INPUT[] inputs;
        if (paste) inputs = new[] { Key(0x11,0,0), Key(0x56,0,0), Key(0x56,0,2), Key(0x11,0,2) };
        else {
            inputs = new INPUT[text.Length * 2];
            for (int i = 0; i < text.Length; i++) { inputs[i*2] = Key(0, text[i], 4); inputs[i*2+1] = Key(0, text[i], 6); }
        }
        if (inputs.Length > 0 && SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new Exception("Unable to send text to the focused application");
    }
}
'@
if ($Mode -eq 'capture') { [Console]::Write([DictationInput]::Snapshot()); exit }
if ($Mode -eq 'insert') {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    [DictationInput]::Send($payload.target, $payload.text, $payload.paste)
    exit
}
throw 'Unsupported operation'
