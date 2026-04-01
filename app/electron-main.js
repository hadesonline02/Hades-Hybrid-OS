const fs = require('fs');
const path = require('path');
const {
    app,
    BrowserWindow,
    Menu,
    dialog,
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
const OVERLAY_ONLY = process.argv.includes('--overlay-only');
const OVERLAY_WINDOW_BOUNDS = Object.freeze({
    width: 300,
    height: 116
});
const OVERLAY_BOUNDS_PATH = path.join(userDataDir, 'voice-overlay-bounds.json');
const RUNTIME_EXTENSION_ROOT = path.join(userDataDir, 'runtime-extensions');

let mainWindow = null;
let overlayWindow = null;
let sessionConfigured = false;
let overlayBoundsTimer = null;
let extensionLoadPromise = null;
let runtimeBridgeExtensionPath = null;

app.setPath('userData', userDataDir);
try {
    app.setPath('sessionData', userDataDir);
} catch (_) {
    // Electron eski bir path listesi ile gelirse sessizce devam et.
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('lang', 'tr-TR');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.userAgentFallback = buildChromeLikeUserAgent();
app.setName('HADES');
app.setAppUserModelId('com.hades.desktop');

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

function handleNavigationAttempt(event, targetUrl = '') {
    const safeUrl = String(targetUrl || '').trim();
    if (!safeUrl) return;

    if (isTrustedShellUrl(safeUrl)) {
        return;
    }

    event.preventDefault();
    shell.openExternal(safeUrl).catch(() => {});
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
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: true,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });

    configureSessionHandlers(window.webContents.session);
    await ensureBridgeExtensionLoaded(window.webContents.session);
    wireNavigationShortcuts(window);
    if (icon) window.setIcon(icon);
    window.webContents.setUserAgent(buildChromeLikeUserAgent());
    window.loadURL(chatgptStartUrl, { userAgent: buildChromeLikeUserAgent() });

    window.once('ready-to-show', () => {
        window.show();
        window.focus();
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isTrustedShellUrl(url)) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    autoHideMenuBar: true,
                    backgroundColor: '#0b1020',
                    icon: icon || undefined,
                    webPreferences: {
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                        spellcheck: true,
                        autoplayPolicy: 'no-user-gesture-required'
                    }
                }
            };
        }

        shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
        handleNavigationAttempt(event, url);
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
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
    });

    process.env.HADES_APP_VERSION = app.getVersion();
    createApplicationMenu();
    if (OVERLAY_ONLY) {
        overlayWindow = createOverlayWindow();
    } else {
        mainWindow = await createMainWindow();
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
            });
            return;
        }

        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
    });
}

app.whenReady().then(bootstrapDesktopApp).catch((error) => {
    dialog.showErrorBox('HADES başlatılamadı', error?.message || String(error));
    app.quit();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
