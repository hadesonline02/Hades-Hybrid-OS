const BACKEND_CANDIDATES = [
    'http://127.0.0.1:3001',
    'http://localhost:3001'
];

const SETTINGS_KEY = 'hadesBridgeSettings';
const ALARMS_KEY = 'hadesBridgeAlarms';
const REMINDERS_KEY = 'hadesBridgeReminders';
const ACTIVE_ALERT_KEY = 'hadesBridgeActiveAlert';
const CHATGPT_URL_PATTERNS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

const DEFAULT_SETTINGS = Object.freeze({
    bridgeEnabled: true,
    autoRun: true,
    voiceEnabled: true
});
const VOICE_OWNER_TTL_MS = 4000;

let voiceOwner = null;

chrome.runtime.onInstalled.addListener(async () => {
    await ensureSettings();
    await resyncAllSchedules();
});

chrome.runtime.onStartup.addListener(async () => {
    await ensureSettings();
    await resyncAllSchedules();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
        .then((payload) => sendResponse(payload))
        .catch((error) => {
            sendResponse({
                ok: false,
                error: error.message || String(error)
            });
        });
    return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (voiceOwner?.tabId === tabId) {
        voiceOwner = null;
    }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    const scheduleEntry = await findScheduleEntry(alarm.name);
    if (!scheduleEntry) return;

    const title = scheduleEntry.kind === 'reminder' ? 'HADES Hatırlatıcı' : 'HADES Alarm';
    const message = scheduleEntry.kind === 'reminder'
        ? `${scheduleEntry.time} - ${scheduleEntry.message || 'Hatırlatıcı'}`
        : `${scheduleEntry.time} alarmı çalıyor.`;

    await chrome.notifications.create(`hades-notification:${scheduleEntry.id}:${Date.now()}`, {
        type: 'basic',
        iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sotM1gAAAAASUVORK5CYII=',
        title,
        message
    });

    await setActiveAlert(buildActiveAlert(scheduleEntry));
    await advanceScheduleEntry(scheduleEntry);
});

async function handleMessage(message = {}, sender = {}) {
    switch (message.type) {
        case 'bridge:get-settings':
            return {
                ok: true,
                settings: await getSettings()
            };
        case 'bridge:set-settings':
            return {
                ok: true,
                settings: await updateSettings(message.patch || {})
            };
        case 'bridge:get-runtime-status':
            return {
                ok: true,
                ...(await getRuntimeStatus())
            };
        case 'bridge:get-context-prompt':
            return {
                ok: true,
                ...(await getContextPrompt())
            };
        case 'bridge:get-voice-config':
            return {
                ok: true,
                ...(await getVoiceConfig())
            };
        case 'bridge:ensure-wake-main-world':
            return ensureWakeMainWorld(sender);
        case 'bridge:claim-voice-owner':
            return claimVoiceOwner(message, sender);
        case 'bridge:heartbeat-voice-owner':
            return heartbeatVoiceOwner(message, sender);
        case 'bridge:release-voice-owner':
            return releaseVoiceOwner(message, sender);
        case 'bridge:get-active-alert':
            return {
                ok: true,
                alert: await getActiveAlert()
            };
        case 'bridge:dismiss-active-alert':
            return {
                ok: true,
                ...(await dismissActiveAlert(message))
            };
        case 'bridge:open-spotify-login':
            return openSpotifyLogin();
        case 'bridge:execute-actions':
            return executeActions(message.actions || []);
        default:
            return {
                ok: false,
                error: `Bilinmeyen bridge mesajı: ${String(message?.type || 'type_yok')}`
            };
    }
}

