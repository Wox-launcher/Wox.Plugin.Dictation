param([string]$Mode, [int]$TargetPid = 0)
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
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
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
    public static void Validate(string target) {
        for (int i = 0; i < 50 && ModifierHeld(); i++) System.Threading.Thread.Sleep(10);
        if (ModifierHeld()) throw new Exception("Keyboard shortcut is still pressed");
        if (Snapshot() != target) throw new Exception("The original input is no longer focused");
    }
    public static void Send(string target, string text, bool paste) {
        Validate(target);
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
if ($Mode -eq 'session') {
    $capturedTarget = [DictationInput]::Snapshot()
    if ([int]($capturedTarget.Split(':')[2]) -ne $TargetPid) { throw 'The original application is no longer focused' }
    Add-Type -AssemblyName System.Windows.Forms
    [Console]::Write("ready`n")
    [Console]::Out.Flush()
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { exit }
    $payload = $line | ConvertFrom-Json
    $payload | Add-Member -NotePropertyName target -NotePropertyValue $capturedTarget
    $Mode = 'insert'
}
if ($Mode -eq 'insert') {
    if ($null -eq $payload) { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json }
    function Write-Timing([string]$Stage, [string]$Details = '') {
        if ($payload.traceId -match '^[0-9a-f-]{36}$' -and $payload.traceStartedAt -gt 0) {
            $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            [Console]::Write("timing session=$($payload.traceId) stage=$Stage atMs=$now elapsedMs=$($now - [long]$payload.traceStartedAt) $Details`n")
            [Console]::Out.Flush()
        }
    }
    Write-Timing 'helper_insert_received'
    [DictationInput]::Validate($payload.target)
    Add-Type -AssemblyName System.Windows.Forms
    $sequence = [DictationInput]::GetClipboardSequenceNumber()
    $original = $null
    $empty = $false
    $canPreserve = $sequence -ne 0
    try {
        $old = [System.Windows.Forms.Clipboard]::GetDataObject()
        if ($null -eq $old) { $empty = $true }
        else {
            $original = New-Object System.Windows.Forms.DataObject
            foreach ($format in $old.GetFormats($false)) {
                $value = $old.GetData($format, $false)
                if ($value -is [System.IO.MemoryStream]) { $value = New-Object System.IO.MemoryStream(,$value.ToArray()) }
                elseif ($value -is [System.Drawing.Image]) { $value = $value.Clone() }
                elseif ($value -isnot [string] -and $value -isnot [string[]] -and $value -isnot [byte[]] -and $value -isnot [int] -and $value -isnot [uint] -and $value -isnot [long] -and $value -isnot [bool]) { throw 'Unsupported clipboard format' }
                $original.SetData($format, $false, $value)
            }
        }
    } catch { $canPreserve = $false }
    Write-Timing 'clipboard_snapshot_complete' "preservable=$($canPreserve.ToString().ToLowerInvariant())"
    if (!$canPreserve -or [DictationInput]::GetClipboardSequenceNumber() -ne $sequence) {
        if ($payload.text -match '[\r\n]') { throw 'Clipboard cannot be preserved for multiline insertion' }
        [DictationInput]::Send($payload.target, $payload.text, $false)
        Write-Timing 'helper_input_sent' 'mode=typing'
        [Console]::Write("done`n")
        exit
    }
    $writtenSequence = 0
    try {
        [DictationInput]::Validate($payload.target)
        if ([DictationInput]::GetClipboardSequenceNumber() -ne $sequence) { throw 'Clipboard changed during insertion' }
        [System.Windows.Forms.Clipboard]::SetText($payload.text)
        $writtenSequence = [DictationInput]::GetClipboardSequenceNumber()
        [DictationInput]::Send($payload.target, '', $true)
        Write-Timing 'helper_input_sent' 'mode=paste'
        [Console]::Write("done`n")
        [Console]::Out.Flush()
        Start-Sleep -Milliseconds 500
    } finally {
        if ($writtenSequence -ne 0 -and [DictationInput]::GetClipboardSequenceNumber() -eq $writtenSequence) {
            if ($empty) { [System.Windows.Forms.Clipboard]::Clear() }
            else { [System.Windows.Forms.Clipboard]::SetDataObject($original, $true) }
            Write-Timing 'clipboard_restore_complete'
        } else {
            Write-Timing 'clipboard_restore_skipped'
        }
    }
    exit
}
throw 'Unsupported operation'
