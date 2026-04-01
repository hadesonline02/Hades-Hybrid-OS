(function initHadesActionMemory(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESActionMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createActionMemoryModule() {
    'use strict';

    const normalizeTr = (text = '') => String(text)
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/\s+/g, ' ')
        .trim();

    const TR_HOUR_WORDS = Object.freeze({
        sifir: 0,
        bir: 1,
        iki: 2,
        uc: 3,
        dort: 4,
        bes: 5,
        alti: 6,
        yedi: 7,
        sekiz: 8,
        dokuz: 9,
        on: 10,
        onbir: 11,
        oniki: 12
    });

    const hourFromText = (normalizedText) => {
        const numericMatch = normalizedText.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\b/);
        if (numericMatch) {
            return String(parseInt(numericMatch[1], 10)).padStart(2, '0');
        }

        for (const [word, value] of Object.entries(TR_HOUR_WORDS)) {
            if (normalizedText.includes(`${word}a`) || normalizedText.includes(`${word}e`) || normalizedText.includes(word)) {
                return String(value).padStart(2, '0');
            }
        }

        return null;
    };

    class ActionMemoryRingBuffer {
        constructor(limit = 50) {
            this.limit = Math.max(1, parseInt(limit, 10) || 50);
            this.items = [];
        }

        push(entry) {
            if (!entry || typeof entry !== 'object') return;
            const safeEntry = {
                timestamp: entry.timestamp || new Date().toISOString(),
                domain: entry.domain || 'unknown',
                intent: entry.intent || 'unknown',
                params: entry.params && typeof entry.params === 'object' ? { ...entry.params } : {},
                result: entry.result || '',
                success: Boolean(entry.success)
            };
            this.items.push(safeEntry);
            if (this.items.length > this.limit) {
                this.items.splice(0, this.items.length - this.limit);
            }
        }

        list() {
            return [...this.items];
        }

        resolvePronounCommand(rawCommand = '') {
            const normalized = normalizeTr(rawCommand);
            if (!normalized) {
                return { matched: false, entry: null, reason: 'bos_komut' };
            }

            const hasPronoun = /\b(onu|bunu|sunu|su|var ya)\b/.test(normalized);
            if (!hasPronoun) {
                return { matched: false, entry: null, reason: 'zamir_yok' };
            }

            const hourPrefix = hourFromText(normalized);
            const reversed = [...this.items].reverse();

            if (hourPrefix) {
                const matchByHour = reversed.find((item) => {
                    const alarmTime = String(item?.params?.time || '');
                    return item.domain === 'alarm' && alarmTime.startsWith(hourPrefix);
                });
                if (matchByHour) {
                    return { matched: true, entry: matchByHour, reason: 'saat_eslesmesi' };
                }
            }

            const latestSuccessfulAction = reversed.find((item) => item.success);
            if (latestSuccessfulAction) {
                return { matched: true, entry: latestSuccessfulAction, reason: 'son_basarili_eylem' };
            }

            return { matched: false, entry: null, reason: 'eslesme_yok' };
        }
    }

    return Object.freeze({
        ActionMemoryRingBuffer,
        normalizeTr
    });
});
