(function initHadesAppMain(globalScope) {
    'use strict';

    const DEFAULT_BACKEND_BASE = 'http://127.0.0.1:3001';

    const normalizeBaseUrl = (value) => String(value || DEFAULT_BACKEND_BASE).replace(/\/+$/, '');

    const getDesktopBridge = () => {
        const bridge = globalScope.HADESDesktop;
        return bridge && typeof bridge === 'object' ? bridge : null;
    };

    const getBackendBase = () => {
        const desktopBridge = getDesktopBridge();
        return normalizeBaseUrl(desktopBridge?.backendBase || globalScope.__HADES_BACKEND_BASE__);
    };

    const openExternal = (targetUrl = '') => {
        const safeUrl = String(targetUrl || '').trim();
        if (!safeUrl) return false;

        const desktopBridge = getDesktopBridge();
        if (desktopBridge && typeof desktopBridge.openExternal === 'function') {
            desktopBridge.openExternal(safeUrl).catch(() => {});
            return true;
        }

        if (typeof globalScope.open === 'function') {
            globalScope.open(safeUrl, '_blank', 'noopener');
            return true;
        }

        return false;
    };

    const createAppContext = () => ({
        startedAt: new Date().toISOString(),
        version: getDesktopBridge()?.appVersion || 'browser-shell',
        isDesktop: Boolean(getDesktopBridge()?.isDesktop),
        platform: getDesktopBridge()?.platform || 'web',
        backendBase: getBackendBase(),
        capabilities: Object.freeze({
            openAiProxy: Boolean(getDesktopBridge()?.capabilities?.openAiProxy)
        }),
        initialRuntimeConfig: Object.freeze({
            deepgramApiKey: String(getDesktopBridge()?.initialRuntimeConfig?.deepgramApiKey || '').trim()
        })
    });

    globalScope.__HADES_BACKEND_BASE__ = getBackendBase();

    globalScope.HADESAppMain = Object.freeze({
        createAppContext,
        getBackendBase,
        openExternal
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
