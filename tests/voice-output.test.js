const {
    extractStreamingChunks,
    normalizeSpeechText,
    shouldRefreshWakeSession
} = require('../app/chatgpt-bridge-extension/voice-output-shared');

describe('voice output helpers', () => {
    test('normalizeSpeechText drops command-like lines and bridge payloads', () => {
        const text = [
            'npm install ws',
            '{"actions":[{"tool":"lights_on"}]}',
            'Merhaba babacigim.',
            'const value = 1;'
        ].join('\n');

        expect(normalizeSpeechText(text)).toBe('Merhaba babacigim.');
    });

    test('extractStreamingChunks releases a full sentence immediately', () => {
        const result = extractStreamingChunks('Ilk cumle. Ikinci cumle devam ediyor');

        expect(result.chunks).toEqual(['Ilk cumle.']);
        expect(result.consumed).toBeGreaterThan(0);
    });

    test('extractStreamingChunks can release an early chunk after a short wait', () => {
        const result = extractStreamingChunks(
            'Bu cevap hala yaziliyor ama yeterince uzadigi icin biraz erken okunabilir',
            {
                pendingSinceMs: 1000,
                nowMs: 2000,
                waitMs: 650,
                minChars: 36,
                softChars: 56,
                maxChars: 96
            }
        );

        expect(result.chunks).toHaveLength(1);
        expect(result.consumed).toBeGreaterThanOrEqual(36);
    });

    test('shouldRefreshWakeSession ignores unset timestamps', () => {
        expect(shouldRefreshWakeSession({
            enabled: true,
            kind: 'native-bridge',
            startedAtMs: 0,
            lastPulseAtMs: 0,
            nowMs: 50000
        })).toEqual({ refresh: false, reason: '' });
    });

    test('shouldRefreshWakeSession requests refresh for stale pulse or long uptime', () => {
        expect(shouldRefreshWakeSession({
            enabled: true,
            kind: 'native-bridge',
            startedAtMs: 1000,
            lastPulseAtMs: 1000,
            nowMs: 25000,
            healthTimeoutMs: 18000,
            softRefreshMs: 150000
        })).toEqual({ refresh: true, reason: 'pulse_timeout' });

        expect(shouldRefreshWakeSession({
            enabled: true,
            kind: 'page-bridge',
            startedAtMs: 1000,
            lastPulseAtMs: 200000,
            nowMs: 200500,
            healthTimeoutMs: 18000,
            softRefreshMs: 150000
        })).toEqual({ refresh: true, reason: 'soft_refresh' });
    });

    test('shouldRefreshWakeSession skips soft refresh when disabled', () => {
        expect(shouldRefreshWakeSession({
            enabled: true,
            kind: 'native-bridge',
            startedAtMs: 1000,
            lastPulseAtMs: 190000,
            nowMs: 200500,
            healthTimeoutMs: 18000,
            softRefreshMs: 0
        })).toEqual({ refresh: false, reason: '' });
    });
});
