const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
    appIconPath,
    backendBase,
    bridgeExtensionPath,
    bundledChromiumPath,
    getChromiumLaunchArgs,
    projectRoot,
    runtimeExtensionRoot,
    userDataDir
} = require('./chatgpt-shell-config');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

fs.mkdirSync(userDataDir, { recursive: true });

function spawnDetached(command, args) {
    const child = spawn(command, args, {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        env
    });

    child.unref();
    return child;
}

function spawnVoiceOverlay() {
    const scriptPath = path.join(projectRoot, 'app', 'voice-overlay.ps1');
    const resolvedScriptPath = fs.existsSync(scriptPath) ? scriptPath : null;
    if (!resolvedScriptPath) return;
    spawnDetached('cmd.exe', [
        '/c',
        'start',
        '',
        'powershell.exe',
        '-NoProfile',
        '-Sta',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', resolvedScriptPath
    ]);
}

function spawnWindowIconHelper(processPath) {
    const scriptPath = path.join(projectRoot, 'app', 'set-window-icon.ps1');
    const resolvedScriptPath = fs.existsSync(scriptPath) ? scriptPath : null;
    if (!resolvedScriptPath || !fs.existsSync(appIconPath)) return;
    spawnDetached('cmd.exe', [
        '/c',
        'start',
        '',
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', resolvedScriptPath,
        '-ProcessPath', processPath,
        '-IconPath', appIconPath
    ]);
}

function prepareRuntimeBridgeExtensionPath() {
    fs.mkdirSync(runtimeExtensionRoot, { recursive: true });

    for (const entry of fs.readdirSync(runtimeExtensionRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('hades-bridge-')) continue;
        try {
            fs.rmSync(path.join(runtimeExtensionRoot, entry.name), { recursive: true, force: true });
        } catch (_) {
            // Eski kopyalar silinemezse yeni kopyayi yine de olusturmayi deneriz.
        }
    }

    const targetPath = path.join(runtimeExtensionRoot, `hades-bridge-${Date.now()}`);
    fs.cpSync(bridgeExtensionPath, targetPath, { recursive: true });
    return targetPath;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isBackendReady() {
    try {
        const response = await fetch(`${backendBase}/health`, { method: 'GET' });
        return response.ok;
    } catch (_) {
        return false;
    }
}

async function ensureBackendRunning() {
    if (await isBackendReady()) {
        return true;
    }

    spawnDetached(process.execPath, ['server.js']);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        await sleep(500);
        if (await isBackendReady()) {
            return true;
        }
    }

    throw new Error('Yerel HADES backend başlatılamadı.');
}

async function launch() {
    await ensureBackendRunning();
    spawnVoiceOverlay();

    const forceElectron = /^(1|true|yes)$/i.test(String(process.env.HADES_USE_ELECTRON || '').trim());
    if (!forceElectron && fs.existsSync(bundledChromiumPath)) {
        const runtimeExtensionPath = prepareRuntimeBridgeExtensionPath();
        spawnDetached(bundledChromiumPath, getChromiumLaunchArgs(runtimeExtensionPath));
        spawnWindowIconHelper(bundledChromiumPath);
        return;
    }

    try {
        const electronCli = require.resolve('electron/cli.js');
        spawnDetached(process.execPath, [electronCli, '.']);
        return;
    } catch (_) {
        if (!forceElectron && fs.existsSync(bundledChromiumPath)) {
            const runtimeExtensionPath = prepareRuntimeBridgeExtensionPath();
            spawnDetached(bundledChromiumPath, getChromiumLaunchArgs(runtimeExtensionPath));
            spawnWindowIconHelper(bundledChromiumPath);
            return;
        }
        throw new Error('Electron veya bundled Chromium bulunamadı.');
    }
}

launch().catch((error) => {
    console.error('[HADES] Başlatma hatası:', error.message || error);
    process.exitCode = 1;
});
