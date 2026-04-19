Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HadesOverlayNative {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\HADESVoiceOverlay', [ref]$createdNew)
if (-not $createdNew) {
    exit 0
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$userDataDir = Join-Path $projectRoot 'UserData'
$boundsPath = Join-Path $userDataDir 'voice-overlay-bounds.json'
$restoreSignalPath = Join-Path $userDataDir 'restore-main-window.signal'
$logoPath = Join-Path $projectRoot 'app\chatgpt-bridge-extension\hades-cover.png'
$launcherPath = Join-Path $projectRoot 'app\dev-electron-launcher.js'
$backendCandidates = @(
    'http://127.0.0.1:3001',
    'http://localhost:3001'
)

function Read-Bounds {
    if (-not (Test-Path -LiteralPath $boundsPath)) {
        return $null
    }

    try {
        $raw = Get-Content -LiteralPath $boundsPath -Raw | ConvertFrom-Json
        if ($null -eq $raw.x -or $null -eq $raw.y) {
            return $null
        }

        return @{
            x = [double]$raw.x
            y = [double]$raw.y
        }
    } catch {
        return $null
    }
}

function Write-Bounds($window) {
    try {
        New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
        @{
            x = [math]::Round($window.Left)
            y = [math]::Round($window.Top)
        } | ConvertTo-Json | Set-Content -LiteralPath $boundsPath -Encoding UTF8
    } catch {}
}

function Get-State {
    foreach ($base in $backendCandidates) {
        try {
            return Invoke-RestMethod -Uri "$base/bridge/voice-overlay-state" -Method Get -TimeoutSec 2
        } catch {}
    }

    return @{
        chip = 'Bağlantı bekliyor'
        tone = 'warn'
        detail = 'HADES ses durumu bekleniyor.'
        meter = 0
    }
}

function Restore-HadesWindow {
    try {
        New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
        [DateTime]::UtcNow.Ticks.ToString() | Set-Content -LiteralPath $restoreSignalPath -Encoding UTF8
        Start-Sleep -Milliseconds 140

        $target = Get-Process electron -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle -eq 'HADES' -and $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1

        if ($null -ne $target) {
            [void][HadesOverlayNative]::ShowWindowAsync($target.MainWindowHandle, 9)
            Start-Sleep -Milliseconds 80
            if ([HadesOverlayNative]::SetForegroundWindow($target.MainWindowHandle)) {
                return
            }
        }

        if (Test-Path -LiteralPath $launcherPath) {
            Start-Process -FilePath 'node' -ArgumentList $launcherPath -WorkingDirectory $projectRoot -WindowStyle Hidden
        }
    } catch {}
}

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="320"
        Height="122"
        WindowStyle="None"
        ResizeMode="NoResize"
        AllowsTransparency="True"
        Background="Transparent"
        ShowInTaskbar="False"
        Topmost="True"
        ShowActivated="False"
        WindowStartupLocation="Manual">
    <Border x:Name="HudRoot"
            CornerRadius="18"
            BorderThickness="1"
            BorderBrush="#338EF7D1"
            Background="#B7101621"
            Padding="12,12,12,10"
            SnapsToDevicePixels="True">
        <Grid>
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="44" />
                <ColumnDefinition Width="*" />
            </Grid.ColumnDefinitions>
            <Grid.RowDefinitions>
                <RowDefinition Height="Auto" />
                <RowDefinition Height="Auto" />
                <RowDefinition Height="*" />
                <RowDefinition Height="Auto" />
            </Grid.RowDefinitions>
            <Border Grid.Row="0"
                    Grid.Column="0"
                    Grid.RowSpan="4"
                    Width="42"
                    Height="42"
                    CornerRadius="12"
                    Margin="0,0,10,0"
                    BorderBrush="#338EF7D1"
                    BorderThickness="1"
                    Background="#11FFFFFF">
                <Image x:Name="LogoImage"
                       Margin="4"
                       Stretch="Uniform" />
            </Border>
            <TextBlock Grid.Row="0"
                       Grid.Column="1"
                       Text="HADES SES"
                       Foreground="#FF8EF7D1"
                       FontFamily="Segoe UI"
                       FontSize="10"
                       FontWeight="Bold" />
            <TextBlock x:Name="StateText"
                       Grid.Row="1"
                       Grid.Column="1"
                       Margin="0,6,0,0"
                       Text="Ses hazır"
                       Foreground="#FFF6FBFF"
                       FontFamily="Segoe UI"
                       FontSize="15"
                       FontWeight="Bold" />
            <TextBlock x:Name="DetailText"
                       Grid.Row="2"
                       Grid.Column="1"
                       Margin="0,4,0,10"
                       Text='"HADES" deyince dinlemeye başlayacak.'
                       Foreground="#D6E6F0FF"
                       FontFamily="Segoe UI"
                       FontSize="12"
                       TextWrapping="Wrap" />
            <ProgressBar x:Name="MeterBar"
                         Grid.Row="3"
                         Grid.Column="1"
                         Height="6"
                         Minimum="0"
                         Maximum="100"
                         Value="0"
                         Foreground="#FF8EF7D1"
                         Background="#22FFFFFF"
                         BorderThickness="0" />
        </Grid>
    </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$hudRoot = $window.FindName('HudRoot')
$logoImage = $window.FindName('LogoImage')
$stateText = $window.FindName('StateText')
$detailText = $window.FindName('DetailText')
$meterBar = $window.FindName('MeterBar')

if (Test-Path -LiteralPath $logoPath) {
    try {
        $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
        $bitmap.BeginInit()
        $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bitmap.UriSource = [Uri]::new($logoPath)
        $bitmap.EndInit()
        $bitmap.Freeze()
        $logoImage.Source = $bitmap
    } catch {}
}

$savedBounds = Read-Bounds
if ($savedBounds) {
    $window.Left = $savedBounds.x
    $window.Top = $savedBounds.y
} else {
    $workArea = [System.Windows.SystemParameters]::WorkArea
    $window.Left = $workArea.Left + 18
    $window.Top = $workArea.Top + 18
}

$hudRoot.Add_MouseLeftButtonDown({
    param($sender, $eventArgs)

    if ($eventArgs.ClickCount -ge 2) {
        Restore-HadesWindow
        $eventArgs.Handled = $true
        return
    }

    try {
        $window.DragMove()
    } catch {}
})

$window.Add_LocationChanged({
    Write-Bounds $window
})

$window.Add_Closed({
    try {
        if ($null -ne $mutex) {
            $mutex.ReleaseMutex()
            $mutex.Dispose()
        }
    } catch {}
})

function Apply-State($payload) {
    $tone = if ([string]$payload.tone -eq 'warn') { 'warn' } else { 'ok' }
    $meter = 0
    try {
        $meter = [double]$payload.meter
    } catch {
        $meter = 0
    }
    $safeMeter = [math]::Max(0, [math]::Min(100, $meter))
    $nextStateText = [string]$payload.chip
    $nextDetailText = [string]$payload.detail
    if ($stateText.Text -ne $nextStateText) {
        $stateText.Text = $nextStateText
    }
    if ($detailText.Text -ne $nextDetailText) {
        $detailText.Text = $nextDetailText
    }

    $animation = New-Object System.Windows.Media.Animation.DoubleAnimation
    $animation.To = $safeMeter
    $animation.Duration = [TimeSpan]::FromMilliseconds(140)
    $animation.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::HoldEnd
    $animation.EasingFunction = New-Object System.Windows.Media.Animation.QuadraticEase
    $animation.EasingFunction.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseOut
    $meterBar.BeginAnimation(
        [System.Windows.Controls.ProgressBar]::ValueProperty,
        $animation,
        [System.Windows.Media.Animation.HandoffBehavior]::SnapshotAndReplace
    )

    if ($tone -eq 'warn') {
        $hudRoot.BorderBrush = [System.Windows.Media.Brushes]::Goldenrod
        $meterBar.Foreground = [System.Windows.Media.Brushes]::Goldenrod
    } else {
        $hudRoot.BorderBrush = [System.Windows.Media.Brushes]::Aquamarine
        $meterBar.Foreground = [System.Windows.Media.Brushes]::Aquamarine
    }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(120)
$timer.Add_Tick({
    Apply-State (Get-State)
})

Apply-State (Get-State)
$timer.Start()
[void]$window.ShowDialog()
