param(
    [Parameter(Mandatory = $true)]
    [string]$WindowHandle,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$Width = 1280,
    [int]$Height = 720,
    [switch]$Interactive
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public delegate bool DesktopEnumProc(IntPtr hWnd, IntPtr lParam);

[StructLayout(LayoutKind.Sequential)]
public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public static class HadesWallpaperHost {
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter, string className, string windowTitle);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(DesktopEnumProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
    public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
    public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong", SetLastError = true)]
    public static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

    public static IntPtr GetStyle(IntPtr hWnd) {
        return IntPtr.Size == 8
            ? GetWindowLongPtr64(hWnd, -16)
            : new IntPtr(GetWindowLong32(hWnd, -16));
    }

    public static void SetStyle(IntPtr hWnd, IntPtr style) {
        if (IntPtr.Size == 8) {
            SetWindowLongPtr64(hWnd, -16, style);
        } else {
            SetWindowLong32(hWnd, -16, style.ToInt32());
        }
    }

    public static IntPtr GetExStyle(IntPtr hWnd) {
        return IntPtr.Size == 8
            ? GetWindowLongPtr64(hWnd, -20)
            : new IntPtr(GetWindowLong32(hWnd, -20));
    }

    public static void SetExStyle(IntPtr hWnd, IntPtr style) {
        if (IntPtr.Size == 8) {
            SetWindowLongPtr64(hWnd, -20, style);
        } else {
            SetWindowLong32(hWnd, -20, style.ToInt32());
        }
    }
}
"@

$progman = [HadesWallpaperHost]::FindWindow("Progman", $null)
if ($progman -eq [IntPtr]::Zero) {
    throw "Progman bulunamadi."
}

$result = [IntPtr]::Zero
[void][HadesWallpaperHost]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result)
[void][HadesWallpaperHost]::SendMessageTimeout($progman, 0x052C, [IntPtr]::new(0xD), [IntPtr]::Zero, 0, 1000, [ref]$result)
[void][HadesWallpaperHost]::SendMessageTimeout($progman, 0x052C, [IntPtr]::new(0xD), [IntPtr]::new(1), 0, 1000, [ref]$result)

