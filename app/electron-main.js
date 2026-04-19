const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const {
    app,
    BrowserWindow,
    Menu,
    dialog,
    globalShortcut,
    ipcMain,
    powerSaveBlocker,
    shell,
    screen,
    nativeImage
} = require('electron');
const {
    appIconPath,
    bridgeExtensionPath,
    buildChromeLikeUserAgent,
    canGrantPermission,
    chatgptStartUrl,
    isTrustedShellUrl,
    userDataDir
} = require('./chatgpt-shell-config');

const WINDOW_BOUNDS = Object.freeze({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 760
});
const COCKPIT_WINDOW_BOUNDS = Object.freeze({
    width: 1580,
    height: 980,
    minWidth: 900,
    minHeight: 620
});
const AMBIENT_DESKTOP_DISABLED = process.argv.includes('--disable-ambient-desktop');
const OVERLAY_ONLY = process.argv.includes('--overlay-only');
const OVERLAY_WINDOW_BOUNDS = Object.freeze({
    width: 300,
    height: 116
});
const AMBIENT_CONTROL_DOCK_BOUNDS = Object.freeze({
    collapsedWidth: 64,
    expandedWidth: 372,
    collapsedHeight: 86,
    expandedHeight: 432,
    margin: 12
});
const OVERLAY_BOUNDS_PATH = path.join(userDataDir, 'voice-overlay-bounds.json');
const RESTORE_SIGNAL_PATH = path.join(userDataDir, 'restore-main-window.signal');
const RUNTIME_EXTENSION_ROOT = path.join(userDataDir, 'runtime-extensions');
const AMBIENT_WALLPAPER_HELPER_SOURCE = path.join(__dirname, 'ambient-wallpaper-host.ps1');
const AMBIENT_WALLPAPER_HELPER_RUNTIME = path.join(userDataDir, 'ambient-wallpaper-host.ps1');
const AUTH_HELPER_PROFILE_DIR = path.join(userDataDir, 'google-auth-profile');
const AUTH_HELPER_DEBUG_PORT = Number(process.env.HADES_AUTH_DEBUG_PORT || 9333);
const AUTH_HELPER_TIMEOUT_MS = 4 * 60 * 1000;
const AUTH_HELPER_POLL_MS = 1200;
const AUTH_COPY_URLS = Object.freeze([
    'https://chatgpt.com/',
    'https://chat.openai.com/',
    'https://auth.openai.com/',
    'https://openai.com/'
]);
const AUTH_SUCCESS_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const AUTH_HELPER_EXECUTABLES = Object.freeze([
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
]);

let mainWindow = null;
let cockpitWindow = null;
let overlayWindow = null;
let ambientControlDockWindow = null;
let ambientDesktopWindows = new Map();
let ambientControlDockExpanded = false;
let ambientDesktopEnabled = !OVERLAY_ONLY && !AMBIENT_DESKTOP_DISABLED;
let sessionConfigured = false;
let overlayBoundsTimer = null;
let extensionLoadPromise = null;
let runtimeBridgeExtensionPath = null;
let runtimeAmbientWallpaperHelperPath = null;
let powerSaveBlockerId = null;
let restoreSignalWatching = false;
let ambientDisplaySyncTimer = null;
let ambientDisplayWatching = false;
let ambientHostRefreshTimer = null;
let ambientHostSyncChain = Promise.resolve();
let mainWindowCloakState = null;
let externalAuthFlow = null;

function syncMainWindowVoiceContext(window, options = {}) {
    if (!window || window.isDestroyed()) return;
    const parkedValue = options.parked ? 'true' : 'false';
    const hiddenValue = options.hidden ? 'true' : 'false';
    const cloakedValue = options.cloaked ? 'true' : 'false';
    window.webContents.executeJavaScript(`
        try {
            document.documentElement.dataset.hadesDesktopShell = 'electron';
            document.documentElement.dataset.hadesPersistentBackground = 'true';
            document.documentElement.dataset.hadesParked = '${parkedValue}';
            document.documentElement.dataset.hadesWindowHidden = '${hiddenValue}';
            document.documentElement.dataset.hadesWindowCloaked = '${cloakedValue}';
            window.dispatchEvent(new CustomEvent('hades-window-context-change', { detail: { parked: ${options.parked ? 'true' : 'false'}, hidden: ${options.hidden ? 'true' : 'false'}, cloaked: ${options.cloaked ? 'true' : 'false'} } }));
        } catch (_) {}
    `).catch(() => {});
}

app.setPath('userData', userDataDir);
try {
    app.setPath('sessionData', userDataDir);
} catch (_) {
    // Electron eski bir path listesi ile gelirse sessizce devam et.
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('lang', 'tr-TR');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackForwardCache,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('remote-debugging-port', String(process.env.HADES_REMOTE_DEBUG_PORT || 9222));
app.userAgentFallback = buildChromeLikeUserAgent();
app.setName('HADES');
app.setAppUserModelId('com.hades.desktop');
app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (attachEvent, webPreferences, params = {}) => {
        const sourceUrl = String(params.src || '').trim();
        if (!/^(https?:\/\/|about:blank$)/i.test(sourceUrl)) {
            attachEvent.preventDefault();
            return;
        }

        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        params.useragent = buildChromeLikeUserAgent();
    });
});

function resolveAppIcon() {
    if (!fs.existsSync(appIconPath)) return null;
    const icon = nativeImage.createFromPath(appIconPath);
    return icon.isEmpty() ? null : icon;
}

function prepareRuntimeBridgeExtensionPath() {
    if (runtimeBridgeExtensionPath) return runtimeBridgeExtensionPath;

    fs.mkdirSync(RUNTIME_EXTENSION_ROOT, { recursive: true });
    for (const entry of fs.readdirSync(RUNTIME_EXTENSION_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('hades-bridge-')) continue;
        try {
            fs.rmSync(path.join(RUNTIME_EXTENSION_ROOT, entry.name), { recursive: true, force: true });
        } catch (_) {
            // Eski kopyalari temizleyemezsek yenisini yine de olusturmayi deneyelim.
        }
    }

    runtimeBridgeExtensionPath = path.join(RUNTIME_EXTENSION_ROOT, `hades-bridge-${Date.now()}`);
    fs.cpSync(bridgeExtensionPath, runtimeBridgeExtensionPath, { recursive: true });
    return runtimeBridgeExtensionPath;
}

