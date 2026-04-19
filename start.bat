@echo off
setlocal EnableExtensions

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"

if not exist "%NODE_EXE%" (
    set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
    set "NPM_CMD=%ProgramFiles(x86)%\nodejs\npm.cmd"
)

if not exist "%NODE_EXE%" goto :NO_NODE
if not exist "%NPM_CMD%" goto :NO_NODE

cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist "%~dp0node_modules" (
    call "%NPM_CMD%" install --no-audit --no-fund
    if errorlevel 1 goto :NPM_FAIL
)

"%NODE_EXE%" "%~dp0app\dev-electron-launcher.js"
exit /b 0

:NO_NODE
echo [HADES] Node.js bulunamadi. Lutfen Node.js LTS kurup tekrar deneyin.
pause
exit /b 1

:NPM_FAIL
echo [HADES] Gerekli paketler yuklenemedi. Internet baglantisini ve npm ayarlarinizi kontrol edin.
pause
exit /b 1