function buildActiveAlert(entry = {}) {
    const kind = String(entry.kind || 'alarm').trim() === 'reminder' ? 'reminder' : 'alarm';
    const time = String(entry.time || '').trim();
    const reminderMessage = String(entry.message || '').trim();
    const spokenText = kind === 'reminder'
        ? `Uyan babacığım, vakit geldi. Hatırlatmam: ${reminderMessage || 'Hatırlatıcın var.'}`
        : 'Uyan babacığım, vakit geldi.';
    const detail = kind === 'reminder'
        ? `${time} hatırlatıcısı: ${reminderMessage || 'Hatırlatıcı'}`
        : `${time} alarmı çalıyor.`;

    return {
        id: String(entry.id || '').trim(),
        kind,
        time,
        message: reminderMessage,
        repeat: String(entry.repeat || 'daily').trim() || 'daily',
        active: true,
        detail,
        spokenText,
        triggeredAtISO: new Date().toISOString()
    };
}

async function readStoredActiveAlert() {
    const stored = await chrome.storage.local.get(ACTIVE_ALERT_KEY);
    const alert = stored?.[ACTIVE_ALERT_KEY];
    return alert && typeof alert === 'object' ? alert : null;
}

async function activateScheduleEntry(scheduleEntry) {
    const title = scheduleEntry.kind === 'reminder' ? 'HADES Hatırlatıcı' : 'HADES Alarm';
    const message = scheduleEntry.kind === 'reminder'
        ? `${scheduleEntry.time} - ${scheduleEntry.message || 'Hatırlatıcı'}`
        : `${scheduleEntry.time} alarmı çalıyor.`;

    await chrome.notifications.create(`hades-notification:${scheduleEntry.id}:${Date.now()}`, {
        type: 'basic',
        iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sotM1gAAAAASUVORK5CYII=',
        title,
        message
    });

    await setActiveAlert(buildActiveAlert(scheduleEntry));
    await advanceScheduleEntry(scheduleEntry);
    return readStoredActiveAlert();
}

async function ensureDueAlerts() {
    const now = Date.now();
    const dueEntries = [];

    for (const kind of ['alarm', 'reminder']) {
        const entries = await getStoredEntries(kind);
        for (const entry of entries) {
            const dueAtMs = Date.parse(String(entry.nextTriggerAtISO || '').trim());
            if (!Number.isFinite(dueAtMs) || dueAtMs > now) continue;
            dueEntries.push(entry);
        }
    }

    if (!dueEntries.length) {
        return null;
    }

    dueEntries.sort((left, right) => {
        const leftMs = Date.parse(String(left.nextTriggerAtISO || '').trim());
        const rightMs = Date.parse(String(right.nextTriggerAtISO || '').trim());
        return leftMs - rightMs;
    });

    return activateScheduleEntry(dueEntries[0]);
}

async function syncStoredEntriesFromBackend(kind) {
    const storageKey = kind === 'reminder' ? REMINDERS_KEY : ALARMS_KEY;
    const result = await requestBackend(`/bridge/schedules/${encodeURIComponent(kind)}`);
    if (!result.ok || !Array.isArray(result.data?.entries)) {
        return null;
    }

    await chrome.storage.local.set({ [storageKey]: result.data.entries });
    return result.data.entries;
}

async function getActiveAlert() {
    const backendAlert = await requestBackend('/bridge/active-alert');
    if (backendAlert.ok) {
        const nextAlert = backendAlert.data?.alert && typeof backendAlert.data.alert === 'object'
            ? backendAlert.data.alert
            : null;
        if (nextAlert) {
            await chrome.storage.local.set({ [ACTIVE_ALERT_KEY]: nextAlert });
            if (nextAlert.kind === 'alarm' || nextAlert.kind === 'reminder') {
                await syncStoredEntriesFromBackend(nextAlert.kind);
            }
            return nextAlert;
        }

        return readStoredActiveAlert();
    }

    const activeAlert = await readStoredActiveAlert();
    if (activeAlert) {
        return activeAlert;
    }

    return ensureDueAlerts();
}

async function setActiveAlert(alert = null) {
    if (!alert) {
        await chrome.storage.local.remove(ACTIVE_ALERT_KEY);
        return null;
    }

    await chrome.storage.local.set({ [ACTIVE_ALERT_KEY]: alert });
    return alert;
}