function Find-WallpaperHostWorker {
    $script:workerW = [IntPtr]::Zero
    $enumProc = [DesktopEnumProc]{
        param([IntPtr]$TopHandle, [IntPtr]$Param)

        $shellView = [HadesWallpaperHost]::FindWindowEx($TopHandle, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
        if ($shellView -ne [IntPtr]::Zero) {
            $script:workerW = [HadesWallpaperHost]::FindWindowEx([IntPtr]::Zero, $TopHandle, "WorkerW", $null)
            if ($script:workerW -ne [IntPtr]::Zero) {
                return $false
            }
        }
        return $true
    }

    [void][HadesWallpaperHost]::EnumWindows($enumProc, [IntPtr]::Zero)
    return $script:workerW
}

$workerW = [IntPtr]::Zero
foreach ($attempt in 0..5) {
    if ($attempt -gt 0) {
        Start-Sleep -Milliseconds (120 * $attempt)
        [void][HadesWallpaperHost]::SendMessageTimeout($progman, 0x052C, [IntPtr]::new(0xD), [IntPtr]::new(1), 0, 1000, [ref]$result)
    }
    $workerW = Find-WallpaperHostWorker
    if ($workerW -ne [IntPtr]::Zero) {
        break
    }
}

if ($workerW -eq [IntPtr]::Zero) {
    $workerW = $progman
}

$child = [IntPtr]::new([Int64]::Parse($WindowHandle))
$style = [Int64][HadesWallpaperHost]::GetStyle($child)
$WS_CHILD = 0x40000000L
$WS_VISIBLE = 0x10000000L
$WS_POPUP = 0x80000000L
$newStyle = ($style -bor $WS_CHILD -bor $WS_VISIBLE) -band (-bnot $WS_POPUP)
[HadesWallpaperHost]::SetStyle($child, [IntPtr]::new($newStyle))

$exStyle = [Int64][HadesWallpaperHost]::GetExStyle($child)
$WS_EX_TOOLWINDOW = 0x00000080L
$WS_EX_APPWINDOW = 0x00040000L
$WS_EX_NOACTIVATE = 0x08000000L
$newExStyle = ($exStyle -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)
if (-not $Interactive) {
    $newExStyle = $newExStyle -bor $WS_EX_NOACTIVATE
} else {
    $newExStyle = $newExStyle -band (-bnot $WS_EX_NOACTIVATE)
}
[HadesWallpaperHost]::SetExStyle($child, [IntPtr]::new($newExStyle))

$HWND_BOTTOM = [IntPtr]::new(1)
$SWP_NOACTIVATE = 0x0010
$SWP_SHOWWINDOW = 0x0040
$SWP_FRAMECHANGED = 0x0020
$SWP_NOOWNERZORDER = 0x0200
$flags = $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW -bor $SWP_FRAMECHANGED -bor $SWP_NOOWNERZORDER
$SM_XVIRTUALSCREEN = 76
$SM_YVIRTUALSCREEN = 77
$virtualX = [HadesWallpaperHost]::GetSystemMetrics($SM_XVIRTUALSCREEN)
$virtualY = [HadesWallpaperHost]::GetSystemMetrics($SM_YVIRTUALSCREEN)
$relativeX = $X - $virtualX
$relativeY = $Y - $virtualY

$workerRect = New-Object RECT
$progmanRect = New-Object RECT
[void][HadesWallpaperHost]::GetWindowRect($workerW, [ref]$workerRect)
[void][HadesWallpaperHost]::GetWindowRect($progman, [ref]$progmanRect)

$workerWidth = [Math]::Max(0, $workerRect.Right - $workerRect.Left)
$workerHeight = [Math]::Max(0, $workerRect.Bottom - $workerRect.Top)
$progmanWidth = [Math]::Max(0, $progmanRect.Right - $progmanRect.Left)
$progmanHeight = [Math]::Max(0, $progmanRect.Bottom - $progmanRect.Top)

$targetParent = $workerW
$targetParentName = 'WorkerW'
$fitsWorker = $relativeX -ge 0 -and $relativeY -ge 0 -and ($relativeX + $Width) -le $workerWidth -and ($relativeY + $Height) -le $workerHeight
$fitsProgman = $relativeX -ge 0 -and $relativeY -ge 0 -and ($relativeX + $Width) -le $progmanWidth -and ($relativeY + $Height) -le $progmanHeight

if (-not $fitsWorker -and $fitsProgman) {
    $targetParent = $progman
    $targetParentName = 'Progman'
}

[void][HadesWallpaperHost]::SetParent($child, $targetParent)
[HadesWallpaperHost]::SetStyle($child, [IntPtr]::new($newStyle))
[HadesWallpaperHost]::SetExStyle($child, [IntPtr]::new($newExStyle))
[void][HadesWallpaperHost]::SetWindowPos($child, $HWND_BOTTOM, $relativeX, $relativeY, $Width, $Height, $flags)
[void][HadesWallpaperHost]::ShowWindow($child, $(if ($Interactive) { 5 } else { 4 }))

$payload = @{
    ok = $true
    worker = $targetParent.ToInt64()
    host = $targetParentName
    window = $child.ToInt64()
    interactive = [bool]$Interactive
    bounds = @{
        x = $X
        y = $Y
        width = $Width
        height = $Height
        relativeX = $relativeX
        relativeY = $relativeY
    }
    hostBounds = @{
        workerWidth = $workerWidth
        workerHeight = $workerHeight
        progmanWidth = $progmanWidth
        progmanHeight = $progmanHeight
    }
}

$payload | ConvertTo-Json -Compress