function prepareRuntimeAmbientWallpaperHelperPath() {
    if (runtimeAmbientWallpaperHelperPath) return runtimeAmbientWallpaperHelperPath;
    if (!fs.existsSync(AMBIENT_WALLPAPER_HELPER_SOURCE)) return null;

    fs.mkdirSync(userDataDir, { recursive: true });
    fs.copyFileSync(AMBIENT_WALLPAPER_HELPER_SOURCE, AMBIENT_WALLPAPER_HELPER_RUNTIME);
    runtimeAmbientWallpaperHelperPath = AMBIENT_WALLPAPER_HELPER_RUNTIME;
    return runtimeAmbientWallpaperHelperPath;
}

function nativeWindowHandleToString(window) {
    if (!window || window.isDestroyed()) return '';
    const handle = window.getNativeWindowHandle?.();
    if (!handle || !Buffer.isBuffer(handle)) return '';

    try {
        if (handle.length >= 8 && typeof handle.readBigUInt64LE === 'function') {
            return handle.readBigUInt64LE(0).toString();
        }
        if (handle.length >= 4) {
            return String(handle.readUInt32LE(0));
        }
    } catch (_) {
        return '';
    }

    return '';
}

async function ensureBridgeExtensionLoaded(targetSession) {
    if (OVERLAY_ONLY || !targetSession) return null;
    if (extensionLoadPromise) return extensionLoadPromise;

    extensionLoadPromise = (async () => {
        const runtimeExtensionPath = prepareRuntimeBridgeExtensionPath();
        const existing = targetSession.getAllExtensions().find((entry) => entry.path === runtimeExtensionPath || entry.path === bridgeExtensionPath) || null;
        if (existing?.id) {
            try {
                targetSession.removeExtension(existing.id);
            } catch (_) {
                // Taze yukleme denemesi icin sessizce devam et.
            }
        }

        try {
            return await targetSession.loadExtension(runtimeExtensionPath);
        } catch (error) {
            const message = String(error?.message || error || '');
            if (/already loaded/i.test(message)) {
                return targetSession.getAllExtensions().find((entry) => entry.path === runtimeExtensionPath || entry.path === bridgeExtensionPath) || null;
            }
            extensionLoadPromise = null;
            throw error;
        }
    })();

    return extensionLoadPromise;
}

function createApplicationMenu() {
    if (OVERLAY_ONLY) {
        Menu.setApplicationMenu(null);
        return;
    }

    const template = [
        {
            label: 'Gezinme',
            submenu: [
                {
                    label: 'Geri',
                    accelerator: 'Alt+Left',
                    click: () => {
                        if (mainWindow?.webContents?.canGoBack()) {
                            mainWindow.webContents.goBack();
                        }
                    }
                },
                {
                    label: 'Ileri',
                    accelerator: 'Alt+Right',
                    click: () => {
                        if (mainWindow?.webContents?.canGoForward()) {
                            mainWindow.webContents.goForward();
                        }
                    }
                },
                {
                    label: 'Yenile',
                    accelerator: 'Control+R',
                    click: () => {
                        mainWindow?.webContents?.reload();
                    }
                }
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function readOverlayBounds() {
    try {
        if (!fs.existsSync(OVERLAY_BOUNDS_PATH)) return null;
        const payload = JSON.parse(fs.readFileSync(OVERLAY_BOUNDS_PATH, 'utf8'));
        if (!Number.isFinite(payload?.x) || !Number.isFinite(payload?.y)) return null;
        return {
            x: Math.round(payload.x),
            y: Math.round(payload.y),
            width: OVERLAY_WINDOW_BOUNDS.width,
            height: OVERLAY_WINDOW_BOUNDS.height
        };
    } catch (_) {
        return null;
    }
}

function writeOverlayBounds() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (overlayBoundsTimer) clearTimeout(overlayBoundsTimer);
    overlayBoundsTimer = setTimeout(() => {
        overlayBoundsTimer = null;
        try {
            fs.mkdirSync(userDataDir, { recursive: true });
            const { x, y } = overlayWindow.getBounds();
            fs.writeFileSync(OVERLAY_BOUNDS_PATH, JSON.stringify({ x, y }, null, 2));
        } catch (_) {
            // Sessizce devam et.
        }
    }, 180);
}

function getOverlayBounds() {
    const saved = readOverlayBounds();
    if (saved) return saved;
    const workArea = screen.getPrimaryDisplay().workArea;
    return {
        x: workArea.x + 18,
        y: workArea.y + 18,
        width: OVERLAY_WINDOW_BOUNDS.width,
        height: OVERLAY_WINDOW_BOUNDS.height
    };
}

function hideMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindowCloakState) {
        mainWindowCloakState = {
            bounds: mainWindow.getBounds(),
            opacity: typeof mainWindow.getOpacity === 'function' ? mainWindow.getOpacity() : 1,
            skipTaskbar: typeof mainWindow.isSkipTaskbar === 'function' ? mainWindow.isSkipTaskbar() : false
        };
    }
    syncMainWindowVoiceContext(mainWindow, { parked: true, hidden: true, cloaked: true });
    try {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.setSkipTaskbar(true);
        mainWindow.setIgnoreMouseEvents(true, { forward: false });
        if (typeof mainWindow.setOpacity === 'function') {
            mainWindow.setOpacity(0);
        }
        mainWindow.hide();
    } catch (_) {
        // Sessizce devam et.
    }
}

function restoreMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        if (mainWindowCloakState) {
            mainWindow.setIgnoreMouseEvents(false);
            mainWindow.setSkipTaskbar(Boolean(mainWindowCloakState.skipTaskbar));
            if (typeof mainWindow.setOpacity === 'function') {
                mainWindow.setOpacity(mainWindowCloakState.opacity || 1);
            }
            if (mainWindowCloakState.bounds) {
                mainWindow.setBounds(mainWindowCloakState.bounds, false);
            }
        }
        app.focus({ steal: true });
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.moveTop();
        mainWindow.focus();
        mainWindowCloakState = null;
        syncMainWindowVoiceContext(mainWindow, { parked: false, hidden: false, cloaked: false });
    } catch (_) {
        // Sessizce devam et.
    }
}

