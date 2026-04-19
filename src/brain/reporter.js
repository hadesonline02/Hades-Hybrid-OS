(function initHadesReporter(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESReporter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createReporterModule() {
    'use strict';

    const buildExecutionReport = (summary = {}) => {
        const success = Boolean(summary.success);
        const stepCount = Number.isFinite(summary.stepCount) ? summary.stepCount : 0;
        const successCount = Number.isFinite(summary.successCount) ? summary.successCount : 0;
        const assumptions = Array.isArray(summary.assumptions) ? summary.assumptions.filter(Boolean) : [];

        if (success) {
            const baseSentence = stepCount > 1
                ? `Toplam ${successCount || stepCount}/${stepCount} adimi uyguladim.`
                : 'Komutu uyguladim.';

            if (assumptions.length > 0) {
                return `${baseSentence} ${assumptions[0]} Farkliysa soyle, hemen duzelteyim.`;
            }

            return baseSentence;
        }

        if (assumptions.length > 0) {
            return `Islemi denedim ama sonuc alamadim. ${assumptions[0]}`;
        }

        return 'Islemi denedim ama sonuc alamadim, hemen alternatif bir yol deneyebilirim.';
    };

    return Object.freeze({
        buildExecutionReport
    });
});
