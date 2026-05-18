try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleVT {
    const int  STD_OUTPUT_HANDLE = -11;
    const uint ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool   GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] static extern bool   SetConsoleMode(IntPtr h, uint m);
    public static void Enable() {
        var h = GetStdHandle(STD_OUTPUT_HANDLE);
        uint m; if (GetConsoleMode(h, out m)) SetConsoleMode(h, m | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
    }
}
'@ -ErrorAction SilentlyContinue
    [ConsoleVT]::Enable()
} catch { }

$str = "$([char]27)[38;2;250;50;50mTrueColor Red in 5.1$([char]27)[0m"
Write-Host $str
