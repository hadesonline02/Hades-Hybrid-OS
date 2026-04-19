(function initHadesVoiceSession(globalScope, factory) {
    const api = factory();
    globalScope.HADESVoiceSession = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const normalizeSessionKey = (value = '') => {
        const sessionKey = String(value || '').trim();
        return sessionKey || 'default';
    };

    const shouldSuppressDuplicateSubmission = (payload = {}) => {
        const submitSig = String(payload.submitSig || '').trim();
        if (!submitSig) return false;

        const sessionKey = normalizeSessionKey(payload.sessionKey);
        const lastSubmitSig = String(payload.lastSubmitSig || '').trim();
        const lastSubmitSessionKey = normalizeSessionKey(payload.lastSubmitSessionKey);
        const windowMs = Math.max(250, Number(payload.windowMs) || 1500);
        const nowMs = Number(payload.nowMs);
        const lastSubmitAtMs = Number(payload.lastSubmitAtMs);

        if (submitSig !== lastSubmitSig || sessionKey !== lastSubmitSessionKey) {
            return false;
        }

        if (!Number.isFinite(nowMs) || !Number.isFinite(lastSubmitAtMs)) {
            return true;
        }

        const elapsedMs = nowMs - lastSubmitAtMs;
        return elapsedMs >= 0 && elapsedMs <= windowMs;
    };

    return Object.freeze({
        normalizeSessionKey,
        shouldSuppressDuplicateSubmission
    });
});
