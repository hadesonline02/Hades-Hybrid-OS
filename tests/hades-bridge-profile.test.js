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
        expect(prompt).toContain('Senin adin HADES.');
        expect(prompt).toContain('asiri laubali');
        expect(prompt).toContain('```hades-bridge');
        expect(prompt).toContain('"tool":"health.get"');
        expect(prompt).not.toContain('HADES_LOCAL_EXECUTION');
        expect(prompt).toContain('yazili ya da sesten gelmis olabilir');
        expect(prompt).toContain('Asla JSON icerigini duz metin olarak');
        expect(prompt).toContain('meta aciklamalara girme');
        expect(prompt).toContain('isik zaten acik');
        expect(prompt).toContain('Deepgram configured');
        expect(prompt).toContain('Spotify authenticated');
        expect(prompt).toContain('Spotify device ready');
        expect(prompt).toContain('Local time zone');
        expect(prompt).toContain('Local current time');
        expect(prompt).toContain('goreli surelerde time alanina goreli ifadeyi oldugu gibi yaz');
        expect(prompt).toContain('alarm.list');
        expect(prompt).toContain('reminder.list');
        expect(prompt).toContain('message=Opsiyonel alarm notu');
        expect(prompt).toContain('message=Opsiyonel hatirlatici mesaji');
        expect(prompt).toContain('ChatGPT gorevleri');
        expect(prompt).toContain('alarm.set ve reminder.set yerel veritabanina kayit yazar');
        expect(prompt).toContain('message alanina zamani gelince HADESin sesli olarak soylemesi gereken');
        expect(prompt).toContain('yerel HADES alarm sistemi tarafindan okunur');
        expect(prompt).toContain('browser.search');
        expect(prompt).toContain('browser.open');
        expect(prompt).toContain('browser.panel');
        expect(prompt).toContain('cockpit.window');
        expect(prompt).toContain('Kullanici bir seyi bulup acmami isterse browser.search veya browser.open kullan');
        expect(prompt).toContain('Kullaniciyi "sonuclara git, ilkine tikla" gibi ara adimlara yonlendirme');
        expect(prompt).toContain('browser.open ile tahmini link uydurma');
        expect(prompt).toContain('once web.search ile internetten arastir');
        expect(prompt).toContain('selected.url');
        expect(prompt).toContain('exact URLyi kullan');
        expect(prompt).toContain('hedefi resolve edip mumkunse dogrudan o hedefi acmak icindir');
        expect(prompt).toContain('cockpit penceresini acmamı');
    });

    test('context payload tools ve prompt doner', () => {
        const payload = buildBridgeContextPayload({
            runtime: {
                health: { status: 'ok' },
                spotify: { ready: false }
            }
        });

        expect(Array.isArray(payload.tools)).toBe(true);
        expect(payload.tools.length).toBe(TOOL_CATALOG.length);
        expect(payload.tools.some((tool) => tool.name === 'browser.search')).toBe(true);
        expect(payload.tools.some((tool) => tool.name === 'browser.open')).toBe(true);
        expect(payload.tools.some((tool) => tool.name === 'browser.panel')).toBe(true);
        expect(payload.tools.some((tool) => tool.name === 'cockpit.window')).toBe(true);
        expect(typeof payload.prompt).toBe('string');
        expect(payload.prompt).toContain('HADES');
    });
});
