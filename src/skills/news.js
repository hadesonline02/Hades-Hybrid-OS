(function initHadesNewsSkill(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESNewsSkill = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createNewsSkillModule() {
    'use strict';

    const buildNewsSearchUrl = (queryText = '') => {
        const query = queryText && queryText.trim() ? queryText : 'son dakika haberler';
        return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    };

    const answerNewsQuery = async (queryText = '', options = {}) => {
        const targetUrl = buildNewsSearchUrl(queryText);
        if (options.autoOpen && typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(targetUrl, '_blank');
        }
        return {
            ok: true,
            reply: 'Güncel haberleri açıyorum, önemli başlıkları görebilirsin.',
            url: targetUrl
        };
    };

    return Object.freeze({
        buildNewsSearchUrl,
        answerNewsQuery
    });
});
