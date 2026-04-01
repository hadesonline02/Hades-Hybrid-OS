process.env.TZ = 'Europe/Istanbul';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createChromeStub() {
    const alarmCalls = [];
    const storageState = {};
    const listeners = {};

    const localStorage = {
        async get(key) {
            if (Array.isArray(key)) {
                return key.reduce((acc, item) => {
                    acc[item] = storageState[item];
                    return acc;
                }, {});
            }

            if (key && typeof key === 'object') {
                return Object.keys(key).reduce((acc, item) => {
                    acc[item] = Object.prototype.hasOwnProperty.call(storageState, item) ? storageState[item] : key[item];
                    return acc;
                }, {});
            }

            return {
                [key]: storageState[key]
            };
        },
        async set(payload) {
            Object.assign(storageState, payload);
        },
        async remove(key) {
            const keys = Array.isArray(key) ? key : [key];
            keys.forEach((item) => {
                delete storageState[item];
            });
        }
    };

    return {
        chrome: {
            runtime: {
                onInstalled: { addListener(handler) { listeners.onInstalled = handler; } },
                onStartup: { addListener(handler) { listeners.onStartup = handler; } },
                onMessage: { addListener(handler) { listeners.onMessage = handler; } },
                getURL(value) {
                    return value;
                }
            },
            tabs: {
                onRemoved: { addListener(handler) { listeners.onTabRemoved = handler; } },
                async query() {
                    return [];
                },
                async sendMessage() {
                    return null;
                },
                async create() {
                    return { id: 1 };
                },
                async update() {
                    return { id: 1 };
                }
            },
            alarms: {
                onAlarm: { addListener(handler) { listeners.onAlarm = handler; } },
                async create(name, options) {
                    alarmCalls.push({ name, options });
                },
                async clear() {
                    return true;
                }
            },
            storage: {
                local: localStorage
            },
            notifications: {
                async create() {
                    return true;
                }
            },
            windows: {
                async create() {
                    return { id: 1 };
                }
            },
            scripting: {
                async executeScript() {
                    return [];
                }
            }
        },
        alarmCalls,
        storageState,
        listeners
    };
}

function loadServiceWorker(nowIso = '2026-04-01T15:52:00+03:00') {
    const source = fs.readFileSync(path.join(__dirname, '../app/chatgpt-bridge-extension/service-worker.js'), 'utf8');
    const fixedNow = Date.parse(nowIso);
    const { chrome, alarmCalls, storageState, listeners } = createChromeStub();
    const RealDate = Date;

    class FakeDate extends RealDate {
        constructor(...args) {
            super(...(args.length ? args : [fixedNow]));
        }

        static now() {
            return fixedNow;
        }
    }

    const context = {
        chrome,
        console,
        URLSearchParams,
        fetch: async (_url, options = {}) => {
            let payload = {};
            if (typeof options.body === 'string' && options.body.trim()) {
                try {
                    payload = JSON.parse(options.body);
                } catch (_) {
                    payload = {};
                }
            }

            return {
                ok: true,
                status: 200,
                headers: {
                    get(name) {
                        return String(name || '').toLowerCase() === 'content-type'
                            ? 'application/json'
                            : null;
                    }
                },
                json: async () => payload,
                text: async () => JSON.stringify(payload)
            };
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Date: FakeDate
    };

    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    return { context, alarmCalls, storageState, listeners };
}

describe('bridge alarm schedule', () => {
    test('goreli alarmi yerel saate gore tek seferlik kurar', async () => {
        const { context, alarmCalls } = loadServiceWorker();

        const result = context.resolveScheduleInput('1 dakika sonrasına');

        expect(result.time).toBe('15:53');
        expect(result.repeat).toBe('once');
        expect(Date.parse(result.nextTriggerAtISO)).toBe(Date.parse('2026-04-01T15:53:00+03:00'));

        const created = await context.createScheduleEntry('alarm', { time: '1 dakika sonrasına' });

        expect(created.entry.time).toBe('15:53');
        expect(created.entry.repeat).toBe('once');
        expect(alarmCalls).toHaveLength(1);
        expect(alarmCalls[0].options.when).toBe(Date.parse('2026-04-01T15:53:00+03:00'));
    });

    test('goreli ifadeyle kurulan alarm yine goreli ifadeyle silinebilir', async () => {
        const { context } = loadServiceWorker();

        await context.createScheduleEntry('alarm', { time: '1 dakika sonra' });
        const removed = await context.deleteScheduleEntry('alarm', { time: '1 dakika sonrasına' });
        const listed = await context.listScheduleEntries('alarm');

        expect(removed.removedCount).toBe(1);
        expect(listed.count).toBe(0);
    });

    test('hatirlatici aktif uyarisi dogru Turkceyle olusturulur', () => {
        const { context } = loadServiceWorker();

        const alert = context.buildActiveAlert({
            id: 'hades:reminder:15:53:su-ic',
            kind: 'reminder',
            time: '15:53',
            message: 'Su iç'
        });

        expect(alert.detail).toContain('15:53');
        expect(alert.detail).toContain('Su iç');
        expect(alert.spokenText).toContain('Hatırlatmam');
        expect(alert.spokenText).toContain('Su iç');
    });

    test('alarm zamani geldiginde aktif sesli uyariya donusur', async () => {
        const { context, listeners } = loadServiceWorker();

        const created = await context.createScheduleEntry('alarm', { time: '1 dakika sonra' });
        await listeners.onAlarm({ name: created.entry.id });

        const activeAlert = await context.readStoredActiveAlert();
        const listed = await context.listScheduleEntries('alarm');

        expect(activeAlert.kind).toBe('alarm');
        expect(activeAlert.spokenText).toContain('vakit geldi');
        expect(listed.count).toBe(0);
    });

    test('alarm olayi kacsa bile due kayit poll sirasinda aktif olur', async () => {
        const { context, storageState } = loadServiceWorker('2026-04-01T15:54:00+03:00');

        storageState.hadesBridgeAlarms = [
            {
                id: 'hades:alarm:15:53',
                kind: 'alarm',
                time: '15:53',
                message: '',
                repeat: 'once',
                nextTriggerAtISO: '2026-04-01T15:53:00+03:00',
                createdAtISO: '2026-04-01T15:52:00+03:00'
            }
        ];

        const activeAlert = await context.ensureDueAlerts();
        const listed = await context.listScheduleEntries('alarm');

        expect(activeAlert.kind).toBe('alarm');
        expect(activeAlert.spokenText).toContain('vakit geldi');
        expect(listed.count).toBe(0);
    });

    test('resync gecmis tek seferlik alarmi sessizce silmez', async () => {
        const { context, storageState } = loadServiceWorker('2026-04-01T15:54:00+03:00');

        storageState.hadesBridgeAlarms = [
            {
                id: 'hades:alarm:15:53',
                kind: 'alarm',
                time: '15:53',
                message: '',
                repeat: 'once',
                nextTriggerAtISO: '2026-04-01T15:53:00+03:00',
                createdAtISO: '2026-04-01T15:52:00+03:00'
            }
        ];

        await context.resyncAllSchedules();

        expect(Array.isArray(storageState.hadesBridgeAlarms)).toBe(true);
        expect(storageState.hadesBridgeAlarms).toHaveLength(1);
        expect(storageState.hadesBridgeAlarms[0].id).toBe('hades:alarm:15:53');
    });
});
