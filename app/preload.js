const { contextBridge, ipcRenderer } = require('electron');

const backendPort = process.env.HADES_BACKEND_PORT || '3001';
const backendBase = `http://127.0.0.1:${backendPort}`;

function markDesktopShell() {
    try {
        if (!document?.documentElement) return;
        document.documentElement.setAttribute('data-hades-desktop-shell', 'electron');
        document.documentElement.setAttribute('data-hades-persistent-background', 'true');
        document.documentElement.setAttribute('data-hades-can-hide', 'true');
    } catch (_) {
        // Preload asla bootstrapi durdurmamali.
    }
}

function invokeBridgeAction(action = '', detail = {}) {
    const safeAction = String(action || '').trim();
    if (!safeAction) return Promise.resolve({ ok: false });

    switch (safeAction) {
        case 'hide-main-window':
            return ipcRenderer.invoke('hades:hideMainWindow');
        case 'restore-main-window':
            return ipcRenderer.invoke('hades:restoreMainWindow');
        case 'open-ops-cockpit':
            return ipcRenderer.invoke('hades:openOpsCockpit');
        case 'minimize-ops-cockpit':
            return ipcRenderer.invoke('hades:minimizeOpsCockpit');
        case 'open-ambient-desktop':
            return ipcRenderer.invoke('hades:openAmbientDesktop');
        case 'hide-ambient-desktop':
            return ipcRenderer.invoke('hades:hideAmbientDesktop');
        case 'toggle-ambient-desktop':
            return ipcRenderer.invoke('hades:toggleAmbientDesktop');
        case 'set-ambient-dock-expanded':
            return ipcRenderer.invoke('hades:setAmbientControlDockExpanded', Boolean(detail.expanded));
        case 'open-external':
            return ipcRenderer.invoke('hades:openExternal', detail.url || detail.targetUrl || '');
        default:
            return Promise.resolve({ ok: false });
    }
}

markDesktopShell();
window.addEventListener('DOMContentLoaded', markDesktopShell, { once: true });
window.addEventListener('hades-desktop-bridge', (event) => {
    const detail = event?.detail || {};
    invokeBridgeAction(detail.action, detail).catch(() => {});
});
ipcRenderer.on('hades:ambientDisplayChanged', (_event, detail = {}) => {
    try {
        window.dispatchEvent(new CustomEvent('hades-ambient-display-changed', { detail }));
    } catch (_) {
        // UI tarafini asla bozma.
    }
});

contextBridge.exposeInMainWorld('HADESDesktop', Object.freeze({
    isDesktop: true,
    appVersion: process.env.HADES_APP_VERSION || '1.0.0',
    platform: process.platform,
    backendBase,
    capabilities: Object.freeze({
        openAiProxy: Boolean(process.env.OPENAI_API_KEY)
    }),
    initialRuntimeConfig: Object.freeze({
        deepgramApiKey: String(process.env.DEEPGRAM_API_KEY || '').trim()
    }),
    openExternal: (targetUrl) => ipcRenderer.invoke('hades:openExternal', targetUrl),
    openOpsCockpit: () => ipcRenderer.invoke('hades:openOpsCockpit'),
    minimizeOpsCockpit: () => ipcRenderer.invoke('hades:minimizeOpsCockpit'),
    getOpsCockpitState: () => ipcRenderer.invoke('hades:getOpsCockpitState'),
    openAmbientDesktop: () => ipcRenderer.invoke('hades:openAmbientDesktop'),
    hideAmbientDesktop: () => ipcRenderer.invoke('hades:hideAmbientDesktop'),
    toggleAmbientDesktop: () => ipcRenderer.invoke('hades:toggleAmbientDesktop'),
    getAmbientDesktopState: () => ipcRenderer.invoke('hades:getAmbientDesktopState'),
    setAmbientControlDockExpanded: (expanded) => ipcRenderer.invoke('hades:setAmbientControlDockExpanded', expanded),
    getAmbientControlDockState: () => ipcRenderer.invoke('hades:getAmbientControlDockState'),
    minimizeCurrentWindow: () => ipcRenderer.invoke('hades:minimizeCurrentWindow'),
    hideMainWindow: () => ipcRenderer.invoke('hades:hideMainWindow'),
    restoreMainWindow: () => ipcRenderer.invoke('hades:restoreMainWindow')
}));