function ensureRestoreSignalWatcher() {
    if (restoreSignalWatching) return;
    restoreSignalWatching = true;
    try {
        fs.mkdirSync(userDataDir, { recursive: true });
        if (!fs.existsSync(RESTORE_SIGNAL_PATH)) {
            fs.writeFileSync(RESTORE_SIGNAL_PATH, '', 'utf8');
        }
    } catch (_) {
        // Sessizce devam et.
    }

    fs.watchFile(RESTORE_SIGNAL_PATH, { interval: 250 }, (curr, prev) => {
        if (!curr || !prev) return;
        if (curr.mtimeMs <= 0 || curr.mtimeMs === prev.mtimeMs) return;
        restoreMainWindow();
    });
}

function resolvePermissionUrl(webContents, requestingOrigin, details = {}) {
    return String(
        details.requestingUrl ||
        details.requestingOrigin ||
        requestingOrigin ||
        webContents?.getURL() ||
        ''
    );
}

function configureSessionHandlers(targetSession) {
    if (!targetSession || sessionConfigured) return;

    targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        const resolvedUrl = resolvePermissionUrl(webContents, requestingOrigin, details);
        return canGrantPermission(permission, resolvedUrl);
    });

    targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const resolvedUrl = resolvePermissionUrl(webContents, '', details);
        callback(canGrantPermission(permission, resolvedUrl));
    });

    sessionConfigured = true;
}

function handleNavigationAttempt(event, targetUrl = '', sourceWindow = null) {
    const safeUrl = String(targetUrl || '').trim();
    if (!safeUrl) return;

    if (isGoogleManagedAuthUrl(safeUrl)) {
        event.preventDefault();
        void startGoogleAuthTransfer(safeUrl, sourceWindow || mainWindow).catch((error) => {
            dialog.showErrorBox('Google girişi açılamadı', error?.message || String(error));
        });
        return;
    }

    if (isTrustedShellUrl(safeUrl)) {
        return;
    }

    event.preventDefault();
    shell.openExternal(safeUrl).catch(() => {});
}

function sleep(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeHostname(rawUrl = '') {
    try {
        return new URL(String(rawUrl || '').trim()).hostname.toLowerCase();
    } catch (_) {
        return '';
    }
}

function isGoogleManagedAuthUrl(rawUrl = '') {
    const safeUrl = String(rawUrl || '').trim();
    if (!safeUrl) return false;
    const hostname = normalizeHostname(safeUrl);
    if (hostname === 'accounts.google.com' || hostname.endsWith('.accounts.google.com')) {
        return true;
    }
    if ((hostname === 'auth.openai.com' || hostname.endsWith('.auth.openai.com')) && /google/i.test(safeUrl)) {
        return true;
    }
    return false;
}

function findExternalChromiumExecutable() {
    return AUTH_HELPER_EXECUTABLES.find((candidate) => fs.existsSync(candidate)) || '';
}

function taskKillPidTree(pid) {
    if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return;
    try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 8000
        });
    } catch (_) {
        // Sessizce devam et.
    }
}

async function fetchJson(url = '') {
    const response = await fetch(String(url || ''), { method: 'GET' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

async function getAuthHelperTargets() {
    return fetchJson(`http://127.0.0.1:${AUTH_HELPER_DEBUG_PORT}/json/list`);
}

async function waitForAuthHelperTargets(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const targets = await getAuthHelperTargets();
            if (Array.isArray(targets)) return targets;
        } catch (_) {
            // Yardımcı tarayıcı henüz açılmadıysa kısa süre daha bekle.
        }
        await sleep(260);
    }
    throw new Error('Yardımcı Chromium debug portu açılamadı.');
}

function mapCookieSameSite(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'strict') return 'strict';
    if (normalized === 'lax') return 'lax';
    if (normalized === 'none' || normalized === 'no_restriction') return 'no_restriction';
    return 'unspecified';
}

async function getCookiesFromDebugTarget(webSocketDebuggerUrl = '') {
    const wsUrl = String(webSocketDebuggerUrl || '').trim();
    if (!wsUrl) throw new Error('Cookie aktarımı için debug hedefi yok.');

    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        let settled = false;
        let nextId = 1;
        const pending = new Map();
        const timeout = setTimeout(() => finish(reject, new Error('Chromium cookie okuma zaman aşımına uğradı.')), 8000);

        function finish(handler, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            for (const entry of pending.values()) {
                entry.reject(new Error('CDP bağlantısı kapandı.'));
            }
            pending.clear();
            try { socket.close(); } catch (_) {}
            handler(value);
        }

        function send(method, params = {}) {
            return new Promise((resolveSend, rejectSend) => {
                const id = nextId++;
                pending.set(id, { resolve: resolveSend, reject: rejectSend });
                socket.send(JSON.stringify({ id, method, params }));
            });
        }

        socket.once('error', (error) => finish(reject, error));
        socket.on('message', async (raw) => {
            let message = null;
            try {
                message = JSON.parse(String(raw || ''));
            } catch (_) {
                return;
            }

            if (message.id && pending.has(message.id)) {
                const request = pending.get(message.id);
                pending.delete(message.id);
                if (message.error) {
                    request.reject(new Error(message.error.message || 'CDP isteği başarısız oldu.'));
                } else {
                    request.resolve(message.result || {});
                }
            }
        });

        socket.once('open', async () => {
            try {
                await send('Network.enable');
                const result = await send('Network.getCookies', { urls: AUTH_COPY_URLS });
                finish(resolve, Array.isArray(result.cookies) ? result.cookies : []);
            } catch (error) {
                finish(reject, error);
            }
        });
    });
}

