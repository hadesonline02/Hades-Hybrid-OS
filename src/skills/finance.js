(function initHadesFinanceSkill(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESFinanceSkill = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createFinanceSkillModule() {
    'use strict';

    const resolveBackendBase = (value = '') => {
        const fallback = (typeof globalThis !== 'undefined' && globalThis.__HADES_BACKEND_BASE__)
            ? globalThis.__HADES_BACKEND_BASE__
            : 'http://127.0.0.1:3001';
        return String(value || fallback).replace(/\/+$/, '');
    };

    const CURRENCY_ALIASES = Object.freeze({
        dolar: 'USD',
        usd: 'USD',
        euro: 'EUR',
        eur: 'EUR',
        sterlin: 'GBP',
        gbp: 'GBP',
        tl: 'TRY',
        try: 'TRY'
    });

    const normalizeTr = (text = '') => String(text)
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/\s+/g, ' ')
        .trim();

    const detectCurrenciesFromText = (rawText = '') => {
        const normalized = normalizeTr(rawText);
        const found = [];

        for (const [token, code] of Object.entries(CURRENCY_ALIASES)) {
            if (normalized.includes(token) && !found.includes(code)) {
                found.push(code);
            }
        }

        if (found.length >= 2) {
            return { base: found[0], quote: found[1] };
        }
        if (found.length === 1) {
            const base = found[0] === 'TRY' ? 'USD' : found[0];
            const quote = found[0] === 'TRY' ? 'USD' : 'TRY';
            return { base, quote };
        }
        return { base: 'USD', quote: 'TRY' };
    };

    const answerFinanceQuery = async (rawText = '', options = {}) => {
        const backendBase = resolveBackendBase(options.backendBase);
        const pair = detectCurrenciesFromText(rawText);

        try {
            const response = await fetch(
                `${backendBase}/finance/rate?base=${encodeURIComponent(pair.base)}&quote=${encodeURIComponent(pair.quote)}`
            );
            if (!response.ok) {
                return { ok: false, reply: `${pair.base}/${pair.quote} kurunu su an cekemedim.` };
            }
            const payload = await response.json();
            if (!payload || typeof payload.rate !== 'number') {
                return { ok: false, reply: `${pair.base}/${pair.quote} kur verisi gecersiz geldi.` };
            }
            const rounded = payload.rate.toFixed(4);
            return {
                ok: true,
                reply: `${pair.base}/${pair.quote} su an yaklasik ${rounded}.`,
                data: payload
            };
        } catch (_) {
            return { ok: false, reply: `${pair.base}/${pair.quote} kurunu simdi cekemedim, birazdan tekrar denerim.` };
        }
    };

    return Object.freeze({
        detectCurrenciesFromText,
        answerFinanceQuery
    });
});
