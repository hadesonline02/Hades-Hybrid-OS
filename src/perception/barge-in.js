(function initHadesPerception(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESPerception = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPerceptionModule() {
    'use strict';

    const canTriggerWakeWord = (state = {}) => {
        const isSpeaking = Boolean(state.isSpeaking);
        const now = Number.isFinite(state.nowMs) ? state.nowMs : Date.now();
        const lastSpeechEndMs = Number.isFinite(state.lastSpeechEndMs) ? state.lastSpeechEndMs : 0;
        const cooldownMs = Number.isFinite(state.cooldownMs) ? state.cooldownMs : 900;
        if (isSpeaking) return false;
        return (now - lastSpeechEndMs) >= cooldownMs;
    };

    return Object.freeze({
        canTriggerWakeWord
    });
});