function isSuccessfulAuthTarget(target = {}) {
    const pageUrl = String(target?.url || '').trim();
    const hostname = normalizeHostname(pageUrl);
    if (!AUTH_SUCCESS_HOSTS.has(hostname)) return false;
    return !/\/auth(?:[/?#]|$)/i.test(pageUrl);
}

function hasSessionLikeCookie(cookies = []) {
    return (Array.isArray(cookies) ? cookies : []).some((cookie) => {
        const domain = String(cookie?.domain || '').toLowerCase();
        const name = String(cookie?.name || '').toLowerCase();
        if (!(domain.includes('chatgpt.com') || domain.includes('openai.com'))) return false;
        return name.includes('session') || name.includes('auth') || name.includes('csrf') || name.startsWith('__secure-next-auth');
    });
}

async function importCookiesIntoElectron(targetWindow, cookies = []) {
    if (!targetWindow || targetWindow.isDestroyed()) {
        throw new Error('Ana pencere bulunamadı.');
    }

    const targetSession = targetWindow.webContents.session;
    for (const cookie of Array.isArray(cookies) ? cookies : []) {
        const domain = String(cookie?.domain || '').trim();
        const normalizedDomain = domain.replace(/^\./, '');
        if (!normalizedDomain) continue;
        if (!AUTH_COPY_URLS.some((item) => normalizeHostname(item) === normalizedDomain || normalizedDomain.endsWith(`.${normalizeHostname(item)}`))) {
            continue;
        }

        const protocol = cookie?.secure ? 'https' : 'http';
        const cookieUrl = `${protocol}://${normalizedDomain}${String(cookie?.path || '/').startsWith('/') ? String(cookie?.path || '/') : `/${String(cookie?.path || '/')}`}`;
        const payload = {
            url: cookieUrl,
            name: String(cookie?.name || ''),
            value: String(cookie?.value || ''),
            domain,
            path: String(cookie?.path || '/'),
            secure: Boolean(cookie?.secure),
            httpOnly: Boolean(cookie?.httpOnly),
            sameSite: mapCookieSameSite(cookie?.sameSite)
        };
        if (Number.isFinite(Number(cookie?.expires)) && Number(cookie.expires) > 0) {
            payload.expirationDate = Number(cookie.expires);
        }
        if (!payload.name) continue;
        try {
            await targetSession.cookies.set(payload);
        } catch (_) {
            // Bazı çerezler uyumsuz gelebilir; geri kalanları yine de taşıyalım.
        }
    }
}

async function waitForSuccessfulAuthAndImport(targetWindow, timeoutMs = AUTH_HELPER_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastCookies = [];
    while (Date.now() < deadline) {
        const targets = await getAuthHelperTargets();
        const pages = (Array.isArray(targets) ? targets : []).filter((target) => String(target?.type || '') === 'page');
        const successTarget = pages.find(isSuccessfulAuthTarget);
        if (successTarget?.webSocketDebuggerUrl) {
            lastCookies = await getCookiesFromDebugTarget(successTarget.webSocketDebuggerUrl);
            if (hasSessionLikeCookie(lastCookies)) {
                await importCookiesIntoElectron(targetWindow, lastCookies);
                return {
                    imported: true,
                    targetUrl: String(successTarget.url || chatgptStartUrl),
                    cookies: lastCookies
                };
            }
        }
        await sleep(AUTH_HELPER_POLL_MS);
    }

    if (hasSessionLikeCookie(lastCookies)) {
        await importCookiesIntoElectron(targetWindow, lastCookies);
        return {
            imported: true,
            targetUrl: chatgptStartUrl,
            cookies: lastCookies
        };
    }

    throw new Error('Google girişi zaman aşımına uğradı veya oturum cookie\'leri alınamadı.');
}

async function startGoogleAuthTransfer(targetUrl = '', targetWindow = null) {
    if (externalAuthFlow) return externalAuthFlow;

    externalAuthFlow = (async () => {
        const browserExecutable = findExternalChromiumExecutable();
        if (!browserExecutable) {
            throw new Error('Chrome veya Edge bulunamadı.');
        }

        fs.mkdirSync(AUTH_HELPER_PROFILE_DIR, { recursive: true });
        const authUrl = String(targetUrl || 'https://chatgpt.com/auth/login?next=%2F').trim();
        const browserArgs = [
            `--remote-debugging-port=${AUTH_HELPER_DEBUG_PORT}`,
            `--user-data-dir=${AUTH_HELPER_PROFILE_DIR}`,
            '--new-window',
            '--no-first-run',
            '--disable-sync',
            '--disable-default-apps',
            authUrl
        ];

        const helperProcess = spawn(browserExecutable, browserArgs, {
            cwd: userDataDir,
            detached: false,
            stdio: 'ignore',
            windowsHide: false
        });

        try {
            await waitForAuthHelperTargets();
            const result = await waitForSuccessfulAuthAndImport(targetWindow || mainWindow);
            if (targetWindow && !targetWindow.isDestroyed()) {
                targetWindow.loadURL(result.targetUrl || chatgptStartUrl, { userAgent: buildChromeLikeUserAgent() }).catch(() => {
                    targetWindow.webContents.reloadIgnoringCache();
                });
                restoreMainWindow();
            }
            return result;
        } finally {
            taskKillPidTree(helperProcess.pid);
            externalAuthFlow = null;
        }
    })();

    return externalAuthFlow;
}

function wireNavigationShortcuts(window) {
    window.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;

        if (input.alt && input.key === 'Left' && window.webContents.canGoBack()) {
            event.preventDefault();
            window.webContents.goBack();
            return;
        }

        if (input.alt && input.key === 'Right' && window.webContents.canGoForward()) {
            event.preventDefault();
            window.webContents.goForward();
            return;
        }

        if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
            event.preventDefault();
            window.webContents.reload();
            return;
        }

        if (input.key === 'F5') {
            event.preventDefault();
            window.webContents.reload();
        }
    });
}

function focusWindow(window) {
    if (!window || window.isDestroyed()) return;
    try {
        if (window.isMinimized()) window.restore();
        if (!window.isVisible()) window.show();
        window.moveTop();
        window.focus();
    } catch (_) {
        // Sessizce devam et.
    }
}

async function createOpsCockpitWindow() {
    const icon = resolveAppIcon();
    const window = new BrowserWindow({
        ...COCKPIT_WINDOW_BOUNDS,
        show: false,
        backgroundColor: '#08111c',
        autoHideMenuBar: true,
        title: 'HADES Ops Cockpit',
        icon: icon || undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
            webviewTag: true,
            backgroundThrottling: false
        }
    });

    if (icon) window.setIcon(icon);
    window.loadFile(path.join(__dirname, 'ops-cockpit.html'));
    window.once('ready-to-show', () => {
        window.show();
        focusWindow(window);
    });
    window.on('closed', () => {
        if (cockpitWindow === window) {
            cockpitWindow = null;
        }
    });
    return window;
}

async function openOpsCockpitWindow() {
    if (cockpitWindow && !cockpitWindow.isDestroyed()) {
        focusWindow(cockpitWindow);
        return cockpitWindow;
    }

    cockpitWindow = await createOpsCockpitWindow();
    return cockpitWindow;
}

function minimizeOpsCockpitWindow() {
    if (!cockpitWindow || cockpitWindow.isDestroyed()) {
        return false;
    }
    cockpitWindow.minimize();
    return true;
}

