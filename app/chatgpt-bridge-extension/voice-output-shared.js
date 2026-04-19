(function initHadesVoiceOutput(globalScope, factory) {
    const api = factory();
    globalScope.HADESVoiceOutput = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const normalizeTr = (text = '') => String(text || '')
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const stripEmoji = (text = '') => String(text || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu, ' ');

    const collapseRepeat = (text = '') => {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (!clean) return '';
        const words = clean.split(' ');
        if (words.length >= 4 && words.length % 2 === 0) {
            const half = words.length / 2;
            const left = words.slice(0, half).join(' ');
            const right = words.slice(half).join(' ');
            if (normalizeTr(left) === normalizeTr(right)) return left;
        }
        return clean;
    };

    const balanced = (text = '', start = 0) => {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char === '\\') {
                    escaped = true;
                    continue;
                }
                if (char === '"') {
                    inString = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{') {
                depth += 1;
                continue;
            }
            if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    return text.slice(start, index + 1);
                }
            }
        }

        return '';
    };

    const shouldDropSpeechLine = (line = '') => {
        const trimmed = String(line || '').trim();
        if (!trimmed) return false;
        if (/^HADES_(?:TOOL_RESULT|RUNTIME_STATUS|LOCAL_EXECUTION)/i.test(trimmed)) return true;
        if (/^HADES_BRIDGE_PROFILE_V\d+/i.test(trimmed)) return true;
        if (/^\s*(?:[$>#]|PS [A-Z]:\\|npm\b|pnpm\b|yarn\b|bun\b|npx\b|git\b|node\b|python\b|py\b|pip\b|curl\b|wget\b|powershell\b|cmd(?:\.exe)?\b)/i.test(trimmed)) return true;
        if (/^\s*(?:const|let|var|function|class|if\s*\(|for\s*\(|while\s*\(|return\b|import\b|export\b|await\b|async\b)/i.test(trimmed)) return true;
        if (/"(?:actions|tool|args|command|stdout|stderr|exitCode|status)"\s*:/i.test(trimmed)) return true;

        const symbolCount = (trimmed.match(/[{}[\]<>$`\\/=|;]/g) || []).length;
        if (symbolCount >= 6 && /(=>|::|===|https?:\/\/|[A-Z]:\\|\/[A-Za-z0-9_.-]+)/.test(trimmed)) {
            return true;
        }

        return false;
    };

    const stripSpeechPayloads = (text = '') => {
        let output = String(text || '');
        output = output.replace(/```(?:hades-bridge|json)?[\s\S]*?```/gi, ' ');

        while (output.includes('"actions"')) {
            const actionIndex = output.indexOf('"actions"');
            const objectStart = output.lastIndexOf('{', actionIndex);
            if (objectStart < 0) break;
            const chunk = balanced(output, objectStart);
            if (!chunk) break;
            output = `${output.slice(0, objectStart)} ${output.slice(objectStart + chunk.length)}`;
        }

        return output
            .split(/\r?\n/)
            .map((line) => (shouldDropSpeechLine(line) ? ' ' : line))
            .join('\n');
    };

    const normalizeSpeechText = (text = '') => collapseRepeat(
        stripEmoji(
            stripSpeechPayloads(String(text || ''))
                .replace(/HADES_TOOL_RESULT[\s\S]*$/gi, ' ')
                .replace(/HADES_RUNTIME_STATUS[\s\S]*$/gi, ' ')
                .replace(/HADES_LOCAL_EXECUTION[\s\S]*$/gi, ' ')
                .replace(/HADES_BRIDGE_PROFILE_V\d+/gi, ' ')
        )
    ).replace(/\s+/g, ' ').trim();

    const extractSentenceChunks = (text = '') => {
        const chunks = [];
        const regex = /[^.!?…\n]+(?:[.!?…]+|\n)\s*/g;
        let match;
        let consumed = 0;

        while ((match = regex.exec(text)) !== null) {
            chunks.push(match[0].trim());
            consumed = regex.lastIndex;
        }

        return {
            chunks: chunks.filter(Boolean),
            consumed
        };
    };

    const pickFallbackCutIndex = (text = '', minChars = 36, maxChars = 96) => {
        const limit = Math.min(Math.max(minChars, maxChars), text.length);
        const segment = text.slice(0, limit);
        let cutIndex = 0;
        const punctuationRegex = /[,:;)\]]\s+/g;
        let match;

        while ((match = punctuationRegex.exec(segment)) !== null) {
            cutIndex = match.index + match[0].length;
        }

        if (cutIndex >= minChars) return cutIndex;

        const lastSpace = segment.lastIndexOf(' ');
        if (lastSpace >= minChars) return lastSpace;
        if (text.length >= minChars && text.length <= maxChars) return text.length;
        return 0;
    };

    const extractStreamingChunks = (text = '', options = {}) => {
        const raw = String(text || '');
        const leadingWhitespaceLength = (raw.match(/^\s*/) || [''])[0].length;
        const trimmed = raw.slice(leadingWhitespaceLength);
        const sentenceResult = extractSentenceChunks(trimmed);
        if (sentenceResult.chunks.length) {
            return {
                chunks: sentenceResult.chunks,
                consumed: leadingWhitespaceLength + sentenceResult.consumed
            };
        }

        const minChars = Math.max(16, Number(options.minChars) || 36);
        const softChars = Math.max(minChars, Number(options.softChars) || 56);
        const maxChars = Math.max(softChars, Number(options.maxChars) || 96);
        const waitMs = Math.max(120, Number(options.waitMs) || 650);
        const pendingSinceMs = Number(options.pendingSinceMs);
        const nowMs = Number(options.nowMs);
        const elapsedMs = Number.isFinite(pendingSinceMs) && Number.isFinite(nowMs)
            ? Math.max(0, nowMs - pendingSinceMs)
            : Number.POSITIVE_INFINITY;

        if (!trimmed || trimmed.length < minChars) {
            return { chunks: [], consumed: 0 };
        }

        if (trimmed.length < softChars && elapsedMs < waitMs) {
            return { chunks: [], consumed: 0 };
        }

        const cutIndex = pickFallbackCutIndex(trimmed, minChars, maxChars);
        if (!cutIndex) {
            return { chunks: [], consumed: 0 };
        }

        return {
            chunks: [trimmed.slice(0, cutIndex).trim()].filter(Boolean),
            consumed: leadingWhitespaceLength + cutIndex
        };
    };

    const shouldRefreshWakeSession = (payload = {}) => {
        const kind = String(payload.kind || '').trim();
        if (!['native-bridge', 'page-bridge'].includes(kind)) {
            return { refresh: false, reason: '' };
        }

        if (!payload.enabled || payload.speaking || payload.hasCommand || payload.hasReply) {
            return { refresh: false, reason: '' };
        }

        const nowMs = Number(payload.nowMs);
        const lastPulseAtMs = Number(payload.lastPulseAtMs);
        const startedAtMs = Number(payload.startedAtMs);
        const healthTimeoutMs = Math.max(5000, Number(payload.healthTimeoutMs) || 18000);
        const softRefreshMs = Math.max(0, Number(payload.softRefreshMs) || 0);

        if (lastPulseAtMs > 0 && Number.isFinite(nowMs) && nowMs - lastPulseAtMs > healthTimeoutMs) {
            return { refresh: true, reason: 'pulse_timeout' };
        }

        if (softRefreshMs > 0 && startedAtMs > 0 && Number.isFinite(nowMs) && nowMs - startedAtMs > softRefreshMs) {
            return { refresh: true, reason: 'soft_refresh' };
        }

        return { refresh: false, reason: '' };
    };

    return Object.freeze({
        extractStreamingChunks,
        normalizeSpeechText,
        shouldRefreshWakeSession,
        stripSpeechPayloads
    });
});
