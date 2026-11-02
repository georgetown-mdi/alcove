<#
.SYNOPSIS
    Types a line into another process's console window, or sends it Ctrl+C, or
    closes it. Invoke-VmPass.ps1 runs it as a process of its own, because
    attaching to another console detaches this one.

.DESCRIPTION
    Prints what happened in one word: written_<records>, sent_<count>, posted,
    or the step that failed and its Win32 error. With none of -Text,
    -SecretFile, -CtrlC and -Close, it presses Enter.

    -SecretFile types the password from that DPAPI file. It is copied out of
    the SecureString into a buffer that is cleared once written, and never
    becomes a string.
#>

param(
    [Parameter(Mandatory = $true)][int] $ProcessId,
    [string] $Text = '',
    [string] $SecretFile,
    [int] $CtrlC = 0,
    [switch] $Close
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security;
using System.Threading;

public static class AlcoveVmConsole {
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct KeyEventRecord {
        [FieldOffset(0)] public int KeyDown;
        [FieldOffset(4)] public ushort RepeatCount;
        [FieldOffset(6)] public ushort VirtualKeyCode;
        [FieldOffset(8)] public ushort VirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public uint ControlKeyState;
    }
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct InputRecord {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KeyEventRecord KeyEvent;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteConsoleInputW(IntPtr handle, InputRecord[] records, uint length, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessageW(IntPtr window, uint message, IntPtr w, IntPtr l);

    static string Attach(uint pid) {
        FreeConsole();
        return AttachConsole(pid) ? null : "attach_failed_" + Marshal.GetLastWin32Error();
    }

    static string Write(uint pid, char[] keys) {
        string failed = Attach(pid);
        if (failed != null) { return failed; }
        IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (input == new IntPtr(-1)) { int openError = Marshal.GetLastWin32Error(); FreeConsole(); return "conin_failed_" + openError; }
        InputRecord[] records = new InputRecord[keys.Length * 2];
        try {
            for (int i = 0; i < keys.Length; i++) {
                char c = keys[i];
                ushort key = c == (char)13 ? (ushort)0x0D : (ushort)char.ToUpperInvariant(c);
                for (int down = 0; down < 2; down++) {
                    InputRecord record = new InputRecord();
                    record.EventType = 1;
                    record.KeyEvent.KeyDown = down == 0 ? 1 : 0;
                    record.KeyEvent.RepeatCount = 1;
                    record.KeyEvent.VirtualKeyCode = key;
                    record.KeyEvent.UnicodeChar = c;
                    records[i * 2 + down] = record;
                }
            }
            uint written;
            bool ok = WriteConsoleInputW(input, records, (uint)records.Length, out written);
            int writeError = Marshal.GetLastWin32Error();
            return ok ? "written_" + written : "write_failed_" + writeError;
        } finally {
            Array.Clear(records, 0, records.Length);
            CloseHandle(input);
            FreeConsole();
        }
    }

    public static string SendText(uint pid, string text) {
        return Write(pid, (text + "\r").ToCharArray());
    }

    public static string SendSecret(uint pid, SecureString secret) {
        char[] keys = new char[secret.Length + 1];
        IntPtr buffer = Marshal.SecureStringToGlobalAllocUnicode(secret);
        try {
            for (int i = 0; i < secret.Length; i++) { keys[i] = (char)Marshal.ReadInt16(buffer, i * 2); }
            keys[secret.Length] = '\r';
            return Write(pid, keys);
        } finally {
            Array.Clear(keys, 0, keys.Length);
            Marshal.ZeroFreeGlobalAllocUnicode(buffer);
        }
    }

    public static string SendCtrlC(uint pid, int count) {
        string failed = Attach(pid);
        if (failed != null) { return failed; }
        // Ctrl+C reaches every process on the console, this one included.
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        for (int i = 0; i < count; i++) {
            if (!GenerateConsoleCtrlEvent(0, 0)) { int error = Marshal.GetLastWin32Error(); FreeConsole(); return "ctrl_failed_" + error; }
            Thread.Sleep(400);
        }
        FreeConsole();
        return "sent_" + count;
    }

    public static string CloseWindow(uint pid) {
        string failed = Attach(pid);
        if (failed != null) { return failed; }
        IntPtr window = GetConsoleWindow();
        FreeConsole();
        if (window == IntPtr.Zero) { return "no_window"; }
        return PostMessageW(window, 0x10, IntPtr.Zero, IntPtr.Zero) ? "posted" : "post_failed_" + Marshal.GetLastWin32Error();
    }
}
'@

$target = [uint32] $ProcessId
if ($Close) { [AlcoveVmConsole]::CloseWindow($target) }
elseif ($CtrlC -gt 0) { [AlcoveVmConsole]::SendCtrlC($target, $CtrlC) }
elseif ($SecretFile) {
    [AlcoveVmConsole]::SendSecret($target, (ConvertTo-SecureString -String (Get-Content -Raw -LiteralPath $SecretFile).Trim()))
} else { [AlcoveVmConsole]::SendText($target, $Text) }