function getOpsCockpitState() {
    if (!cockpitWindow || cockpitWindow.isDestroyed()) {
        return {
            ok: true,
            exists: false,
            visible: false,
            minimized: false,
            focused: false
        };
    }

    return {
        ok: true,
        exists: true,
        visible: cockpitWindow.isVisible(),
        minimized: cockpitWindow.isMinimized(),
        focused: cockpitWindow.isFocused()
    };
}

function buildAmbientDisplayPayload(display, index = 0, total = 1) {
    const bounds = display?.bounds || { x: 0, y: 0, width: 1280, height: 720 };
    const scaleFactor = Number(display?.scaleFactor || 1) || 1;
    const label = String(display?.label || '').trim() || `Display ${index + 1}`;
    const primaryId = screen.getPrimaryDisplay()?.id;
    return {
        id: String(display?.id ?? index),
        index,
        total,
        label,
        primary: display?.id === primaryId,
        x: Math.round(bounds.x || 0),
        y: Math.round(bounds.y || 0),
        width: Math.max(480, Math.round(bounds.width || 1280)),
        height: Math.max(320, Math.round(bounds.height || 720)),
        scaleFactor
    };
}

function buildAmbientViewportPayload() {
    const displays = screen.getAllDisplays();
    if (!Array.isArray(displays) || !displays.length) {
        return buildAmbientDisplayPayload(null, 0, 1);
    }

    const primary = screen.getPrimaryDisplay();
    const rect = displays.reduce((acc, display) => {
        const bounds = display?.bounds || { x: 0, y: 0, width: 0, height: 0 };
        const x = Number(bounds.x || 0);
        const y = Number(bounds.y || 0);
        const width = Number(bounds.width || 0);
        const height = Number(bounds.height || 0);
        acc.minX = Math.min(acc.minX, x);
        acc.minY = Math.min(acc.minY, y);
        acc.maxX = Math.max(acc.maxX, x + width);
        acc.maxY = Math.max(acc.maxY, y + height);
        return acc;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

    return {
        id: 'ambient:virtual',
        index: 0,
        total: displays.length,
        label: displays.length > 1 ? 'All Displays' : String(primary?.label || 'Display 1'),
        primary: true,
        x: Math.round(Number.isFinite(rect.minX) ? rect.minX : 0),
        y: Math.round(Number.isFinite(rect.minY) ? rect.minY : 0),
        width: Math.max(480, Math.round((Number.isFinite(rect.maxX) ? rect.maxX : 1280) - (Number.isFinite(rect.minX) ? rect.minX : 0))),
        height: Math.max(320, Math.round((Number.isFinite(rect.maxY) ? rect.maxY : 720) - (Number.isFinite(rect.minY) ? rect.minY : 0))),
        scaleFactor: Number(primary?.scaleFactor || 1) || 1
    };
}

function emitAmbientDisplayChanged(window, payload) {
    if (!window || window.isDestroyed()) return;
    try {
        window.webContents.send('hades:ambientDisplayChanged', payload);
    } catch (_) {
        // Render süreci hazır değilse sessizce devam et.
    }
}

function buildAmbientQuery(payload = {}) {
    return {
        displayId: String(payload.id || ''),
        index: String(payload.index || 0),
        total: String(payload.total || 1),
        label: String(payload.label || ''),
        primary: payload.primary ? '1' : '0',
        x: String(payload.x || 0),
        y: String(payload.y || 0),
        width: String(payload.width || 0),
        height: String(payload.height || 0),
        scaleFactor: String(payload.scaleFactor || 1)
    };
}

async function attachWindowToWallpaper(window, payload = {}, options = {}) {
    if (process.platform !== 'win32' || !window || window.isDestroyed()) return false;
    const scriptPath = prepareRuntimeAmbientWallpaperHelperPath();
    const nativeHandle = nativeWindowHandleToString(window);
    if (!scriptPath || !nativeHandle) return false;
    const interactive = Boolean(options.interactive);

    return new Promise((resolve) => {
        const args = [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
            '-WindowHandle', nativeHandle,
            '-X', String(Math.round(payload.x || 0)),
            '-Y', String(Math.round(payload.y || 0)),
            '-Width', String(Math.max(320, Math.round(payload.width || 1280))),
            '-Height', String(Math.max(240, Math.round(payload.height || 720)))
        ];
        if (interactive) {
            args.push('-Interactive');
        }

        const child = spawn('powershell.exe', args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });
        child.once('error', () => resolve(false));
        child.once('exit', (code) => {
            if (code !== 0 && stderr.trim()) {
                console.warn(`[ambient-wallpaper] ${stderr.trim()}`);
            }
            if (code !== 0 && !stderr.trim() && stdout.trim()) {
                console.warn(`[ambient-wallpaper] ${stdout.trim()}`);
            }
            resolve(code === 0);
        });
    });
}

async function syncAmbientWindowHost(window, payload = {}) {
    if (!window || window.isDestroyed()) return false;
    if (!window.isVisible()) {
        window.showInactive();
    }
    let attached = false;
    for (const delay of [0, 90, 240, 560]) {
        if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (!window || window.isDestroyed()) return false;
        attached = await attachWindowToWallpaper(window, payload, { interactive: false });
        if (attached) break;
    }

    try {
        if (typeof window.setFocusable === 'function') {
            window.setFocusable(false);
        }
        window.setIgnoreMouseEvents(true, { forward: false });
    } catch (_) {
        // Sessizce devam et.
    }

    try {
        window.webContents.send('hades:ambientDisplayChanged', {
            ...payload,
            wallpaperAttached: attached
        });
    } catch (_) {
        // Sessizce devam et.
    }
    return attached;
}

function queueAmbientWindowHostSync(window, payload = {}) {
    ambientHostSyncChain = ambientHostSyncChain
        .catch(() => false)
        .then(async () => {
            if (!ambientDesktopEnabled || !window || window.isDestroyed()) return false;
            return syncAmbientWindowHost(window, payload);
        });
    return ambientHostSyncChain;
}

function scheduleAmbientHostRefresh(delay = 720) {
    if (ambientHostRefreshTimer) {
        clearTimeout(ambientHostRefreshTimer);
    }

    ambientHostRefreshTimer = setTimeout(async () => {
        ambientHostRefreshTimer = null;
        if (!ambientDesktopEnabled || OVERLAY_ONLY) return;
        const displays = screen.getAllDisplays();
        const entries = Array.isArray(displays) && displays.length ? displays : [null];
        for (let index = 0; index < entries.length; index += 1) {
            const payload = buildAmbientDisplayPayload(entries[index], index, entries.length);
            const window = ambientDesktopWindows.get(payload.id);
            if (!window || window.isDestroyed()) continue;
            emitAmbientDisplayChanged(window, {
                ...payload,
                wallpaperAttached: false
            });
            await queueAmbientWindowHostSync(window, payload);
        }
    }, delay);
}

function buildAmbientControlDockPayload(display = screen.getPrimaryDisplay(), expanded = ambientControlDockExpanded) {
    const bounds = display?.bounds || display?.workArea || { x: 0, y: 0, width: 1280, height: 720 };
    const workArea = display?.workArea || bounds;
    const width = expanded
        ? Math.min(AMBIENT_CONTROL_DOCK_BOUNDS.expandedWidth, Math.max(300, workArea.width - 28))
        : AMBIENT_CONTROL_DOCK_BOUNDS.collapsedWidth;
    const height = expanded
        ? Math.min(AMBIENT_CONTROL_DOCK_BOUNDS.expandedHeight, Math.max(380, workArea.height - 36))
        : Math.min(AMBIENT_CONTROL_DOCK_BOUNDS.collapsedHeight, Math.max(72, workArea.height - 24));

    return {
        id: `dock:${display?.id ?? 'primary'}`,
        x: bounds.x + AMBIENT_CONTROL_DOCK_BOUNDS.margin,
        y: workArea.y + AMBIENT_CONTROL_DOCK_BOUNDS.margin,
        width,
        height
    };
}

async function syncAmbientControlDockWindow(window = ambientControlDockWindow) {
    if (!window || window.isDestroyed()) return false;
    const payload = buildAmbientControlDockPayload();
    const currentBounds = window.getBounds();
    if (
        currentBounds.x !== payload.x ||
        currentBounds.y !== payload.y ||
        currentBounds.width !== payload.width ||
        currentBounds.height !== payload.height
    ) {
        window.setBounds(payload, false);
    }

    if (!window.isDestroyed()) {
        window.setIgnoreMouseEvents(false);
        if (typeof window.setFocusable === 'function') {
            window.setFocusable(true);
        }
        window.show();
    }
    return true;
}

function createAmbientControlDockWindow() {
    const payload = buildAmbientControlDockPayload();
    const window = new BrowserWindow({
        x: payload.x,
        y: payload.y,
        width: payload.width,
        height: payload.height,
        show: false,
        frame: false,
        transparent: true,
        focusable: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        title: 'HADES Ambient Dock',
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
            backgroundThrottling: false
        }
    });

    window.setMenuBarVisibility(false);
    try {
        window.setAlwaysOnTop(true, 'screen-saver');
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_) {
        // Sessizce devam et.
    }

    window.loadFile(path.join(__dirname, 'ambient-control-dock.html'));
    window.webContents.once('did-finish-load', () => {
        void syncAmbientControlDockWindow(window);
    });
    window.once('ready-to-show', () => {
        void syncAmbientControlDockWindow(window);
    });
    window.on('closed', () => {
        if (ambientControlDockWindow === window) {
            ambientControlDockWindow = null;
        }
    });
    return window;
}

