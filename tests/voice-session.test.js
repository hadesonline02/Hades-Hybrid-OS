const {
    normalizeSessionKey,
    shouldSuppressDuplicateSubmission
} = require('../app/chatgpt-bridge-extension/voice-session-shared');

describe('voice session helpers', () => {
    test('same session duplicate is suppressed for a short window', () => {
        expect(shouldSuppressDuplicateSubmission({
            submitSig: '10:123',
            sessionKey: 'cmd:4',
            lastSubmitSig: '10:123',
            lastSubmitSessionKey: 'cmd:4',
            lastSubmitAtMs: 1000,
            nowMs: 2200,
            windowMs: 1600
        })).toBe(true);
    });

    test('same text in a new session is allowed', () => {
        expect(shouldSuppressDuplicateSubmission({
            submitSig: '10:123',
            sessionKey: 'cmd:5',
            lastSubmitSig: '10:123',
            lastSubmitSessionKey: 'cmd:4',
            lastSubmitAtMs: 1000,
            nowMs: 2200,
            windowMs: 1600
        })).toBe(false);
    });

    test('duplicate window expires quickly', () => {
        expect(shouldSuppressDuplicateSubmission({
            submitSig: '10:123',
            sessionKey: 'cmd:4',
            lastSubmitSig: '10:123',
            lastSubmitSessionKey: 'cmd:4',
            lastSubmitAtMs: 1000,
            nowMs: 5000,
            windowMs: 1600
        })).toBe(false);
    });

    test('normalize session key falls back to default', () => {
        expect(normalizeSessionKey('')).toBe('default');
        expect(normalizeSessionKey(' wake:12 ')).toBe('wake:12');
    });
});