async function dismissActiveAlert(message = {}) {
    const requestedId = String(message.id || '').trim();
    const backendDismiss = await requestBackend('/bridge/active-alert/dismiss', {
        method: 'POST',
        body: {
            id: requestedId
        }
    });
    if (backendDismiss.ok && !backendDismiss.data?.alert) {
        await chrome.storage.local.remove(ACTIVE_ALERT_KEY);
        return {
            cleared: true,
            alert: null
        };
    }

    const activeAlert = await readStoredActiveAlert();
    if (!activeAlert) {
        return {
            cleared: false,
            alert: null
        };
    }

    if (requestedId && activeAlert.id && requestedId !== activeAlert.id) {
        return {
            cleared: false,
            alert: activeAlert
        };
    }

    await chrome.storage.local.remove(ACTIVE_ALERT_KEY);
    return {
        cleared: true,
        alert: null
    };
}

async function ensureWakeMainWorld(sender = {}) {
    const tabId = sender?.tab?.id;
    if (!Number.isFinite(tabId)) {
        throw new Error('Wake-word sekmesi bulunamadı.');
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (wakeBridgeUrl) => {
            const root = document.head || document.documentElement;
            const signalReady = () => {
                if (document.documentElement) {
                    document.documentElement.dataset.hadesWakeBridge = 'ready';
                }
                window.postMessage({
                    __hadesWakeBridge: true,
                    direction: 'to-content',
                    type: 'ready'
                }, '*');
            };

            if (typeof window.__hadesWakeBridgeEmitReady === 'function') {
                window.__hadesWakeBridgeEmitReady();
                return;
            }

            if (window.__hadesWakeBridgeLoaded) {
                signalReady();
                return;
            }

            if (!root) return;

            const existing = root.querySelector('script[data-hades-wake-bridge="true"]');
            if (existing) {
                existing.remove();
            }

            const script = document.createElement('script');
            script.dataset.hadesWakeBridge = 'true';
            script.src = wakeBridgeUrl;
            script.async = false;
            script.addEventListener('load', () => {
                if (typeof window.__hadesWakeBridgeEmitReady === 'function') {
                    window.__hadesWakeBridgeEmitReady();
                    return;
                }
                if (window.__hadesWakeBridgeLoaded) {
                    signalReady();
                }
            }, { once: true });
            root.appendChild(script);
        },
        args: [chrome.runtime.getURL('wake-bridge.js')]
    });

    return {
        ok: true
    };
}

function getLiveVoiceOwner() {
    if (!voiceOwner) return null;
    if (Date.now() - voiceOwner.updatedAt > VOICE_OWNER_TTL_MS) {
        voiceOwner = null;
        return null;
    }
    return voiceOwner;
}

function assignVoiceOwner(sender = {}, instanceId = '', visible = false) {
    voiceOwner = {
        instanceId,
        tabId: sender?.tab?.id ?? null,
        windowId: sender?.tab?.windowId ?? null,
        visible: Boolean(visible),
        updatedAt: Date.now()
    };

    return voiceOwner;
}

function isSameVoiceOwner(owner, sender = {}, instanceId = '') {
    if (!owner) return false;
    if (owner.instanceId && instanceId && owner.instanceId === instanceId) return true;
    if (owner.tabId !== null && sender?.tab?.id !== undefined && owner.tabId === sender.tab.id) return true;
    return false;
}

async function claimVoiceOwner(message = {}, sender = {}) {
    const instanceId = String(message.instanceId || '').trim();
    if (!instanceId) {
        throw new Error('Voice owner instanceId gerekli.');
    }

    const visible = Boolean(message.visible);
    const current = getLiveVoiceOwner();
    const canTakeOwnership = !current || isSameVoiceOwner(current, sender, instanceId) || visible;
    const next = canTakeOwnership
        ? assignVoiceOwner(sender, instanceId, visible)
        : current;

    return {
        ok: true,
        owner: next.instanceId === instanceId,
        state: next
    };
}

