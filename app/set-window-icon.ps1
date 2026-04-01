param(
    [string]$ProcessPath = '',
    [string]$IconPath = '',
    [int]$TimeoutSeconds = 45
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class HadesWindowIconNative {
    public const uint WM_SETICON = 0x0080;
    public const int ICON_SMALL = 0;
    public const int ICON_BIG = 1;
    public const int GCLP_HICON = -14;
    public const int GCLP_HICONSM = -34;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SetClassLongPtrW", SetLastError = true)]
    public static extern IntPtr SetClassLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
}
"@

if (-not (Test-Path -LiteralPath $IconPath)) {
    exit 0
}

$resolvedProcessPath = ''
try {
    $resolvedProcessPath = if ($ProcessPath) { (Resolve-Path -LiteralPath $ProcessPath -ErrorAction Stop).Path } else { '' }
} catch {
    $resolvedProcessPath = [string]$ProcessPath
}

$bitmap = $null
$iconHandle = [IntPtr]::Zero

try {
    $bitmap = [System.Drawing.Bitmap]::FromFile($IconPath)
    $iconHandle = $bitmap.GetHicon()
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, $TimeoutSeconds))

    while ((Get-Date) -lt $deadline) {
        $targets = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }

        foreach ($process in $targets) {
            try {
                if ($resolvedProcessPath) {
                    $processExecutablePath = [string]$process.Path
                    if (-not $processExecutablePath -or $processExecutablePath -ne $resolvedProcessPath) {
                        continue
                    }
                }

                $handle = [IntPtr]$process.MainWindowHandle
                if ($handle -eq [IntPtr]::Zero) {
                    continue
                }

                [void][HadesWindowIconNative]::SetClassLongPtr($handle, [HadesWindowIconNative]::GCLP_HICON, $iconHandle)
                [void][HadesWindowIconNative]::SetClassLongPtr($handle, [HadesWindowIconNative]::GCLP_HICONSM, $iconHandle)
                [void][HadesWindowIconNative]::SendMessage($handle, [HadesWindowIconNative]::WM_SETICON, [IntPtr][HadesWindowIconNative]::ICON_SMALL, $iconHandle)
                [void][HadesWindowIconNative]::SendMessage($handle, [HadesWindowIconNative]::WM_SETICON, [IntPtr][HadesWindowIconNative]::ICON_BIG, $iconHandle)
            } catch {
                # Sessizce devam et.
            }
        }

        Start-Sleep -Milliseconds 300
    }
} catch {
    # Sessizce devam et.
} finally {
    if ($null -ne $bitmap) {
        $bitmap.Dispose()
    }
}