function ensureAmbientControlDockWindow() {
    if (!ambientDesktopEnabled || OVERLAY_ONLY) return;
    if (!ambientControlDockWindow || ambientControlDockWindow.isDestroyed()) {
        ambientControlDockWindow = createAmbientControlDockWindow();
        return;
    }

    void syncAmbientControlDockWindow(ambientControlDockWindow);
}

function setAmbientControlDockExpanded(expanded) {
    ambientControlDockExpanded = typeof expanded === 'boolean' ? expanded : !ambientControlDockExpanded;
    if (ambientControlDockWindow && !ambientControlDockWindow.isDestroyed()) {
        void syncAmbientControlDockWindow(ambientControlDockWindow);
    }
    return {
        ok: true,
        expanded: ambientControlDockExpanded
    };
}

function destroyAmbientControlDockWindow() {
    if (!ambientControlDockWindow || ambientControlDockWindow.isDestroyed()) {
        ambientControlDockWindow = null;
        return;
    }

    try {
        ambientControlDockWindow.destroy();
    } catch (_) {
        // Sessizce devam et.
    }
    ambientControlDockWindow = null;
}

function createAmbientDesktopWindow(display, index = 0, total = 1) {
    const payload = display && !display.bounds && Number.isFinite(display.width) && Number.isFinite(display.height)
        ? display
        : buildAmbientDisplayPayload(display, index, total);
    const window = new BrowserWindow({
        x: payload.x,
        y: payload.y,
        width: payload.width,
        height: payload.height,
        show: false,
        frame: false,
        transparent: true,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        hasShadow: false,
        title: `HADES Ambient ${payload.index + 1}`,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
            backgroundThrottling: false
        }
    });

    window.setMenuBarVisibility(false);
    window.setIgnoreMouseEvents(true, { forward: false });
    try {
        window.setAlwaysOnTop(false);
    } catch (_) {
        // Platform farklarinda sessizce devam et.
    }

    window.loadFile(path.join(__dirname, 'desktop-ambient.html'), {
        query: buildAmbientQuery(payload)
    });
    window.webContents.once('did-finish-load', () => {
        emitAmbientDisplayChanged(window, {
            ...payload,
            wallpaperAttached: false
        });
    });
    window.once('ready-to-show', () => {
        window.showInactive();
        void queueAmbientWindowHostSync(window, payload);
    });
    window.on('closed', () => {
        ambientDesktopWindows.delete(String(payload.id));
    });

    return window;
}

function destroyAmbientDesktopWindows() {
    for (const window of ambientDesktopWindows.values()) {
        if (!window || window.isDestroyed()) continue;
        try {
            window.destroy();
        } catch (_) {
            // Sessizce devam et.
        }
    }
    ambientDesktopWindows.clear();
}

