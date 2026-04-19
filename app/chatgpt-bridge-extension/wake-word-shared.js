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
        'heydis',
        'heydiz',
        'hedis',
        'hediz',
        'hedez',
        'hadesi',
        'hadesin',
        'hadesim',
        'hadese',
        'hadezi',
        'hadezin',
        'hadezim',
        'hadesya',
        'hedesi',
        'hedesin',
        'hedesim',
        'hedezi',
        'hedezin',
        'hedezim',
        'adesi',
        'adesin',
        'adesim',
        'adezi',
        'adezin',
        'adezim'
    ]);

    const WAKE_PREFIXES = [
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
        'heydis',
        'heydiz',
        'hedis',
        'hediz',
        'hedez'
    ];

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

    const boundedEditDistance = (left = '', right = '', limit = 1) => {
        const a = String(left || '');
        const b = String(right || '');
        if (a === b) return 0;
        if (!a || !b) return Math.max(a.length, b.length);
        if (Math.abs(a.length - b.length) > limit) return limit + 1;

        let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
        for (let i = 1; i <= a.length; i += 1) {
            const current = [i];
            let minInRow = current[0];
            for (let j = 1; j <= b.length; j += 1) {
                const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
                const value = Math.min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + substitutionCost
                );
                current.push(value);
                if (value < minInRow) minInRow = value;
            }
            if (minInRow > limit) return limit + 1;
            previous = current;
        }

        return previous[b.length];
    };

    const wakeShapeScore = (collapsed = '') => {
        let score = 0;
        if (collapsed.includes('h')) score += 1;
        if (collapsed.includes('a')) score += 1;
        if (collapsed.includes('d')) score += 1;
        if (collapsed.includes('e')) score += 1;
        if (collapsed.includes('s')) score += 1;
        return score;
    };

    const nearWakeFormMatch = (collapsed = '') => {
        if (!collapsed) return false;
        if (!['h', 'a'].includes(collapsed[0])) return false;
        if (wakeShapeScore(collapsed) < 4) return false;

        for (const form of EXACT_WAKE_FORMS) {
            if (Math.abs(form.length - collapsed.length) > 1) continue;
            if (boundedEditDistance(collapsed, form, 1) <= 1) {
                return true;
            }
        }

        return false;
    };

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
        if (WAKE_PREFIXES.some((prefix) => collapsed.startsWith(prefix))) {
            return true;
        }
        if (nearWakeFormMatch(collapsed)) return true;

        if (collapsed.length < 3 || collapsed.length > 8) return false;

        return wakeShapeScore(collapsed) >= 4;
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
