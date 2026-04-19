const { normalizeTr, routeTranscript } = require('../src/brain/router');

describe('Router testleri', () => {
    test('dolar kac tl -> finance', () => {
        const result = routeTranscript('dolar kac tl');
        expect(result.mode).toBe('info');
        expect(result.domain).toBe('finance');
    });

    test('hava kac derece -> weather', () => {
        const result = routeTranscript('hava kac derece');
        expect(result.mode).toBe('info');
        expect(result.domain).toBe('weather');
    });

    test('son dakika haber -> news', () => {
        const result = routeTranscript('son dakika haber');
        expect(result.mode).toBe('info');
        expect(result.domain).toBe('news');
    });

    test("Turkiye'nin baskenti neresi -> chat", () => {
        const result = routeTranscript("Turkiye'nin baskenti neresi");
        expect(result.mode).toBe('info');
        expect(result.domain).toBe('chat');
    });

    test('orkun isitmak en son hangi videoyu atti -> web', () => {
        const result = routeTranscript('orkun isitmak en son hangi videoyu atti');
        expect(result.mode).toBe('info');
        expect(result.domain).toBe('web');
    });

    test('internetten bak -> web', () => {
        const result = routeTranscript('internetten bak');
        expect(result.mode).toBe('info');
        expect(result.domain).toBe('web');
    });

    test('en son videosu o değil iyi araştır -> web', () => {
        const result = routeTranscript('orkunun en son videosu o değil iyi araştır');
        expect(result.mode).toBe('info');
        expect(result.domain).toBe('web');
    });

    test('isigi ac -> action', () => {
        const result = routeTranscript('isigi ac');
        expect(result.mode).toBe('action');
    });

    test('isigi acar misin -> action', () => {
        const result = routeTranscript('isigi acar misin');
        expect(result.mode).toBe('action');
    });

    test('aksudan bir şarkı çal -> action', () => {
        const result = routeTranscript("sezen aksu'dan bir şarkı çal");
        expect(result.mode).toBe('action');
    });

    test('Türkçe karakterleri locale-aware normalize eder', () => {
        expect(normalizeTr('IĞDIR İZMİR Üsküdar Çeşme')).toBe('igdir izmir uskudar cesme');
    });

    test('isiklar hakkinda bilgi ver -> chat', () => {
        const result = routeTranscript('isiklar hakkinda bilgi ver');
        expect(result.mode).toBe('info');
        expect(result.domain).toBe('chat');
    });
});
