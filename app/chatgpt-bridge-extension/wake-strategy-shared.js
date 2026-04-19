(function initHadesWakeStrategy(globalScope, factory) {
    const api = factory();
    globalScope.HADESWakeStrategy = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const clampTime = (value = 0) => Math.max(0, Number(value) || 0);

    const registerWakeFailure = (payload = {}) => {
        const nowMs = clampTime(payload.nowMs || Date.now());
        const cooldownMs = Math.max(1000, Number(payload.cooldownMs) || 180000);
        const windowMs = Math.max(1000, Number(payload.windowMs) || 45000);
        const threshold = Math.max(1, Number(payload.threshold) || 2);
        const existingHistory = Array.isArray(payload.history) ? payload.history : [];
        const history = existingHistory
            .map((value) => clampTime(value))
            .filter((value) => value > 0 && (nowMs - value) <= windowMs);

        history.push(nowMs);

        if (history.length >= threshold) {
            return {
                history: [],
                cooldownUntilMs: nowMs + cooldownMs,
                tripped: true
            };
        }

        return {
            history,
            cooldownUntilMs: clampTime(payload.cooldownUntilMs),
            tripped: false
        };
    };

    const clearWakeFailures = () => ({
        history: [],
        cooldownUntilMs: 0
    });

    const isWakeEngineCoolingDown = (payload = {}) => {
        const nowMs = clampTime(payload.nowMs || Date.now());
        const cooldownUntilMs = clampTime(payload.cooldownUntilMs);
        return cooldownUntilMs > nowMs;
    };

    const pickWakeEngine = (payload = {}) => {
        const preferNative = !!payload.preferNative;
        const preferPage = !!payload.preferPage;
        const deepgramAvailable = !!payload.deepgramAvailable;
        const nativeCoolingDown = !!payload.nativeCoolingDown;
        const pageCoolingDown = !!payload.pageCoolingDown;

        if (preferNative && !nativeCoolingDown) return 'native';
        if (preferPage && !pageCoolingDown) return 'page';
        if (deepgramAvailable) return 'deepgram';
        if (preferNative) return 'native';
        if (preferPage) return 'page';
        return '';
    };

    return Object.freeze({
        clearWakeFailures,
        isWakeEngineCoolingDown,
        pickWakeEngine,
        registerWakeFailure
    });
});
