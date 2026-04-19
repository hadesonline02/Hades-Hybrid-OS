(function initHadesWebSkill(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESWebSkill = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWebSkillModule() {
    'use strict';

    const resolveBackendBase = (value = '') => {
        const fallback = (typeof globalThis !== 'undefined' && globalThis.__HADES_BACKEND_BASE__)
            ? globalThis.__HADES_BACKEND_BASE__
            : 'http://127.0.0.1:3001';
        return String(value || fallback).replace(/\/+$/, '');
    };

    const normalizeText = (value = '') => String(value).replace(/\s+/g, ' ').trim();

    const buildSearchUrl = (queryText = '') => {
        const query = normalizeText(queryText) || 'genel arama';
        return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    };

    const searchViaBackend = async (queryText = '', options = {}) => {
        const backendBase = resolveBackendBase(options.backendBase);
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutMs = Math.max(3000, parseInt(options.timeoutMs, 10) || 9000);
        const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

        try {
            const response = await fetch(`${backendBase}/web/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: queryText }),
                signal: controller ? controller.signal : undefined
            });
            if (!response.ok) return null;
            const payload = await response.json();
            if (!payload || payload.ok !== true) return null;
            return payload;
        } catch (_) {
            return null;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    };

    const searchWeb = async (queryText = '', options = {}) => {
        const query = normalizeText(queryText) || 'genel arama';
        const backendPayload = await searchViaBackend(query, options);
        const targetUrl = backendPayload?.searchUrl || buildSearchUrl(query);

        if (options.autoOpen && typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(targetUrl, '_blank');
        }

        if (backendPayload && backendPayload.answer) {
            return {
                ok: true,
                mode: 'web',
                reply: backendPayload.answer,
                query,
                url: targetUrl,
                results: Array.isArray(backendPayload.results) ? backendPayload.results : [],
                source: backendPayload.source || 'backend_web_search'
            };
        }

        const fallbackReply = `Webde araştırdım ama net özet çıkaramadım. Dilersen sonucu birlikte açabiliriz: ${query}.`;
        return {
            ok: true,
            mode: 'web',
            reply: fallbackReply,
            query,
            url: targetUrl,
            results: []
        };
    };

    return Object.freeze({
        buildSearchUrl,
        searchViaBackend,
        searchWeb
    });
});
