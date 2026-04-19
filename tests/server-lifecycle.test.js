const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const SCHEDULE_DB_PATH = path.join(__dirname, '.tmp-hades-schedule-db.json');
process.env.HADES_SCHEDULE_DB_PATH = SCHEDULE_DB_PATH;

const { startServer, stopServer } = require('../server');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('server lifecycle', () => {
    afterEach(async () => {
        await stopServer();
        if (fs.existsSync(SCHEDULE_DB_PATH)) {
            fs.unlinkSync(SCHEDULE_DB_PATH);
        }
    });

    test('starts health endpoint without forcing Tuya bootstrap', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const response = await fetch(`http://127.0.0.1:${activePort}/health`);
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.status).toBe('ok');
        expect(payload.service).toBe('hades-backend');
        expect(typeof payload.openAiConfigured).toBe('boolean');
        expect(typeof payload.deepgramConfigured).toBe('boolean');
    });

    test('voice config endpoint returns wake word metadata', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const response = await fetch(`http://127.0.0.1:${activePort}/bridge/voice-config`);
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.wakeWord).toBe('HADES');
        expect(payload.locale).toBe('tr-TR');
        expect(typeof payload.deepgramConfigured).toBe('boolean');
        expect(['python', 'google-cloud']).toContain(payload.wakeRuntime);
    });

    test('replaced wake/reply sockets do not kill the active native wake listener', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const configResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/voice-config`);
        const configPayload = await configResponse.json();
        if (!configPayload.nativeWakeSupported) {
            expect(typeof configPayload.nativeWakeSupported).toBe('boolean');
            return;
        }

        const instanceId = `jest-${Date.now()}`;
        const openSocket = (pathname) => new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${activePort}${pathname}?instanceId=${encodeURIComponent(instanceId)}`);
            socket.once('open', () => resolve(socket));
            socket.once('error', reject);
        });
        const postJson = async (pathname, body) => {
            const response = await fetch(`http://127.0.0.1:${activePort}${pathname}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return response.json();
        };

        const wakeSocket1 = await openSocket('/bridge/wake-events');
        const startPayload = await postJson('/bridge/wake-listener/start', {
            instanceId,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(startPayload.ok).toBe(true);

        await sleep(800);
        const wakeSocket2 = await openSocket('/bridge/wake-events');
        await sleep(800);

        const afterWakeReplace = await postJson('/bridge/wake-listener/start', {
            instanceId,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(afterWakeReplace.alreadyRunning).toBe(true);

        const replySocket = await openSocket('/bridge/reply-events');
        replySocket.close();
        await sleep(800);

        const afterReplyClose = await postJson('/bridge/wake-listener/start', {
            instanceId,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(afterReplyClose.alreadyRunning).toBe(true);

        try { wakeSocket1.close(); } catch (_) {}
        try { wakeSocket2.close(); } catch (_) {}
        try {
            await postJson('/bridge/wake-listener/stop', { instanceId });
        } catch (_) {}
    }, 20000);

    test('native wake events carry session ids for stale-session filtering', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const configResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/voice-config`);
        const configPayload = await configResponse.json();
        if (!configPayload.nativeWakeSupported) {
            expect(typeof configPayload.nativeWakeSupported).toBe('boolean');
            return;
        }

        const instanceId = `jest-session-${Date.now()}`;
        const sessionId = `session-${Date.now()}`;
        const messages = [];
        const socket = await new Promise((resolve, reject) => {
            const next = new WebSocket(`ws://127.0.0.1:${activePort}/bridge/wake-events?instanceId=${encodeURIComponent(instanceId)}`);
            next.once('open', () => resolve(next));
            next.once('error', reject);
        });
        socket.on('message', (raw) => {
            try {
                messages.push(JSON.parse(String(raw || '{}')));
            } catch (_) {}
        });

        const postJson = async (pathname, body) => {
            const response = await fetch(`http://127.0.0.1:${activePort}${pathname}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return response.json();
        };

        const startPayload = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(startPayload.ok).toBe(true);
        expect(startPayload.sessionId).toBe(sessionId);

        const waitForMessage = async (matcher, timeoutMs = 8000) => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                if (messages.some(matcher)) return true;
                await sleep(100);
            }
            return false;
        };

        expect(await waitForMessage((message) => message.type === 'started' && message.sessionId === sessionId)).toBe(true);

        const stopPayload = await postJson('/bridge/wake-listener/stop', { instanceId });
        expect(stopPayload.ok).toBe(true);

        expect(await waitForMessage((message) => message.type === 'bridge:wake-closed' && message.sessionId === sessionId)).toBe(true);

        try { socket.close(); } catch (_) {}
    }, 20000);

    test('closing the wake events websocket does not stop an active native wake listener', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const configResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/voice-config`);
        const configPayload = await configResponse.json();
        if (!configPayload.nativeWakeSupported) {
            expect(typeof configPayload.nativeWakeSupported).toBe('boolean');
            return;
        }

        const instanceId = `jest-wake-close-${Date.now()}`;
        const sessionId = `session-${Date.now()}`;
        const postJson = async (pathname, body) => {
            const response = await fetch(`http://127.0.0.1:${activePort}${pathname}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return response.json();
        };

        const socket = await new Promise((resolve, reject) => {
            const next = new WebSocket(`ws://127.0.0.1:${activePort}/bridge/wake-events?instanceId=${encodeURIComponent(instanceId)}`);
            next.once('open', () => resolve(next));
            next.once('error', reject);
        });

        const startPayload = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(startPayload.ok).toBe(true);
        expect(startPayload.sessionId).toBe(sessionId);

        try { socket.close(); } catch (_) {}
        await sleep(600);

        const stillRunning = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(stillRunning.ok).toBe(true);
        expect(stillRunning.alreadyRunning).toBe(true);
        expect(stillRunning.sessionId).toBe(sessionId);

        try {
            await postJson('/bridge/wake-listener/stop', {
                instanceId,
                sessionId
            });
        } catch (_) {}
    }, 20000);

    test('stale native wake stop request does not kill a newer session', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const configResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/voice-config`);
        const configPayload = await configResponse.json();
        if (!configPayload.nativeWakeSupported) {
            expect(typeof configPayload.nativeWakeSupported).toBe('boolean');
            return;
        }

        const instanceId = `jest-stale-stop-${Date.now()}`;
        const sessionA = `session-a-${Date.now()}`;
        const sessionB = `session-b-${Date.now()}`;

        const postJson = async (pathname, body) => {
            const response = await fetch(`http://127.0.0.1:${activePort}${pathname}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return response.json();
        };

        const startA = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId: sessionA,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(startA.ok).toBe(true);
        expect(startA.sessionId).toBe(sessionA);

        const stopA = await postJson('/bridge/wake-listener/stop', {
            instanceId,
            sessionId: sessionA
        });
        expect(stopA.ok).toBe(true);
        expect(stopA.stopped).toBe(true);

        const startB = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId: sessionB,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(startB.ok).toBe(true);
        expect(startB.sessionId).toBe(sessionB);

        const staleStop = await postJson('/bridge/wake-listener/stop', {
            instanceId,
            sessionId: sessionA
        });
        expect(staleStop.ok).toBe(true);
        expect(staleStop.stopped).toBe(false);

        const stillRunning = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId: sessionB,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(stillRunning.ok).toBe(true);
        expect(stillRunning.alreadyRunning).toBe(true);
        expect(stillRunning.sessionId).toBe(sessionB);

        try {
            await postJson('/bridge/wake-listener/stop', {
                instanceId,
                sessionId: sessionB
            });
        } catch (_) {}
    }, 20000);

    test('same instance with a new session replaces the old native wake process', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const configResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/voice-config`);
        const configPayload = await configResponse.json();
        if (!configPayload.nativeWakeSupported) {
            expect(typeof configPayload.nativeWakeSupported).toBe('boolean');
            return;
        }

        const instanceId = `jest-replace-session-${Date.now()}`;
        const sessionA = `replace-a-${Date.now()}`;
        const sessionB = `replace-b-${Date.now()}`;

        const postJson = async (pathname, body) => {
            const response = await fetch(`http://127.0.0.1:${activePort}${pathname}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return response.json();
        };

        const startA = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId: sessionA,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(startA.ok).toBe(true);
        expect(startA.sessionId).toBe(sessionA);

        const startB = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId: sessionB,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(startB.ok).toBe(true);
        expect(startB.sessionId).toBe(sessionB);
        expect(startB.alreadyRunning).not.toBe(true);

        const confirmB = await postJson('/bridge/wake-listener/start', {
            instanceId,
            sessionId: sessionB,
            locale: 'tr-TR',
            wakeWord: 'HADES'
        });
        expect(confirmB.ok).toBe(true);
        expect(confirmB.alreadyRunning).toBe(true);
        expect(confirmB.sessionId).toBe(sessionB);

        try {
            await postJson('/bridge/wake-listener/stop', {
                instanceId,
                sessionId: sessionB
            });
        } catch (_) {}
    }, 20000);

    test('voice overlay state endpoint accepts updates', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const writeResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/voice-overlay-state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chip: 'Komut dinliyor',
                tone: 'ok',
                detail: 'Test detayi',
                mode: 'command',
                meter: 61
            })
        });
        const writePayload = await writeResponse.json();
        const readResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/voice-overlay-state`);
        const readPayload = await readResponse.json();

        expect(writeResponse.status).toBe(200);
        expect(writePayload.ok).toBe(true);
        expect(readResponse.status).toBe(200);
        expect(readPayload.chip).toBe('Komut dinliyor');
        expect(readPayload.mode).toBe('command');
        expect(readPayload.meter).toBe(61);
    });

    test('spotify status endpoint returns auth and device flags', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const response = await fetch(`http://127.0.0.1:${activePort}/spotify/status`);
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(typeof payload.configured).toBe('boolean');
        expect(typeof payload.authenticated).toBe('boolean');
        expect(typeof payload.ready).toBe('boolean');
        expect(typeof payload.deviceReady).toBe('boolean');
        expect(typeof payload.activeDevice).toBe('boolean');
        expect(typeof payload.deviceCount).toBe('number');
    });

    test('schedule endpoints round-trip reminder entries in local db', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;
        const entries = [
            {
                id: 'hades:reminder:15:53:su-ic',
                kind: 'reminder',
                time: '15:53',
                message: 'Su iç',
                repeat: 'once',
                nextTriggerAtISO: '2026-04-01T15:53:00+03:00',
                createdAtISO: '2026-04-01T15:52:00+03:00'
            }
        ];

        const writeResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/schedules/reminder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries })
        });
        const writePayload = await writeResponse.json();
        const readResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/schedules/reminder`);
        const readPayload = await readResponse.json();

        expect(writeResponse.status).toBe(200);
        expect(writePayload.ok).toBe(true);
        expect(writePayload.entries).toHaveLength(1);
        expect(writePayload.entries[0].message).toBe('Su iç');
        expect(readResponse.status).toBe(200);
        expect(readPayload.ok).toBe(true);
        expect(readPayload.entries).toHaveLength(1);
        expect(readPayload.entries[0].id).toBe('hades:reminder:15:53:su-ic');
        expect(fs.existsSync(SCHEDULE_DB_PATH)).toBe(true);
    });

    test('active alert endpoint claims due alarm from local db', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;
        const realNow = Date.now;

        Date.now = () => Date.parse('2026-04-01T17:35:00Z');
        try {
            const writeResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/schedules/alarm`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entries: [
                        {
                            id: 'hades:alarm:20:33',
                            kind: 'alarm',
                            time: '20:33',
                            message: '',
                            repeat: 'once',
                            nextTriggerAtISO: '2026-04-01T17:33:00Z',
                            createdAtISO: '2026-04-01T17:32:00Z'
                        }
                    ]
                })
            });
            expect(writeResponse.status).toBe(200);

            const alertResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/active-alert`);
            const alertPayload = await alertResponse.json();
            const listResponse = await fetch(`http://127.0.0.1:${activePort}/bridge/schedules/alarm`);
            const listPayload = await listResponse.json();

            expect(alertResponse.status).toBe(200);
            expect(alertPayload.ok).toBe(true);
            expect(alertPayload.alert.kind).toBe('alarm');
            expect(alertPayload.alert.spokenText).toContain('vakit geldi');
            expect(listPayload.entries).toHaveLength(0);
        } finally {
            Date.now = realNow;
        }
    });

    test('ops state ve browser open endpointleri cockpit durumunu dondurur', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;

        const openResponse = await fetch(`http://127.0.0.1:${activePort}/ops/browser/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: 'openai agents docs',
                source: 'jest',
                reason: 'test_search'
            })
        });
        const openPayload = await openResponse.json();
        const stateResponse = await fetch(`http://127.0.0.1:${activePort}/ops/state`);
        const statePayload = await stateResponse.json();

        expect(openResponse.status).toBe(200);
        expect(openPayload.ok).toBe(true);
        expect(typeof openPayload.browser.url).toBe('string');
        expect(openPayload.browser.url.length).toBeGreaterThan(8);
        expect(openPayload.browser.query).toBe('openai agents docs');
        expect(typeof openPayload.resolution?.resolved).toBe('boolean');
        expect(openPayload.ui?.browserPanelVisible).toBe(true);
        expect(stateResponse.status).toBe(200);
        expect(statePayload.ok).toBe(true);
        expect(statePayload.state.browser.url).toBe(openPayload.browser.url);
        expect(typeof statePayload.state.ui?.browserPanelVisible).toBe('boolean');
        expect(Array.isArray(statePayload.state.recentEvents)).toBe(true);
        expect(statePayload.state.recentEvents.some((event) => event.type === 'browser.command')).toBe(true);
    });

    test('browser open resmi kanalın en yeni YouTube videosunu resolve eder', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;
        const realFetch = global.fetch;
        const channelId = 'UCWpk9PSGHoJW1hZT4egxTNQ';

        const mockDuckHtml = `
            <html>
                <body>
                    <a class="result__a" href="https://www.webtekno.com/ruhi-cenet-costa-concordia-calinti-mi-h92324.html">Ruhi Çenet'in son videosu çalıntı mı?</a>
                    <a class="result__snippet">Haber içeriği</a>
                    <a class="result__a" href="https://www.youtube.com/channel/${channelId}">Ruhi Cenet Documentaries - YouTube</a>
                    <a class="result__snippet">Ruhi Çenet'in belgesel kanalı</a>
                </body>
            </html>
        `;
        const mockFeedXml = `
            <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
                <entry>
                    <yt:videoId>latest-video-123</yt:videoId>
                    <title>Ruhi Çenet Gerçek Son Video</title>
                    <published>2026-04-10T10:00:00+00:00</published>
                </entry>
                <entry>
                    <yt:videoId>older-video-456</yt:videoId>
                    <title>Eski Video</title>
                    <published>2025-01-10T10:00:00+00:00</published>
                </entry>
            </feed>
        `;

        global.fetch = async (input, init) => {
            const url = String(input || '');
            if (url.startsWith(`http://127.0.0.1:${activePort}`)) {
                return realFetch(input, init);
            }
            if (url.startsWith('https://html.duckduckgo.com/html/')) {
                return new Response(mockDuckHtml, {
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                });
            }
            if (url.startsWith('https://api.duckduckgo.com/')) {
                return new Response(JSON.stringify({
                    AbstractText: '',
                    RelatedTopics: []
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (url.startsWith(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)) {
                return new Response(mockFeedXml, {
                    status: 200,
                    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' }
                });
            }
            return realFetch(input, init);
        };

        try {
            const response = await fetch(`http://127.0.0.1:${activePort}/ops/browser/open`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: "Ruhi Çenet'in son videosunu aç belgesel kanalından",
                    source: 'jest',
                    reason: 'latest_video_test'
                })
            });
            const payload = await response.json();

            expect(response.status).toBe(200);
            expect(payload.ok).toBe(true);
            expect(payload.browser.url).toBe('https://www.youtube.com/watch?v=latest-video-123');
            expect(payload.browser.title).toBe('Ruhi Çenet Gerçek Son Video');
            expect(payload.resolution?.intent?.latestVideo).toBe(true);
            expect(payload.resolution?.intent?.officialChannel).toBe(true);
            expect(payload.resolution?.selected?.url).toBe('https://www.youtube.com/watch?v=latest-video-123');
        } finally {
            global.fetch = realFetch;
        }
    });

    test('browser open url alanina yazilan dogal dili de canli aramayla resolve eder', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;
        const realFetch = global.fetch;
        const channelId = 'UCWpk9PSGHoJW1hZT4egxTNQ';

        const mockDuckHtml = `
            <html>
                <body>
                    <a class="result__a" href="https://www.webtekno.com/ruhi-cenet-costa-concordia-calinti-mi-h92324.html">Ruhi Ã‡enet'in son videosu Ã§alÄ±ntÄ± mÄ±?</a>
                    <a class="result__snippet">Haber iÃ§eriÄŸi</a>
                    <a class="result__a" href="https://www.youtube.com/channel/${channelId}">Ruhi Cenet Documentaries - YouTube</a>
                    <a class="result__snippet">Ruhi Ã‡enet'in belgesel kanalÄ±</a>
                </body>
            </html>
        `;
        const mockFeedXml = `
            <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
                <entry>
                    <yt:videoId>latest-video-from-open-789</yt:videoId>
                    <title>Ruhi Ã‡enet GerÃ§ek Son Video Open</title>
                    <published>2026-04-11T10:00:00+00:00</published>
                </entry>
                <entry>
                    <yt:videoId>older-video-456</yt:videoId>
                    <title>Eski Video</title>
                    <published>2025-01-10T10:00:00+00:00</published>
                </entry>
            </feed>
        `;

        global.fetch = async (input, init) => {
            const url = String(input || '');
            if (url.startsWith(`http://127.0.0.1:${activePort}`)) {
                return realFetch(input, init);
            }
            if (url.startsWith('https://html.duckduckgo.com/html/')) {
                return new Response(mockDuckHtml, {
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                });
            }
            if (url.startsWith('https://api.duckduckgo.com/')) {
                return new Response(JSON.stringify({
                    AbstractText: '',
                    RelatedTopics: []
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (url.startsWith(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)) {
                return new Response(mockFeedXml, {
                    status: 200,
                    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' }
                });
            }
            return realFetch(input, init);
        };

        try {
            const response = await fetch(`http://127.0.0.1:${activePort}/ops/browser/open`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: "Ruhi Ã‡enet'in son videosunu aÃ§ belgesel kanalÄ±ndan",
                    source: 'jest',
                    reason: 'natural_language_url_test'
                })
            });
            const payload = await response.json();

            expect(response.status).toBe(200);
            expect(payload.ok).toBe(true);
            expect(payload.browser.url).toBe('https://www.youtube.com/watch?v=latest-video-from-open-789');
            expect(payload.browser.query).toBe("Ruhi Ã‡enet'in son videosunu aÃ§ belgesel kanalÄ±ndan");
            expect(payload.resolution?.query).toBe("Ruhi Ã‡enet'in son videosunu aÃ§ belgesel kanalÄ±ndan");
            expect(payload.resolution?.selected?.url).toBe('https://www.youtube.com/watch?v=latest-video-from-open-789');
        } finally {
            global.fetch = realFetch;
        }
    });

    test('web search guncel hedef icin selected exact URL dondurur', async () => {
        const server = await startServer({ port: 0, connectTuyaOnStart: false, loadSpotifyOnStart: false });
        const activePort = server.address().port;
        const realFetch = global.fetch;
        const channelId = 'UCWpk9PSGHoJW1hZT4egxTNQ';

        const mockDuckHtml = `
            <html>
                <body>
                    <a class="result__a" href="https://www.webtekno.com/ruhi-cenet-costa-concordia-calinti-mi-h92324.html">Ruhi Ã‡enet'in son videosu Ã§alÄ±ntÄ± mÄ±?</a>
                    <a class="result__snippet">Haber iÃ§eriÄŸi</a>
                    <a class="result__a" href="https://www.youtube.com/channel/${channelId}">Ruhi Cenet Documentaries - YouTube</a>
                    <a class="result__snippet">Ruhi Ã‡enet'in belgesel kanalÄ±</a>
                </body>
            </html>
        `;
        const mockFeedXml = `
            <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
                <entry>
                    <yt:videoId>latest-video-from-web-search-456</yt:videoId>
                    <title>Ruhi Ã‡enet GerÃ§ek Son Video Search</title>
                    <published>2026-04-12T10:00:00+00:00</published>
                </entry>
                <entry>
                    <yt:videoId>older-video-456</yt:videoId>
                    <title>Eski Video</title>
                    <published>2025-01-10T10:00:00+00:00</published>
                </entry>
            </feed>
        `;

        global.fetch = async (input, init) => {
            const url = String(input || '');
            if (url.startsWith(`http://127.0.0.1:${activePort}`)) {
                return realFetch(input, init);
            }
            if (url.startsWith('https://html.duckduckgo.com/html/')) {
                return new Response(mockDuckHtml, {
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                });
            }
            if (url.startsWith('https://api.duckduckgo.com/')) {
                return new Response(JSON.stringify({
                    AbstractText: '',
                    RelatedTopics: []
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (url.startsWith(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)) {
                return new Response(mockFeedXml, {
                    status: 200,
                    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' }
                });
            }
            return realFetch(input, init);
        };

        try {
            const response = await fetch(`http://127.0.0.1:${activePort}/web/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: "Ruhi Ã‡enet'in son videosunu aÃ§ belgesel kanalÄ±ndan"
                })
            });
            const payload = await response.json();

            expect(response.status).toBe(200);
            expect(payload.ok).toBe(true);
            expect(payload.intent?.latestVideo).toBe(true);
            expect(payload.selected?.url).toBe('https://www.youtube.com/watch?v=latest-video-from-web-search-456');
            expect(payload.selected?.title).toBe('Ruhi Ã‡enet GerÃ§ek Son Video Search');
            expect(payload.answer).toContain('https://www.youtube.com/watch?v=latest-video-from-web-search-456');
        } finally {
            global.fetch = realFetch;
        }
    });
});
