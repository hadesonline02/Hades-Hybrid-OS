const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
    appIconPath,
    backendBase,
    projectRoot,
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

    throw new Error('Yerel HADES backend baslatilamadi.');
}

async function launch() {
    await ensureBackendRunning();
    spawnVoiceOverlay();

    let electronCli;
    try {
        electronCli = require.resolve('electron/cli.js');
    } catch (_) {
        throw new Error('Electron bulunamadi. "npm install" komutunu calistirin.');
    }

    spawnDetached(process.execPath, [electronCli, '.']);
}

launch().catch((error) => {
    console.error('[HADES] Baslatma hatasi:', error.message || error);
    process.exitCode = 1;
});
