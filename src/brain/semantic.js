(function initHadesSemantic(globalScope, factory) {
    const api = factory(globalScope);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESSemantic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSemanticModule(globalScope) {
    'use strict';

    const DEFAULT_CHAT_MODEL = 'gpt-5.2';
    const CHAT_MODEL_FALLBACKS = Object.freeze(['gpt-5-mini', 'gpt-4.1-mini']);
    const WEB_HINT_REGEX = /\b(internette|internetten|webde|google|youtube|yt|arama|ara|bak)\b/;
    const RECENT_HINT_REGEX = /\b(en son|son video|guncel|bugun|az once|simdi)\b/;
    const QUESTION_HINT_REGEX = /\b(nedir|ne|kim|nerede|ne zaman|nasil|neden|kac|hangi|video|atti|paylasti)\b/;

    const normalizeTr = (text = '') => String(text)
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/\s+/g, ' ')
        .trim();

    const extractReplyFromCompletion = (data) => {
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string') return content.trim();
        if (Array.isArray(content)) {
            return content
                .map((part) => (typeof part?.text === 'string' ? part.text : ''))
                .filter(Boolean)
                .join(' ')
                .trim();
        }
        return '';
    };

    const buildHistoryMessages = (history = []) => {
        return (Array.isArray(history) ? history : [])
            .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
            .map((entry) => ({
                role: entry.role,
                content: String(entry.content || '').trim()
            }))
            .filter((entry) => entry.content)
            .slice(-6);
    };

    const resolveBackendBase = (value = '') => {
        const fallback = globalScope.__HADES_BACKEND_BASE__ || 'http://127.0.0.1:3001';
        return String(value || fallback).replace(/\/+$/, '');
    };

    const requestChatReply = async ({ apiKey, userText, model, timeoutMs, history = [], backendBase = '' }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const historyMessages = buildHistoryMessages(history);
        try {
            const payload = {
                model,
                messages: [
                    {
                        role: 'system',
                        content:
                            'Kısa, net ve doğal Türkçe cevap ver. Gereksiz özür veya anlamadım kalıbı kullanma.'
                    },
                    ...historyMessages,
                    { role: 'user', content: userText }
                ],
                max_completion_tokens: 280
            };

            const normalizedBackendBase = resolveBackendBase(backendBase);
            if (normalizedBackendBase) {
                try {
                    const proxyResponse = await fetch(`${normalizedBackendBase}/openai/chat/completions`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        signal: controller.signal,
                        body: JSON.stringify(payload)
                    });
                    if (proxyResponse.ok) {
                        const proxyData = await proxyResponse.json();
                        const proxyReply = extractReplyFromCompletion(proxyData);
                        if (proxyReply) return proxyReply;
                    }
                } catch (_) {
                    // Backend proxy yoksa veya hataya düştüyse doğrudan API fallback denenir.
                }
            }

            if (!apiKey) return null;

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                signal: controller.signal,
                body: JSON.stringify(payload)
            });
            if (!response.ok) return null;
            const data = await response.json();
            const reply = extractReplyFromCompletion(data);
            return reply || null;
        } catch (_) {
            return null;
        } finally {
            clearTimeout(timeoutId);
        }
    };

    const fetchChatReply = async ({ apiKey, userText, model = DEFAULT_CHAT_MODEL, timeoutMs = 11000, history = [], backendBase = '' }) => {
        const models = [model, ...CHAT_MODEL_FALLBACKS.filter((candidate) => candidate !== model)];
        for (const candidateModel of models) {
            const reply = await requestChatReply({
                apiKey,
                userText,
                model: candidateModel,
                timeoutMs,
                history,
                backendBase
            });
            if (reply) return reply;
        }
        return null;
    };

    const shouldUseWebSearch = (text = '', routeDomain = 'chat') => {
        const normalized = normalizeTr(text);
        if (!normalized) return false;
        if (routeDomain === 'web') return true;
        if (WEB_HINT_REGEX.test(normalized)) return true;
        if (RECENT_HINT_REGEX.test(normalized) && QUESTION_HINT_REGEX.test(normalized)) return true;
        return false;
    };

    const buildLocalFallbackReply = (text = '') => {
        const normalized = normalizeTr(text);

        if (/\b(pratik taraftan basla|pratikten basla)\b/.test(normalized)) {
            return 'Pratikten gidelim: hedefini tek cümle söyle, sana doğrudan uygulanabilir bir yol çıkarayım.';
        }

        if (/\b(teknik taraftan basla|teknikten basla)\b/.test(normalized)) {
            return 'Teknik tarafa geçiyorum: önce durumu netleştirelim, sonra adım adım çözüm çıkaralım.';
        }

        if (/\b(gerizekali|salak|aptal)\b/.test(normalized)) {
            return 'Buradayım. Soruyu tek cümle net söyle, doğrudan cevabı vereyim.';
        }

        if (QUESTION_HINT_REGEX.test(normalized)) {
            return 'Bu soruyu yanıtlayabilirim. İstersen odak noktasını bir tık daralt, daha net ve kısa cevap vereyim.';
        }

        return 'Anladım. Devam et, net bir şekilde yardımcı olayım.';
    };

    const handleInfoRoute = async (params = {}) => {
        const {
            route = { domain: 'chat' },
            text = '',
            apiKey = '',
            backendBase = 'http://127.0.0.1:3001',
            history = [],
            memoryHint = ''
        } = params;

        if (route.domain === 'finance' && globalScope.HADESFinanceSkill) {
            return globalScope.HADESFinanceSkill.answerFinanceQuery(text, { backendBase });
        }

        if (route.domain === 'weather' && globalScope.HADESWeatherSkill) {
            return globalScope.HADESWeatherSkill.answerWeatherQuery(text, { autoOpen: true });
        }

        if (route.domain === 'news' && globalScope.HADESNewsSkill) {
            return globalScope.HADESNewsSkill.answerNewsQuery(text, { autoOpen: true });
        }

        if (shouldUseWebSearch(text, route.domain) && globalScope.HADESWebSkill) {
            return globalScope.HADESWebSkill.searchWeb(text, { autoOpen: false, backendBase });
        }

        const contextualText = memoryHint
            ? `${String(memoryHint).trim()}\n\nKullanıcı sorusu: ${text}`
            : text;
        const chatReply = await fetchChatReply({
            apiKey,
            userText: contextualText,
            history,
            backendBase
        });
        if (chatReply) {
            return { ok: true, reply: chatReply, mode: 'chat' };
        }

        if (QUESTION_HINT_REGEX.test(normalizeTr(text)) && globalScope.HADESWebSkill) {
            return globalScope.HADESWebSkill.searchWeb(text, { autoOpen: false, backendBase });
        }

        return {
            ok: true,
            reply: buildLocalFallbackReply(text),
            mode: 'chat'
        };
    };

    return Object.freeze({
        handleInfoRoute
    });
});
