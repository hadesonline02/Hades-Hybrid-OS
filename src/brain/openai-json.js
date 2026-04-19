(function initHadesOpenAIJson(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESOpenAIJson = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createOpenAiJsonModule() {
    'use strict';

    const randomId = () =>
        `req_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

    const requestWithTimeout = async (url, options, timeoutMs) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    };

    const extractRawContent = (data) => {
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

    const buildActionPlannerPrompt = () =>
        [
            'Sen yalnızca ACTION_PLAN JSON üreten planner modusun.',
            'Sadece JSON dön, açıklama metni yazma.',
            'JSON şeması:',
            '{"input":"string","steps":[{"type":"string"}],"assumptions":[],"risk":"low|medium|high","confidence":0.0}',
            'Boş steps yasak. Belirsizlikte makul varsayım ekle ve tek plan döndür.'
        ].join('\n');

    const requestActionPlanWithRetry = async (config = {}) => {
        const {
            apiKey,
            model = 'gpt-4o',
            inputText = '',
            timeoutMs = 12000,
            logFn = () => {},
            validateFn = null
        } = config;

        const attemptPlan = [
            { maxTokens: 220, temperature: 0.1 },
            { maxTokens: 420, temperature: 0.1 }
        ];

        for (let i = 0; i < attemptPlan.length; i++) {
            const attempt = attemptPlan[i];
            const requestId = randomId();
            const startedAt = Date.now();

            try {
                const response = await requestWithTimeout(
                    'https://api.openai.com/v1/chat/completions',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        },
                        body: JSON.stringify({
                            model,
                            temperature: attempt.temperature,
                            response_format: { type: 'json_object' },
                            messages: [
                                { role: 'system', content: buildActionPlannerPrompt() },
                                { role: 'user', content: inputText }
                            ],
                            max_completion_tokens: attempt.maxTokens
                        })
                    },
                    timeoutMs
                );

                const latencyMs = Date.now() - startedAt;
                if (!response.ok) {
                    logFn({
                        request_id: requestId,
                        latency_ms: latencyMs,
                        raw_length: 0,
                        parse_result: 'fail',
                        http_status: response.status,
                        attempt: i + 1
                    });
                    continue;
                }

                const data = await response.json();
                const rawContent = extractRawContent(data);
                const rawLength = rawContent.length;
                let parsed = null;
                let parseResult = 'fail';

                try {
                    parsed = JSON.parse(rawContent);
                    if (validateFn) {
                        const validation = validateFn(parsed);
                        parseResult = validation.ok ? 'ok' : 'fail';
                    } else {
                        parseResult = 'ok';
                    }
                } catch (_) {
                    parseResult = 'fail';
                }

                logFn({
                    request_id: requestId,
                    latency_ms: latencyMs,
                    raw_length: rawLength,
                    parse_result: parseResult,
                    attempt: i + 1
                });

                if (parseResult === 'ok') {
                    return {
                        ok: true,
                        data: parsed,
                        meta: { request_id: requestId, latency_ms: latencyMs, raw_length: rawLength }
                    };
                }
            } catch (error) {
                const latencyMs = Date.now() - startedAt;
                logFn({
                    request_id: requestId,
                    latency_ms: latencyMs,
                    raw_length: 0,
                    parse_result: 'fail',
                    error: error.message,
                    attempt: i + 1
                });
            }
        }

        return { ok: false, data: null, meta: null };
    };

    return Object.freeze({
        requestActionPlanWithRetry
    });
});