function syncAmbientDesktopWindows() {
    if (!ambientDesktopEnabled || OVERLAY_ONLY) {
        destroyAmbientDesktopWindows();
        destroyAmbientControlDockWindow();
        return;
    }

    const displays = screen.getAllDisplays();
    const entries = Array.isArray(displays) && displays.length ? displays : [null];
    const seenKeys = new Set();

    entries.forEach((display, index) => {
        const payload = buildAmbientDisplayPayload(display, index, entries.length);
        seenKeys.add(payload.id);
        let window = ambientDesktopWindows.get(payload.id);

        if (!window || window.isDestroyed()) {
            window = createAmbientDesktopWindow(payload, index, entries.length);
            ambientDesktopWindows.set(payload.id, window);
            return;
        }

        const currentBounds = window.getBounds();
        if (
            currentBounds.x !== payload.x ||
            currentBounds.y !== payload.y ||
            currentBounds.width !== payload.width ||
            currentBounds.height !== payload.height
        ) {
            window.setBounds({
                x: payload.x,
                y: payload.y,
                width: payload.width,
                height: payload.height
            }, false);
        }

        if (!window.isVisible()) {
            window.showInactive();
        }
        emitAmbientDisplayChanged(window, {
            ...payload,
            wallpaperAttached: false
        });
        void queueAmbientWindowHostSync(window, payload);
    });

    for (const [key, window] of ambientDesktopWindows.entries()) {
        if (seenKeys.has(key)) continue;
        try {
            window.destroy();
        } catch (_) {
            // Sessizce devam et.
        }
        ambientDesktopWindows.delete(key);
    }
    ensureAmbientControlDockWindow();
}

function scheduleAmbientDesktopSync() {
    if (ambientDisplaySyncTimer) {
        clearTimeout(ambientDisplaySyncTimer);
    }

    ambientDisplaySyncTimer = setTimeout(() => {
        ambientDisplaySyncTimer = null;
        syncAmbientDesktopWindows();
    }, 140);
}

function watchAmbientDisplays() {
    if (ambientDisplayWatching) return;
    ambientDisplayWatching = true;
    screen.on('display-added', scheduleAmbientDesktopSync);
    screen.on('display-removed', scheduleAmbientDesktopSync);
    screen.on('display-metrics-changed', scheduleAmbientDesktopSync);
}

function getAmbientDesktopState() {
    return {
        ok: true,
        enabled: ambientDesktopEnabled,
        activeCount: [...ambientDesktopWindows.values()].filter((window) => window && !window.isDestroyed()).length,
        dockVisible: Boolean(ambientControlDockWindow && !ambientControlDockWindow.isDestroyed()),
        displays: screen.getAllDisplays().map((display, index, entries) => buildAmbientDisplayPayload(display, index, entries.length)),
        cloaked: Boolean(mainWindowCloakState)
    };
}

function openAmbientDesktop() {
    ambientDesktopEnabled = true;
    ambientControlDockExpanded = false;
    destroyAmbientDesktopWindows();
    destroyAmbientControlDockWindow();
    watchAmbientDisplays();
    syncAmbientDesktopWindows();
    scheduleAmbientHostRefresh();
    hideMainWindow();
    return getAmbientDesktopState();
}

function hideAmbientDesktop() {
    ambientDesktopEnabled = false;
    ambientControlDockExpanded = false;
    destroyAmbientDesktopWindows();
    destroyAmbientControlDockWindow();
    if (mainWindowCloakState) {
        restoreMainWindow();
    }
    return getAmbientDesktopState();
}

function toggleAmbientDesktop(forceValue) {
    const nextValue = typeof forceValue === 'boolean' ? forceValue : !ambientDesktopEnabled;
    return nextValue ? openAmbientDesktop() : hideAmbientDesktop();
}

function armAmbientDesktopMode(window = mainWindow) {
    if (!ambientDesktopEnabled || !window || window.isDestroyed()) return;
    watchAmbientDisplays();
    syncAmbientDesktopWindows();

    const cloakMainWindow = () => {
        if (ambientDesktopEnabled && mainWindow === window && !window.isDestroyed()) {
            hideMainWindow();
        }
    };

    if (window.webContents.isLoadingMainFrame()) {
        window.webContents.once('did-finish-load', () => {
            setTimeout(cloakMainWindow, 320);
        });
        return;
    }

    setTimeout(cloakMainWindow, 320);
}

async function createMainWindow() {
    const icon = resolveAppIcon();
    const window = new BrowserWindow({
        ...WINDOW_BOUNDS,
        show: false,
        backgroundColor: '#0b1020',
        autoHideMenuBar: true,
        title: 'HADES',
        icon: icon || undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: true,
            autoplayPolicy: 'no-user-gesture-required',
            backgroundThrottling: false
        }
    });

    if (typeof window.webContents.setBackgroundThrottling === 'function') {
        try {
            window.webContents.setBackgroundThrottling(false);
        } catch (_) {
            // Electron sürüm farklarında sessizce devam et.
        }
    }

    configureSessionHandlers(window.webContents.session);
    await ensureBridgeExtensionLoaded(window.webContents.session);
    wireNavigationShortcuts(window);
    if (icon) window.setIcon(icon);
    window.webContents.setUserAgent(buildChromeLikeUserAgent());
    window.loadURL(chatgptStartUrl, { userAgent: buildChromeLikeUserAgent() });
    window.webContents.on('did-finish-load', () => {
        syncMainWindowVoiceContext(window, { parked: false, hidden: false, cloaked: Boolean(mainWindowCloakState) });
    });

    window.once('ready-to-show', () => {
        window.show();
        window.focus();
    });

    const keepRendererWarm = () => {
        if (typeof window.webContents.setBackgroundThrottling !== 'function') return;
        try {
            window.webContents.setBackgroundThrottling(false);
        } catch (_) {
            // Sessizce devam et.
        }
    };

    window.on('show', keepRendererWarm);
    window.on('restore', keepRendererWarm);
    window.on('minimize', keepRendererWarm);
    window.on('hide', keepRendererWarm);
    window.on('show', () => syncMainWindowVoiceContext(window, { parked: false, hidden: false, cloaked: Boolean(mainWindowCloakState) }));
    window.on('restore', () => syncMainWindowVoiceContext(window, { parked: false, hidden: false, cloaked: Boolean(mainWindowCloakState) }));
    window.on('focus', () => syncMainWindowVoiceContext(window, { parked: false, hidden: false, cloaked: Boolean(mainWindowCloakState) }));
    window.on('hide', () => syncMainWindowVoiceContext(window, { parked: true, hidden: true, cloaked: false }));
    window.on('minimize', () => syncMainWindowVoiceContext(window, { parked: true, hidden: true, cloaked: false }));

    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isGoogleManagedAuthUrl(url)) {
            void startGoogleAuthTransfer(url, window).catch((error) => {
                dialog.showErrorBox('Google girişi açılamadı', error?.message || String(error));
            });
            return { action: 'deny' };
        }

        if (isTrustedShellUrl(url)) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    autoHideMenuBar: true,
                    backgroundColor: '#0b1020',
                    icon: icon || undefined,
                    webPreferences: {
                        preload: path.join(__dirname, 'preload.js'),
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                        spellcheck: true,
                        autoplayPolicy: 'no-user-gesture-required',
                        backgroundThrottling: false
                    }
                }
            };
        }

        shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
        handleNavigationAttempt(event, url, window);
    });

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
        if (errorCode === 0) return;

        dialog.showErrorBox(
            'HADES yüklenemedi',
            `Adres: ${validatedUrl || chatgptStartUrl}\nHata: ${errorDescription || errorCode}`
        );
    });

    return window;
}

