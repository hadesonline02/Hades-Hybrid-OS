const {
    clearWakeFailures,
    isWakeEngineCoolingDown,
    pickWakeEngine,
    registerWakeFailure
} = require('../app/chatgpt-bridge-extension/wake-strategy-shared');

describe('wake strategy helpers', () => {
    test('registerWakeFailure trips cooldown after repeated recent failures', () => {
        const first = registerWakeFailure({
            nowMs: 1000,
            history: [],
            windowMs: 45000,
            threshold: 2,
            cooldownMs: 180000
        });

        expect(first).toEqual({
            history: [1000],
            cooldownUntilMs: 0,
            tripped: false
        });

        const second = registerWakeFailure({
            nowMs: 2000,
            history: first.history,
            windowMs: 45000,
            threshold: 2,
            cooldownMs: 180000
        });

        expect(second).toEqual({
            history: [],
            cooldownUntilMs: 182000,
            tripped: true
        });
    });

    test('registerWakeFailure ignores old failures outside the active window', () => {
        const result = registerWakeFailure({
            nowMs: 50000,
            history: [1000],
            windowMs: 45000,
            threshold: 2,
            cooldownMs: 180000
        });

        expect(result).toEqual({
            history: [50000],
            cooldownUntilMs: 0,
            tripped: false
        });
    });

    test('pickWakeEngine falls back to deepgram while other engines cool down', () => {
        expect(pickWakeEngine({
            preferNative: true,
            preferPage: true,
            deepgramAvailable: true,
            nativeCoolingDown: true,
            pageCoolingDown: true
        })).toBe('deepgram');
    });

    test('cooldown helpers reset and report engine availability', () => {
        expect(isWakeEngineCoolingDown({ nowMs: 1000, cooldownUntilMs: 1500 })).toBe(true);
        expect(isWakeEngineCoolingDown({ nowMs: 1600, cooldownUntilMs: 1500 })).toBe(false);
        expect(clearWakeFailures()).toEqual({ history: [], cooldownUntilMs: 0 });
    });
});
