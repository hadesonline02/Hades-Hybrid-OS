(function initHadesWakeWord(globalScope, factory) {
    const api = factory();
    globalScope.HADESWakeWord = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const EXACT_WAKE_FORMS = new Set([
        'hades',
        'hedes',
        'ades',
        'hds',
        'hadez',
        'adez',
        'hadis',
        'hadiz',
        'haydes',
        'heydes',
        'hadesi',
        'hadesin',
        'hadesim',
        'hadese',
        'hadesya',
        'hedesi',
        'hedesin',
        'hedesim',
        'adesi',
        'adesin',
        'adesim'
    ]);

    const WAKE_FILLERS = new Set([
        'ya',
        'abi',
        'be',
        'lan',
        'hey',
        'lutfen',
        'kanka'
    ]);

    const norm = (text = '') => String(text || '')
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const cleanTokenEdges = (token = '') => String(token || '')
        .replace(/^[,.:;!?-]+/g, '')
        .replace(/[,.:;!?-]+$/g, '')
        .trim();

    const tokenize = (text = '') => String(text || '')
        .trim()
        .split(/\s+/)
        .map((raw) => {
            const cleanedRaw = cleanTokenEdges(raw);
            return {
                raw: cleanedRaw,
                norm: norm(cleanedRaw)
            };
        })
        .filter((token) => token.raw && token.norm);

    const wakeTokenMatch = (token = '') => {
        const collapsed = norm(token).replace(/\s+/g, '');
        if (!collapsed) return false;
        if (EXACT_WAKE_FORMS.has(collapsed)) return true;
        if (
            collapsed.startsWith('hades') ||
            collapsed.startsWith('hedes') ||
            collapsed.startsWith('ades') ||
            collapsed.startsWith('hds')
        ) {
            return true;
        }

        if (collapsed.length < 3 || collapsed.length > 8) return false;

        let score = 0;
        if (collapsed.includes('h')) score += 1;
        if (collapsed.includes('a')) score += 1;
        if (collapsed.includes('d')) score += 1;
        if (collapsed.includes('e')) score += 1;
        if (collapsed.includes('s')) score += 1;
        return score >= 4;
    };

    const matchWakeTokenCount = (tokens = [], startIndex = 0) => {
        for (let size = 3; size >= 1; size -= 1) {
            if (startIndex + size > tokens.length) continue;

            const joined = tokens
                .slice(startIndex, startIndex + size)
                .map((token) => token.norm)
                .join('');

            if ((size === 1 && wakeTokenMatch(joined)) || (size > 1 && EXACT_WAKE_FORMS.has(joined))) {
                return size;
            }
        }

        return 0;
    };

    const findWakeSpan = (text = '') => {
        const tokens = Array.isArray(text) ? text : tokenize(text);

        for (let index = 0; index < tokens.length; index += 1) {
            const matchedCount = matchWakeTokenCount(tokens, index);
            if (matchedCount) {
                return {
                    tokens,
                    start: index,
                    end: index + matchedCount
                };
            }
        }

        return null;
    };

    const hasWake = (text = '') => Boolean(findWakeSpan(text));

    const extractWakeCommand = (text = '') => {
        const rawText = String(text || '').trim();
        if (!rawText) return '';

        const span = findWakeSpan(rawText);
        if (!span) return '';

        let start = span.end;
        while (start < span.tokens.length && WAKE_FILLERS.has(span.tokens[start].norm)) {
            start += 1;
        }

        const command = span.tokens
            .slice(start)
            .map((token) => token.raw)
            .join(' ')
            .replace(/^[,.:;!?-]+/g, '')
            .trim();

        const normalizedCommand = norm(command);
        if (!normalizedCommand || WAKE_FILLERS.has(normalizedCommand)) {
            return '';
        }

        return command;
    };

    const isWakeOnly = (text = '') => {
        const span = findWakeSpan(text);
        if (!span) return false;

        const remaining = span.tokens
            .filter((_, index) => index < span.start || index >= span.end)
            .map((token) => token.norm)
            .filter(Boolean)
            .filter((token) => !WAKE_FILLERS.has(token));

        return remaining.length === 0;
    };

    const stripWake = (text = '') => {
        const rawText = String(text || '').trim();
        if (!rawText) return '';

        const command = extractWakeCommand(rawText);
        if (command) return command;

        if (hasWake(rawText)) return '';
        return rawText;
    };

    return Object.freeze({
        extractWakeCommand,
        findWakeSpan,
        hasWake,
        isWakeOnly,
        norm,
        stripWake,
        tokenize,
        wakeTokenMatch
    });
});