async function heartbeatVoiceOwner(message = {}, sender = {}) {
    const instanceId = String(message.instanceId || '').trim();
    if (!instanceId) {
        return {
            ok: false,
            owner: false,
            error: 'Voice owner instanceId gerekli.'
        };
    }

    const visible = Boolean(message.visible);
    const current = getLiveVoiceOwner();
    if (!current || !isSameVoiceOwner(current, sender, instanceId)) {
        return {
            ok: true,
            owner: false,
            state: current
        };
    }

    return {
        ok: true,
        owner: true,
        state: assignVoiceOwner(sender, instanceId, visible)
    };
}

async function releaseVoiceOwner(message = {}, sender = {}) {
    const instanceId = String(message.instanceId || '').trim();
    const current = getLiveVoiceOwner();
    if (current && isSameVoiceOwner(current, sender, instanceId)) {
        voiceOwner = null;
        return {
            ok: true,
            released: true
        };
    }

    return {
        ok: true,
        released: false
    };
}

async function ensureSettings() {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    if (stored && stored[SETTINGS_KEY]) return stored[SETTINGS_KEY];
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    return DEFAULT_SETTINGS;
}

async function getSettings() {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return {
        ...DEFAULT_SETTINGS,
        ...(stored?.[SETTINGS_KEY] || {})
    };
}

