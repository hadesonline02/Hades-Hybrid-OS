(function initHadesRouter(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESRouter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRouterModule() {
    'use strict';

    const normalizeTr = (text = '') => String(text)
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/[^\w\s:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const FINANCE_KEYWORDS = ['dolar', 'usd', 'euro', 'eur', 'sterlin', 'gbp', 'kur', 'parite'];
    const WEATHER_KEYWORDS = ['hava', 'hava durumu', 'derece', 'yagmur', 'ruzgar', 'nem', 'sicaklik'];
    const NEWS_KEYWORDS = ['haber', 'gundem', 'son dakika', 'guncel', 'guncem'];
    const WEB_HINT_REGEX = /\b(internette|internetten|webde|google|youtube|yt|arama|ara|bak)\b/;
    const RECENT_INFO_HINT_REGEX = /\b(en son|son video|guncel|bugun|simdi|az once)\b/;
    const WEB_RECHECK_HINT_REGEX = /\b(o degil|dogru degil|yanlis|tekrar bak|tekrar ara|yeniden ara|iyi bak|iyi arastir)\b/;
    const ACTION_TARGET_REGEXES = [
        /\b(isik\w*|isig\w*)\b/,
        /\blamba\w*\b/,
        /\bspotify\b/,
        /\bmuzik\w*\b/,
        /\b(sarki\w*|sarki|parca\w*|parca)\b/,
        /\bplaylist\b/,
        /\balarm\w*\b/,
        /\bhatirlatici\w*\b/,
        /\bzamanlayici\w*\b/
    ];
    const ACTION_VERB_REGEXES = [
        /\b(ac|kapat|yak|sondur|kur|ayarla|cal|baslat|oynat|durdur|duraklat|arttir|azalt)\w*\b/,
        /\b(iptal et|devam et|geri al)\b/
    ];
    const QUESTION_HINT_REGEX =
        /\b(nedir|ne|kim|nerede|ne zaman|nasil|neden|kac|hangi|acikla|anlat|oner|planla|fark|karsilastir)\b/;
    const INFO_INTENT_REGEX = /\b(hakkinda|bilgi|nedir|acikla|anlat)\b/;
    const FINANCE_QUERY_HINT_REGEX = /\b(kac|ne kadar|fiyat|deger|kur|parite)\b/;

    const hasAnyKeyword = (normalized, keywords) => keywords.some((keyword) => normalized.includes(keyword));

    const isFinanceQuery = (normalized) =>
        hasAnyKeyword(normalized, FINANCE_KEYWORDS) && (FINANCE_QUERY_HINT_REGEX.test(normalized) || normalized.length < 28);

    const isWeatherQuery = (normalized) => hasAnyKeyword(normalized, WEATHER_KEYWORDS);
    const isNewsQuery = (normalized) => hasAnyKeyword(normalized, NEWS_KEYWORDS);
    const isWebHintQuery = (normalized) => WEB_HINT_REGEX.test(normalized);
    const isRecentQuestionQuery = (normalized) => RECENT_INFO_HINT_REGEX.test(normalized) && QUESTION_HINT_REGEX.test(normalized);
    const isRecentRecheckQuery = (normalized) => RECENT_INFO_HINT_REGEX.test(normalized) && WEB_RECHECK_HINT_REGEX.test(normalized);
    const hasActionTarget = (normalized) => ACTION_TARGET_REGEXES.some((regex) => regex.test(normalized));
    const hasActionVerb = (normalized) => ACTION_VERB_REGEXES.some((regex) => regex.test(normalized));

    const routeTranscript = (rawText = '') => {
        const normalized = normalizeTr(rawText);
        if (!normalized) {
            return { mode: 'info', domain: 'chat', reason: 'bos_metin' };
        }

        if (isFinanceQuery(normalized)) {
            return { mode: 'info', domain: 'finance', reason: 'finance_anahtar_kelime' };
        }
        if (isWeatherQuery(normalized)) {
            return { mode: 'info', domain: 'weather', reason: 'weather_anahtar_kelime' };
        }
        if (isNewsQuery(normalized)) {
            return { mode: 'info', domain: 'news', reason: 'news_anahtar_kelime' };
        }
        if (isWebHintQuery(normalized)) {
            return { mode: 'info', domain: 'web', reason: 'acik_web_istegi' };
        }
        if (isRecentQuestionQuery(normalized)) {
            return { mode: 'info', domain: 'web', reason: 'guncel_bilgi_sorusu' };
        }
        if (isRecentRecheckQuery(normalized)) {
            return { mode: 'info', domain: 'web', reason: 'guncel_bilgi_tekrar_dogrulama' };
        }

        const targetDetected = hasActionTarget(normalized);
        const actionVerbDetected = hasActionVerb(normalized);
        const actionInfoQuery = targetDetected && INFO_INTENT_REGEX.test(normalized);

        if (targetDetected && actionVerbDetected && !actionInfoQuery) {
            return { mode: 'action', domain: 'action', reason: 'eylem_fiili_ve_hedef_bulundu' };
        }

        if (QUESTION_HINT_REGEX.test(normalized)) {
            return { mode: 'info', domain: 'chat', reason: 'genel_soru_kalibi' };
        }

        if (targetDetected && !actionVerbDetected) {
            return { mode: 'info', domain: 'chat', reason: 'hedef_var_ama_eylem_yok' };
        }

        return { mode: 'info', domain: 'chat', reason: 'varsayilan_chat' };
    };

    return Object.freeze({
        normalizeTr,
        routeTranscript
    });
});
