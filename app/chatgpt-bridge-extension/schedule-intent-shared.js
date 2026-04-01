(function(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.HADESScheduleIntent = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    const RAW_TIME_REGEX = /\b([01]?\d|2[0-3]):([0-5]\d)\b/i;
    const RAW_RELATIVE_TIME_REGEX = /\b((?:\d+|bir|iki|uc|üç|dort|dört|bes|beş|alti|altı|yedi|sekiz|dokuz|on|on bir|onbir|on iki|oniki|on bes|on beş|yirmi|otuz|kirk|kırk|elli|altmis|altmış)\s*(?:dakika|dk|min|minute|minutes|saat|hour|hours)(?:\s+sonra(?:sina|sına|ya|ye)?)?)\b/iu;

    function normalizeText(value = '') {
        return String(value || '')
            .toLocaleLowerCase('tr-TR')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\u0131/g, 'i')
            .replace(/[^\w\s:]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function cleanupSpaces(value = '') {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function includesAny(text = '', patterns = []) {
        return patterns.some((pattern) => pattern.test(text));
    }

    function extractTime(rawText = '', normalizedText = '') {
        const rawTime = String(rawText || '').match(RAW_TIME_REGEX);
        if (rawTime) {
            return rawTime[0];
        }

        const rawRelative = String(rawText || '').match(RAW_RELATIVE_TIME_REGEX);
        if (rawRelative) {
            return cleanupSpaces(rawRelative[0]);
        }

        const normalizedRelative = String(normalizedText || '').match(/\b((?:\d+|bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|on bir|onbir|on iki|oniki|on bes|yirmi|otuz|kirk|elli|altmis)\s*(?:dakika|dk|min|minute|minutes|saat|hour|hours)(?:\s+sonra(?:sina|ya|ye)?)?)\b/i);
        return normalizedRelative ? cleanupSpaces(normalizedRelative[0]) : '';
    }

    function cleanupReminderMessage(rawText = '', timeText = '') {
        let message = String(rawText || '');
        if (timeText) {
            message = message.replace(new RegExp(timeText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'), ' ');
        }

        message = message
            .replace(/\b(?:bana|beni|beni̇|için|icin|lütfen|lutfen|bir|bi)\b/giu, ' ')
            .replace(/\b(?:alarm|alarmi|alarmı|alarmi|alarmlar|hatirlat|hatırlat|hatirlatici|hatırlatıcı|hatirlatma|hatırlatma|kur|kuralim|kuralım|kurar misin|kurar mısın|ekle|ayarla|olustur|oluştur|sil|kaldir|kaldır|iptal|aktif|kayitli|kayıtlı|var mi|var mı|goster|göster)\b/giu, ' ')
            .replace(/[?!.:,;]+/g, ' ');

        return cleanupSpaces(message);
    }

    function extractLocalScheduleIntent(text = '') {
        const raw = cleanupSpaces(text);
        const normalized = normalizeText(raw);
        if (!normalized) return null;

        const words = normalized.split(' ').filter(Boolean);
        const hasAlarm = words.some((word) => word.startsWith('alarm'));
        const hasReminder = words.some((word) => word.startsWith('hatirlat'));
        if (!hasAlarm && !hasReminder) return null;

        const kind = hasReminder ? 'reminder' : 'alarm';
        const time = extractTime(raw, normalized);
        const wantsDeleteAll = includesAny(normalized, [
            /\b(hepsini|tumunu|tamamini|butununu)\b/,
            /\btum\b/
        ]) && includesAny(normalized, [
            /\b(sil|kaldir|iptal)\b/
        ]);
        const wantsDelete = includesAny(normalized, [
            /\b(sil|kaldir|iptal)\b/
        ]);
        const wantsList = includesAny(normalized, [
            /\b(aktif|kayitli|kurulu|liste|goster|neler)\b/,
            /\bvar mi\b/,
            /\bvarm[iı]\b/
        ]);
        const wantsSet = Boolean(time) && includesAny(normalized, [
            /\b(kur|ekle|ayarla|olustur|baslat|başlat|tanimla|tanımla)\b/,
            /\b(hatirlat|hatirlatici|hatirlatma)\b/,
            /\balarm\b/
        ]);

        if (wantsDeleteAll) {
            return {
                tool: `${kind}.delete_all`,
                args: {}
            };
        }

        if (wantsList && !time) {
            return {
                tool: `${kind}.list`,
                args: {}
            };
        }

        if (wantsDelete && time) {
            return {
                tool: `${kind}.delete`,
                args: {
                    time
                }
            };
        }

        if (wantsSet && time) {
            const args = { time };
            if (kind === 'reminder') {
                const message = cleanupReminderMessage(raw, time);
                if (!message) return null;
                args.message = message;
            }

            return {
                tool: `${kind}.set`,
                args
            };
        }

        return null;
    }

    return {
        normalizeText,
        extractLocalScheduleIntent
    };
}));