async function updateSettings(patch = {}) {
    const current = await getSettings();
    const next = {
        ...current,
        ...patch
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
}

async function getRuntimeStatus() {
    const health = await requestBackend('/health');
    const spotify = await requestBackend('/spotify/status');

    return {
        backendOk: Boolean(health.ok),
        health: health.ok ? health.data : null,
        spotify: spotify.ok ? spotify.data : null,
        backendError: health.ok ? null : (health.error || health.data?.message || 'Backend bağlanamadı.')
    };
}

async function getContextPrompt() {
    const context = await requestBackend('/bridge/context');
    if (!context.ok) {
        throw new Error(context.error || context.data?.message || 'Bridge context alınamadı.');
    }

    return {
        context: context.data,
        prompt: context.data?.prompt || ''
    };
}

async function getVoiceConfig() {
    const config = await requestBackend('/bridge/voice-config');
    if (!config.ok) {
        throw new Error(config.error || config.data?.message || 'Voice config alınamadı.');
    }

    return config.data || {};
}

async function openSpotifyLogin() {
    const status = await requestBackend('/spotify/status');
    const authenticated = Boolean(status.ok && (status.data?.authenticated ?? status.data?.ready));

    if (authenticated) {
        const prepared = await requestBackend('/spotify/prepare', {
            method: 'POST'
        });

        if (prepared.ok) {
            return {
                ok: true,
                prepared: true,
                status: prepared.data?.status || null,
                message: prepared.data?.message || 'Spotify cihazi hazirlandi.'
            };
        }

        if (prepared.status === 401) {
            const windowInfo = await chrome.windows.create({
                url: `${BACKEND_CANDIDATES[0]}/spotify/login`,
                type: 'popup',
                width: 1100,
                height: 880,
                focused: true
            });

            return {
                ok: true,
                windowId: windowInfo?.id || null,
                message: 'Spotify oturumu yenileme penceresi açıldı.'
            };
        }

        return {
            ok: false,
            error: prepared.error || prepared.data?.message || 'Spotify hazirlanamadi.'
        };
    }

    const windowInfo = await chrome.windows.create({
        url: `${BACKEND_CANDIDATES[0]}/spotify/login`,
        type: 'popup',
        width: 1100,
        height: 880,
        focused: true
    });

    return {
        ok: true,
        windowId: windowInfo?.id || null,
        message: 'Spotify bağlantı penceresi açıldı.'
    };
}

async function executeActions(actions = []) {
    const results = [];
    for (const action of Array.isArray(actions) ? actions : []) {
        results.push(await executeSingleAction(action));
    }

    return {
        ok: results.every((entry) => entry.ok),
        results
    };
}

async function executeSingleAction(rawAction = {}) {
    const tool = String(rawAction.tool || rawAction.name || '').trim();
    const args = rawAction.args && typeof rawAction.args === 'object' ? rawAction.args : {};

    try {
        switch (tool) {
            case 'health.get':
                return normalizeBackendResult(tool, await requestBackend('/health'));
            case 'project.context':
                return normalizeBackendResult(tool, await requestBackend('/bridge/context'));
            case 'light.control':
                return normalizeBackendResult(tool, await requestBackend('/light', {
                    method: 'POST',
                    body: args
                }));
            case 'light.status':
                return normalizeBackendResult(tool, await requestBackend('/light/status'));
            case 'spotify.status':
                return normalizeBackendResult(tool, await requestBackend('/spotify/status'));
            case 'spotify.login':
                return {
                    tool,
                    ...(await openSpotifyLogin())
                };
            case 'spotify.play':
                return normalizeBackendResult(tool, await requestBackend('/spotify/play', {
                    method: 'POST',
                    body: args
                }));
            case 'spotify.control':
                return normalizeBackendResult(tool, await requestBackend('/spotify/control', {
                    method: 'POST',
                    body: args
                }));
            case 'web.search':
                return normalizeBackendResult(tool, await requestBackend('/web/search', {
                    method: 'POST',
                    body: {
                        query: args.query
                    }
                }));
            case 'finance.rate': {
                const base = encodeURIComponent(String(args.base || 'USD').trim().toUpperCase());
                const quote = encodeURIComponent(String(args.quote || 'TRY').trim().toUpperCase());
                return normalizeBackendResult(tool, await requestBackend(`/finance/rate?base=${base}&quote=${quote}`));
            }
            case 'alarm.set':
                return buildSuccess(tool, await createScheduleEntry('alarm', args));
            case 'alarm.list':
                return buildSuccess(tool, await listScheduleEntries('alarm'));
            case 'alarm.delete':
                return buildSuccess(tool, await deleteScheduleEntry('alarm', args));
            case 'alarm.delete_all':
                return buildSuccess(tool, await deleteAllScheduleEntries('alarm'));
            case 'reminder.set':
                return buildSuccess(tool, await createScheduleEntry('reminder', args));
            case 'reminder.list':
                return buildSuccess(tool, await listScheduleEntries('reminder'));
            case 'reminder.delete':
                return buildSuccess(tool, await deleteScheduleEntry('reminder', args));
            case 'reminder.delete_all':
                return buildSuccess(tool, await deleteAllScheduleEntries('reminder'));
            default:
                return {
                    tool,
                    ok: false,
                    error: `Bilinmeyen tool: ${tool}`
                };
        }
    } catch (error) {
        return {
            tool,
            ok: false,
            error: error.message || String(error)
        };
    }
}

function buildSuccess(tool, data) {
    return {
        tool,
        ok: true,
        data
    };
}

function normalizeBackendResult(tool, result = {}) {
    return {
        tool,
        ok: Boolean(result.ok),
        status: result.status || null,
        data: result.data || null,
        error: result.ok ? null : (result.error || result.data?.message || 'Yerel backend isteği başarısız.')
    };
}

async function requestBackend(pathname, options = {}) {
    let lastError = null;
    for (const baseUrl of BACKEND_CANDIDATES) {
        try {
            const requestInit = {
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...(options.headers || {})
                }
            };

            if (options.body !== undefined) {
                requestInit.body = JSON.stringify(options.body);
            }

            const response = await fetch(`${baseUrl}${pathname}`, requestInit);
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            const payload = contentType.includes('application/json')
                ? await response.json()
                : await response.text();

            return {
                ok: response.ok,
                status: response.status,
                data: payload,
                error: response.ok ? null : (payload?.message || (typeof payload === 'string' ? payload : `HTTP ${response.status}`))
            };
        } catch (error) {
            lastError = error;
        }
    }

    return {
        ok: false,
        status: 0,
        data: null,
        error: lastError?.message || 'Yerel backend bağlanamadı.'
    };
}

