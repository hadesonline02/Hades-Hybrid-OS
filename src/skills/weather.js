(function initHadesWeatherSkill(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESWeatherSkill = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWeatherSkillModule() {
    'use strict';

    const buildWeatherSearchUrl = (queryText = '') => {
        const query = queryText && queryText.trim() ? queryText : 'istanbul hava durumu';
        return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    };

    const answerWeatherQuery = async (queryText = '', options = {}) => {
        const targetUrl = buildWeatherSearchUrl(queryText);
        if (options.autoOpen && typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(targetUrl, '_blank');
        }
        return {
            ok: true,
            reply: 'Hava durumunu şimdi açıyorum, detayları birlikte görebilirsin.',
            url: targetUrl
        };
    };

    return Object.freeze({
        buildWeatherSearchUrl,
        answerWeatherQuery
    });
});
