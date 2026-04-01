const fs = require('fs');
const path = require('path');

const SCHEDULE_DB_PATH = path.join(__dirname, '.tmp-hades-schedule-db.json');
process.env.HADES_SCHEDULE_DB_PATH = SCHEDULE_DB_PATH;

const { startServer, stopServer } = require('../server');

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
    });

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
});
