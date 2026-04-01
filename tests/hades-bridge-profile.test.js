const {
    BRIDGE_PROMPT_VERSION,
    TOOL_CATALOG,
    buildBridgeContextPayload,
    buildBridgePrompt
} = require('../app/hades-bridge-profile');

describe('hades bridge profile', () => {
    test('prompt version marker ve yerel arac formatini icerir', () => {
        const prompt = buildBridgePrompt({
            runtime: {
                health: { status: 'ok', tuyaConfigured: true, tuyaConnected: false, spotifyConfigured: true },
                spotify: { ready: true, authenticated: true, deviceReady: false }
            }
        });

        expect(prompt).toContain(BRIDGE_PROMPT_VERSION);
        expect(prompt).toContain('Senin adın HADES.');
        expect(prompt).toContain('"babacığım"');
        expect(prompt).toContain('```hades-bridge');
        expect(prompt).toContain('"tool":"health.get"');
        expect(prompt).not.toContain('HADES_LOCAL_EXECUTION');
        expect(prompt).toContain('yazılı ya da sesten gelmiş olabilir');
        expect(prompt).toContain('Asla JSON içeriğini düz metin olarak');
        expect(prompt).toContain('ışık zaten açık');
        expect(prompt).toContain('Deepgram configured');
        expect(prompt).toContain('Spotify authenticated');
        expect(prompt).toContain('Spotify device ready');
        expect(prompt).toContain('Local time zone');
        expect(prompt).toContain('Local current time');
        expect(prompt).toContain('göreli sürelerde time alanına göreli ifadeyi olduğu gibi yaz');
        expect(prompt).toContain('alarm.list');
        expect(prompt).toContain('reminder.list');
        expect(prompt).toContain('message=Opsiyonel alarm notu');
        expect(prompt).toContain('message=Opsiyonel hatırlatıcı mesajı');
        expect(prompt).toContain('ChatGPT görevleri');
        expect(prompt).toContain('alarm.set ve reminder.set yerel veritabanına kayıt yazar');
        expect(prompt).toContain('message alanına zamanı gelince HADESin sesli olarak söylemesi gereken');
        expect(prompt).toContain('yerel HADES alarm sistemi tarafından okunur');
    });

    test('context payload tools ve prompt döner', () => {
        const payload = buildBridgeContextPayload({
            runtime: {
                health: { status: 'ok' },
                spotify: { ready: false }
            }
        });

        expect(Array.isArray(payload.tools)).toBe(true);
        expect(payload.tools.length).toBe(TOOL_CATALOG.length);
        expect(typeof payload.prompt).toBe('string');
        expect(payload.prompt).toContain('HADES');
    });
});