function createOverlayWindow() {
    const window = new BrowserWindow({
        ...getOverlayBounds(),
        frame: false,
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        title: 'HADES Voice HUD',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false
        }
    });

    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setMenuBarVisibility(false);
    window.loadFile(path.join(__dirname, 'voice-overlay.html'));
    window.once('ready-to-show', () => {
        window.showInactive();
    });
    window.on('move', writeOverlayBounds);
    return window;
}

async function bootstrapDesktopApp() {
    const singleInstanceLock = app.requestSingleInstanceLock();
    if (!singleInstanceLock) {
        app.quit();
        return;
    }

    app.on('second-instance', () => {
        if (OVERLAY_ONLY) {
            if (!overlayWindow) return;
            overlayWindow.showInactive();
            return;
        }

        if (!mainWindow) return;
        if (ambientDesktopEnabled && mainWindowCloakState) {
            openAmbientDesktop();
            return;
        }
        restoreMainWindow();
    });

    process.env.HADES_APP_VERSION = app.getVersion();
    if (!powerSaveBlocker.isStarted(powerSaveBlockerId || -1)) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    try {
        globalShortcut.register('CommandOrControl+Shift+H', () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (mainWindowCloakState) {
                restoreMainWindow();
                return;
            }
            hideMainWindow();
        });
        globalShortcut.register('CommandOrControl+Shift+O', () => {
            void openOpsCockpitWindow();
        });
        globalShortcut.register('CommandOrControl+Shift+D', () => {
            toggleAmbientDesktop();
        });
    } catch (_) {
        // Kisayol kaydolmazsa uygulama yine devam etsin.
    }
    ensureRestoreSignalWatcher();
    createApplicationMenu();
    if (OVERLAY_ONLY) {
        overlayWindow = createOverlayWindow();
    } else {
        mainWindow = await createMainWindow();
        armAmbientDesktopMode(mainWindow);
    }

    app.on('activate', () => {
        if (OVERLAY_ONLY) {
            if (!overlayWindow || overlayWindow.isDestroyed()) {
                overlayWindow = createOverlayWindow();
                return;
            }

            overlayWindow.showInactive();
            return;
        }

        if (!mainWindow || mainWindow.isDestroyed()) {
            void createMainWindow().then((window) => {
                mainWindow = window;
                armAmbientDesktopMode(window);
            });
            return;
        }

        if (ambientDesktopEnabled && mainWindowCloakState) {
            watchAmbientDisplays();
            syncAmbientDesktopWindows();
            return;
        }

        restoreMainWindow();
    });
}

ipcMain.handle('hades:openExternal', async (_event, targetUrl = '') => {
    const safeUrl = String(targetUrl || '').trim();
    if (!safeUrl) {
        return { ok: false };
    }
    await shell.openExternal(safeUrl);
    return { ok: true, url: safeUrl };
});

ipcMain.handle('hades:openOpsCockpit', async () => {
    await openOpsCockpitWindow();
    return { ok: true };
});

ipcMain.handle('hades:minimizeOpsCockpit', () => {
    return { ok: minimizeOpsCockpitWindow() };
});

ipcMain.handle('hades:getOpsCockpitState', () => {
    return getOpsCockpitState();
});

ipcMain.handle('hades:openAmbientDesktop', () => {
    return openAmbientDesktop();
});

ipcMain.handle('hades:hideAmbientDesktop', () => {
    return hideAmbientDesktop();
});

ipcMain.handle('hades:toggleAmbientDesktop', (_event, forceValue) => {
    return toggleAmbientDesktop(typeof forceValue === 'boolean' ? forceValue : undefined);
});

ipcMain.handle('hades:getAmbientDesktopState', () => {
    return getAmbientDesktopState();
});

ipcMain.handle('hades:setAmbientControlDockExpanded', (_event, expanded) => {
    return setAmbientControlDockExpanded(typeof expanded === 'boolean' ? expanded : undefined);
});

ipcMain.handle('hades:getAmbientControlDockState', () => {
    return {
        ok: true,
        expanded: ambientControlDockExpanded,
        visible: Boolean(ambientControlDockWindow && !ambientControlDockWindow.isDestroyed())
    };
});

ipcMain.handle('hades:minimizeCurrentWindow', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) {
        return { ok: false };
    }
    window.minimize();
    return { ok: true };
});

ipcMain.handle('hades:restoreMainWindow', () => {
    restoreMainWindow();
    return { ok: true };
});

ipcMain.handle('hades:hideMainWindow', () => {
    hideMainWindow();
    return { ok: true };
});

app.whenReady().then(bootstrapDesktopApp).catch((error) => {
    dialog.showErrorBox('HADES başlatılamadı', error?.message || String(error));
    app.quit();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    try {
        globalShortcut.unregisterAll();
    } catch (_) {
        // Sessizce devam et.
    }
});

app.on('before-quit', () => {
    if (restoreSignalWatching) {
        try {
            fs.unwatchFile(RESTORE_SIGNAL_PATH);
        } catch (_) {
            // Sessizce devam et.
        }
    }
    if (powerSaveBlocker.isStarted(powerSaveBlockerId || -1)) {
        try {
            powerSaveBlocker.stop(powerSaveBlockerId);
        } catch (_) {
            // Sessizce devam et.
        }
    }
    if (ambientDisplaySyncTimer) {
        clearTimeout(ambientDisplaySyncTimer);
        ambientDisplaySyncTimer = null;
    }
    if (ambientHostRefreshTimer) {
        clearTimeout(ambientHostRefreshTimer);
        ambientHostRefreshTimer = null;
    }
    destroyAmbientControlDockWindow();
    destroyAmbientDesktopWindows();
});
