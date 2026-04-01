const { contextBridge, ipcRenderer } = require('electron');

const backendPort = process.env.HADES_BACKEND_PORT || '3001';
const backendBase = `http://127.0.0.1:${backendPort}`;

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
    openExternal: (targetUrl) => ipcRenderer.invoke('hades:openExternal', targetUrl)
}));