function normalizeTime(value = '') {
    const raw = String(value || '').trim();
    const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
        throw new Error('Saat HH:MM formatında olmalıdır.');
    }
    return `${String(parseInt(match[1], 10)).padStart(2, '0')}:${match[2]}`;
}

function normalizeRepeat(value = '', fallback = 'daily') {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'once' || raw === 'tek-sefer' || raw === 'tek_sefer') return 'once';
    if (raw === 'daily' || raw === 'gunluk' || raw === 'günlük') return 'daily';
    return fallback;
}

function normalizeScheduleText(value = '') {
    return String(value || '')
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/[^\w\s:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseRelativeNumberToken(token = '') {
    const normalized = String(token || '').trim();
    if (!normalized) return 0;
    if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);

    const tokens = {
        bir: 1,
        iki: 2,
        uc: 3,
        dort: 4,
        bes: 5,
        alti: 6,
        yedi: 7,
        sekiz: 8,
        dokuz: 9,
        on: 10,
        onbir: 11,
        oniki: 12,
        onbes: 15,
        yirmi: 20,
        otuz: 30,
        kirk: 40,
        elli: 50,
        altmis: 60
    };

    return tokens[normalized] || 0;
}

function formatLocalTime(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function parseRelativeScheduleTime(value = '') {
    const normalized = normalizeScheduleText(value)
        .replace(/\bon bir\b/g, 'onbir')
        .replace(/\bon iki\b/g, 'oniki')
        .replace(/\bon bes\b/g, 'onbes');
    if (!normalized) return null;

    if (/\byarim saat\b/.test(normalized) || /\bhalf hour\b/.test(normalized)) {
        return {
            date: new Date(Date.now() + (30 * 60 * 1000)),
            repeat: 'once'
        };
    }

    const match = normalized.match(/\b(\d+|bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|onbir|oniki|onbes|yirmi|otuz|kirk|elli|altmis)\s*(dakika|dk|min|minute|minutes|saat|hour|hours)\b/);
    if (!match) return null;

    const amount = parseRelativeNumberToken(match[1]);
    if (!amount) return null;

    const unit = match[2];
    const deltaMs = /saat|hour/.test(unit)
        ? amount * 60 * 60 * 1000
        : amount * 60 * 1000;
    return {
        date: new Date(Date.now() + deltaMs),
        repeat: 'once'
    };
}

function buildEntryId(kind, time, message = '') {
    const slug = String(message || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    return slug ? `hades:${kind}:${time}:${slug}` : `hades:${kind}:${time}`;
}

async function getStoredEntries(kind) {
    const storageKey = kind === 'reminder' ? REMINDERS_KEY : ALARMS_KEY;
    const stored = await chrome.storage.local.get(storageKey);
    const localEntries = Array.isArray(stored?.[storageKey]) ? stored[storageKey] : [];
    const result = await requestBackend(`/bridge/schedules/${encodeURIComponent(kind)}`);

    if (result.ok && Array.isArray(result.data?.entries)) {
        const backendEntries = result.data.entries;
        await chrome.storage.local.set({ [storageKey]: backendEntries });
        return backendEntries;
    }

    return localEntries;
}

async function setStoredEntries(kind, entries, options = {}) {
    const storageKey = kind === 'reminder' ? REMINDERS_KEY : ALARMS_KEY;
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    const result = await requestBackend(`/bridge/schedules/${encodeURIComponent(kind)}`, {
        method: 'PUT',
        body: {
            entries: normalizedEntries
        }
    });

    if (!result.ok && !options.allowLocalOnly) {
        throw new Error(result.error || 'Yerel zamanlama veritabanı güncellenemedi.');
    }

    const nextEntries = result.ok && Array.isArray(result.data?.entries)
        ? result.data.entries
        : normalizedEntries;

    await chrome.storage.local.set({ [storageKey]: nextEntries });
    return nextEntries;
}

function computeClockOccurrenceMs(time, nowInput = Date.now()) {
    const [hour, minute] = String(time || '').split(':').map((item) => parseInt(item, 10));
    const now = new Date(typeof nowInput === 'number' ? nowInput : Date.now());
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime();
}

function computeNextOccurrenceMs(entryOrTime) {
    if (entryOrTime && typeof entryOrTime === 'object') {
        const nextTriggerAtISO = String(entryOrTime.nextTriggerAtISO || '').trim();
        const nextTriggerAtMs = nextTriggerAtISO ? Date.parse(nextTriggerAtISO) : Number.NaN;
        if (Number.isFinite(nextTriggerAtMs) && nextTriggerAtMs > Date.now()) {
            return nextTriggerAtMs;
        }
        return computeClockOccurrenceMs(entryOrTime.time);
    }

    return computeClockOccurrenceMs(entryOrTime);
}

function resolveScheduleInput(rawTime = '', repeat = '') {
    const relative = parseRelativeScheduleTime(rawTime);
    if (relative) {
        return {
            time: formatLocalTime(relative.date),
            repeat: normalizeRepeat(repeat, relative.repeat),
            nextTriggerAtISO: relative.date.toISOString(),
            relative: true
        };
    }

    const time = normalizeTime(rawTime);
    return {
        time,
        repeat: normalizeRepeat(repeat, 'daily'),
        nextTriggerAtISO: null,
        relative: false
    };
}

function normalizeScheduleLookupTime(rawTime = '') {
    return resolveScheduleInput(rawTime, 'once').time;
}

async function scheduleLocalEntry(entry) {
    await chrome.alarms.create(entry.id, {
        when: computeNextOccurrenceMs(entry)
    });
}

async function createScheduleEntry(kind, args = {}) {
    const schedule = resolveScheduleInput(args.time, args.repeat);
    const time = schedule.time;
    const message = String(args.message || '').trim();
    const nextTriggerAtISO = schedule.nextTriggerAtISO || new Date(computeNextOccurrenceMs(time)).toISOString();
    if (kind === 'reminder' && !message) {
        throw new Error('Hatırlatıcı için message gereklidir.');
    }

    const entries = await getStoredEntries(kind);
    const entryId = buildEntryId(kind, time, message);
    const existing = entries.find((item) => item.id === entryId);
    if (existing) {
        const updatedExisting = {
            ...existing,
            time,
            repeat: schedule.repeat,
            nextTriggerAtISO
        };
        await setStoredEntries(kind, entries.map((item) => item.id === entryId ? updatedExisting : item));
        await scheduleLocalEntry(updatedExisting);
        return {
            message: `${kind === 'reminder' ? 'Hatırlatıcı' : 'Alarm'} zaten vardı, tekrar zamanlandı.`,
            entry: updatedExisting
        };
    }

    const nextEntry = {
        id: entryId,
        kind,
        time,
        message,
        repeat: schedule.repeat,
        nextTriggerAtISO,
        createdAtISO: new Date().toISOString()
    };

    entries.push(nextEntry);
    await setStoredEntries(kind, entries);
    await scheduleLocalEntry(nextEntry);

    return {
        message: `${kind === 'reminder' ? 'Hatırlatıcı' : 'Alarm'} ${time} için kaydedildi.`,
        entry: nextEntry
    };
}

async function listScheduleEntries(kind) {
    const entries = await getStoredEntries(kind);
    return {
        count: entries.length,
        entries: [...entries]
            .map((entry) => ({
                ...entry,
                nextTriggerAtISO: entry.nextTriggerAtISO || new Date(computeNextOccurrenceMs(entry)).toISOString()
            }))
            .sort((a, b) => {
                const diff = computeNextOccurrenceMs(a) - computeNextOccurrenceMs(b);
                if (diff !== 0) return diff;
                if (a.time !== b.time) return a.time.localeCompare(b.time);
                return String(a.message || '').localeCompare(String(b.message || ''));
            })
    };
}

async function deleteScheduleEntry(kind, args = {}) {
    const time = normalizeScheduleLookupTime(args.time);
    const messageFilter = String(args.message || '').trim();
    const entries = await getStoredEntries(kind);
    const matches = (item) => {
        if (item.time !== time) return false;
        if (!messageFilter) return true;
        return String(item.message || '').trim().toLocaleLowerCase('tr-TR') === messageFilter.toLocaleLowerCase('tr-TR');
    };
    const remaining = entries.filter((item) => !matches(item));
    const removed = entries.filter((item) => matches(item));

    if (removed.length === 0) {
        return {
            message: `${time} için silinecek bir ${kind === 'reminder' ? 'hatırlatıcı' : 'alarm'} bulunamadı.`,
            removedCount: 0
        };
    }

    await Promise.all(removed.map((item) => chrome.alarms.clear(item.id)));
    await setStoredEntries(kind, remaining);
    const activeAlert = await getActiveAlert();
    if (activeAlert && activeAlert.kind === kind && activeAlert.time === time) {
        await chrome.storage.local.remove(ACTIVE_ALERT_KEY);
    }

    return {
        message: `${time} için ${removed.length} kayıt silindi.`,
        removedCount: removed.length
    };
}

async function deleteAllScheduleEntries(kind) {
    const entries = await getStoredEntries(kind);
    await Promise.all(entries.map((item) => chrome.alarms.clear(item.id)));
    await setStoredEntries(kind, []);
    const activeAlert = await getActiveAlert();
    if (activeAlert && activeAlert.kind === kind) {
        await chrome.storage.local.remove(ACTIVE_ALERT_KEY);
    }

    return {
        message: `${entries.length} adet ${kind === 'reminder' ? 'hatırlatıcı' : 'alarm'} silindi.`,
        removedCount: entries.length
    };
}

async function advanceScheduleEntry(entry = {}) {
    const kind = String(entry.kind || '').trim();
    if (!kind) return;

    const entries = await getStoredEntries(kind);
    const target = entries.find((item) => item.id === entry.id);
    if (!target) return;

    if (String(target.repeat || 'daily').trim() === 'once') {
        await chrome.alarms.clear(target.id);
        await setStoredEntries(kind, entries.filter((item) => item.id !== target.id));
        return;
    }

    const nextEntry = {
        ...target,
        nextTriggerAtISO: null
    };
    const nextWhen = computeClockOccurrenceMs(nextEntry.time);
    nextEntry.nextTriggerAtISO = new Date(nextWhen).toISOString();
    await setStoredEntries(kind, entries.map((item) => item.id === target.id ? nextEntry : item));
    await scheduleLocalEntry(nextEntry);
}

async function findScheduleEntry(entryId) {
    const alarms = await getStoredEntries('alarm');
    const reminders = await getStoredEntries('reminder');
    return [...alarms, ...reminders].find((item) => item.id === entryId) || null;
}

async function resyncAllSchedules() {
    const alarms = await getStoredEntries('alarm');
    const reminders = await getStoredEntries('reminder');
    const nextByKind = new Map([
        ['alarm', []],
        ['reminder', []]
    ]);

    for (const entry of [...alarms, ...reminders]) {
        const normalizedEntry = {
            ...entry,
            nextTriggerAtISO: entry.nextTriggerAtISO || new Date(computeNextOccurrenceMs(entry)).toISOString()
        };

        nextByKind.get(normalizedEntry.kind)?.push(normalizedEntry);
        if (String(entry.repeat || 'daily').trim() === 'once') {
            const when = computeNextOccurrenceMs(normalizedEntry);
            if (!Number.isFinite(when) || when <= Date.now()) {
                continue;
            }
        }

        await scheduleLocalEntry(normalizedEntry);
    }

    await setStoredEntries('alarm', nextByKind.get('alarm') || [], { allowLocalOnly: true });
    await setStoredEntries('reminder', nextByKind.get('reminder') || [], { allowLocalOnly: true });
}
