// server.js

const express = require('express');
const TuyaDevice = require('tuyapi');
const SpotifyWebApi = require('spotify-web-api-node');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const { buildBridgeContextPayload } = require('./app/hades-bridge-profile');
// const alarmManager = require('./alarmManager');

function loadEnvFromFile(envPath) {
    if (!fs.existsSync(envPath)) return;
    try {
        const raw = fs.readFileSync(envPath, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = String(line || '').trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex <= 0) continue;
            const key = trimmed.slice(0, eqIndex).trim();
            if (!key) continue;
            if (typeof process.env[key] === 'string' && process.env[key].trim()) continue;
            let value = trimmed.slice(eqIndex + 1).trim();
            value = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
            process.env[key] = value;
        }
    } catch (error) {
        console.warn(`[ENV] .env okunamadi: ${error.message}`);
    }
}

function loadEnvFromKnownLocations() {
    const candidates = [
        path.join(path.dirname(process.execPath || ''), '.env'),
        path.join(process.cwd(), '.env'),
        path.join(__dirname, '.env'),
        process.resourcesPath ? path.join(process.resourcesPath, '.env') : null
    ].filter(Boolean);

    const visited = new Set();
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (visited.has(resolved)) continue;
        visited.add(resolved);
        loadEnvFromFile(resolved);
    }
}

loadEnvFromKnownLocations();

const app = express();
const DEFAULT_PORT = Number(process.env.PORT || 3001);
const TUYA_CONFIGURED_IP = process.env.TUYA_DEVICE_IP || '192.168.1.11';
const TUYA_DEVICE_ID = process.env.TUYA_DEVICE_ID || '';
const TUYA_DEVICE_KEY = process.env.TUYA_DEVICE_KEY || '';
const TUYA_DEVICE_VERSION = process.env.TUYA_DEVICE_VERSION || '3.3';
const isTuyaConfigured = Boolean(TUYA_DEVICE_ID && TUYA_DEVICE_KEY);

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/spotify/callback';
const isSpotifyConfigured = Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const isDeepgramConfigured = Boolean(DEEPGRAM_API_KEY);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const isOpenAiConfigured = Boolean(OPENAI_API_KEY);
const HADES_REMOTE_DEBUG_PORT = Number(process.env.HADES_REMOTE_DEBUG_PORT || 9222);
const isNativeBridgeVoiceEnabled = String(process.env.HADES_NATIVE_BRIDGE_VOICE || '0').trim() === '1';

// --- Lamba Bilgileri ---
const device = isTuyaConfigured
    ? new TuyaDevice({
        id: TUYA_DEVICE_ID,
        key: TUYA_DEVICE_KEY,
        ip: TUYA_CONFIGURED_IP,
        version: TUYA_DEVICE_VERSION
    })
    : null;

app.use(cors());
app.use(express.json());

const FX_CACHE_TTL_MS = 30 * 1000;
const fxCache = new Map();
const CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;
const WEB_CACHE_TTL_MS = 90 * 1000;
const webSearchCache = new Map();
const defaultVoiceOverlayState = () => ({
    chip: 'Ses hazır',
    tone: 'ok',
    detail: '"HADES" deyince dinlemeye başlayacak.',
    mode: 'idle',
    meter: 0,
    updatedAt: new Date().toISOString()
});
const defaultOpsBrowserState = () => ({
    url: 'https://www.google.com/',
    title: 'Hazir',
    source: 'system',
    reason: 'startup',
    query: '',
    updatedAt: new Date().toISOString()
});
const defaultOpsUiState = () => ({
    browserPanelVisible: true,
    updatedAt: new Date().toISOString()
});
let voiceOverlayState = defaultVoiceOverlayState();
let opsBrowserState = defaultOpsBrowserState();
let opsUiState = defaultOpsUiState();
const OPS_EVENT_LIMIT = 160;
const opsEventLog = [];
let nativeTtsProcess = null;
let bridgeWsServer = null;
let wakeWsServer = null;
let opsWsServer = null;
const replyEventClients = new Map();
const wakeEventClients = new Map();
const opsEventClients = new Set();
const backendReplyWatches = new Map();
let nativeWakeProcess = null;
let nativeWakeState = {
    instanceId: '',
    sessionId: '',
    locale: 'tr-TR',
    wakeWord: 'HADES',
    runtime: 'python'
};
let nativeWakeSupportCache = null;
let nativeTtsSupportCache = null;
let nativeWakeRuntimeCache = null;
const NATIVE_WAKE_VARIANTS = Object.freeze([
    'hades',
    'hedes',
    'ades',
    'ha des',
    'hds',
    'hadez',
    'adez',
    'haydes',
    'heydes',
    'hadis',
    'hadiz',
    'hedis',
    'hediz',
    'hedez',
    'heydis',
    'heydiz'
]);
const VOICE_RUNTIME_ROOT = path.join(__dirname, 'app', 'voice-runtime');
const VOICE_PYTHON = process.platform === 'win32'
    ? path.join(__dirname, '.venv-voice', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv-voice', 'bin', 'python');
const TTS_OUTPUT_DIR = path.join(__dirname, '.voice-cache', 'tts');
const TTS_FILE_TTL_MS = 10 * 60 * 1000;
const generatedTtsFiles = new Map();
const SCHEDULE_DB_PATH = process.env.HADES_SCHEDULE_DB_PATH || path.join(__dirname, 'hades-schedule-db.json');
const SCHEDULE_KIND_MAP = Object.freeze({
    alarm: 'alarms',
    reminder: 'reminders'
});
let activeScheduleAlert = null;

function defaultScheduleDb() {
    return {
        alarms: [],
        reminders: []
    };
}

function normalizeScheduleKind(kind = '') {
    const value = String(kind || '').trim().toLowerCase();
    return value === 'alarm' || value === 'reminder' ? value : '';
}

function getScheduleCollectionKey(kind = '') {
    const normalizedKind = normalizeScheduleKind(kind);
    return normalizedKind ? SCHEDULE_KIND_MAP[normalizedKind] : '';
}

function sanitizeScheduleEntry(rawEntry = {}, kind = '') {
    const normalizedKind = normalizeScheduleKind(rawEntry.kind || kind);
    const id = String(rawEntry.id || '').trim();
    const time = String(rawEntry.time || '').trim();
    if (!normalizedKind || !id || !time) return null;

    const repeat = String(rawEntry.repeat || 'daily').trim().toLowerCase() === 'once' ? 'once' : 'daily';
    const nextTriggerAtISO = String(rawEntry.nextTriggerAtISO || '').trim();
    const createdAtISO = String(rawEntry.createdAtISO || '').trim() || new Date().toISOString();

    return {
        id,
        kind: normalizedKind,
        time,
        message: String(rawEntry.message || '').trim(),
        repeat,
        nextTriggerAtISO: nextTriggerAtISO || null,
        createdAtISO
    };
}

function readScheduleDb() {
    if (!fs.existsSync(SCHEDULE_DB_PATH)) {
        return defaultScheduleDb();
    }

    try {
        const raw = fs.readFileSync(SCHEDULE_DB_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const next = defaultScheduleDb();

        for (const kind of Object.keys(SCHEDULE_KIND_MAP)) {
            const collectionKey = SCHEDULE_KIND_MAP[kind];
            const source = Array.isArray(parsed?.[collectionKey]) ? parsed[collectionKey] : [];
            next[collectionKey] = source
                .map((entry) => sanitizeScheduleEntry(entry, kind))
                .filter(Boolean);
        }

        return next;
    } catch (error) {
        console.warn(`Zamanlama veritabanı okunamadı: ${error.message}`);
        return defaultScheduleDb();
    }
}

function writeScheduleDb(db = defaultScheduleDb()) {
    const next = defaultScheduleDb();

    for (const kind of Object.keys(SCHEDULE_KIND_MAP)) {
        const collectionKey = SCHEDULE_KIND_MAP[kind];
        const source = Array.isArray(db?.[collectionKey]) ? db[collectionKey] : [];
        next[collectionKey] = source
            .map((entry) => sanitizeScheduleEntry(entry, kind))
            .filter(Boolean);
    }

    fs.writeFileSync(SCHEDULE_DB_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function getScheduleEntries(kind = '') {
    const collectionKey = getScheduleCollectionKey(kind);
    if (!collectionKey) {
        throw new Error('Geçersiz zamanlama türü.');
    }

    const db = readScheduleDb();
    return Array.isArray(db[collectionKey]) ? db[collectionKey] : [];
}

function setScheduleEntries(kind = '', entries = []) {
    const collectionKey = getScheduleCollectionKey(kind);
    if (!collectionKey) {
        throw new Error('Geçersiz zamanlama türü.');
    }

    const db = readScheduleDb();
    db[collectionKey] = Array.isArray(entries)
        ? entries.map((entry) => sanitizeScheduleEntry(entry, kind)).filter(Boolean)
        : [];

    return writeScheduleDb(db)[collectionKey];
}

function computeClockOccurrenceMsForSchedule(time = '', nowInput = Date.now()) {
    const [hour, minute] = String(time || '').split(':').map((item) => parseInt(item, 10));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return Number.NaN;

    const now = new Date(typeof nowInput === 'number' ? nowInput : Date.now());
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime();
}

function computeNextScheduleOccurrenceMs(entry = {}) {
    const nextTriggerAtISO = String(entry.nextTriggerAtISO || '').trim();
    const nextTriggerAtMs = nextTriggerAtISO ? Date.parse(nextTriggerAtISO) : Number.NaN;
    if (Number.isFinite(nextTriggerAtMs)) {
        return nextTriggerAtMs;
    }

    return computeClockOccurrenceMsForSchedule(entry.time);
}

function buildScheduleAlert(entry = {}) {
    const kind = normalizeScheduleKind(entry.kind || 'alarm') || 'alarm';
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

function takeDueScheduleAlert() {
    if (activeScheduleAlert) {
        return activeScheduleAlert;
    }

    const nowMs = Date.now();
    const db = readScheduleDb();
    const dueEntries = [];

    for (const kind of Object.keys(SCHEDULE_KIND_MAP)) {
        const collectionKey = SCHEDULE_KIND_MAP[kind];
        const entries = Array.isArray(db[collectionKey]) ? db[collectionKey] : [];
        for (const entry of entries) {
            const nextOccurrenceMs = computeNextScheduleOccurrenceMs(entry);
            if (!Number.isFinite(nextOccurrenceMs) || nextOccurrenceMs > nowMs) continue;
            dueEntries.push({ ...entry, kind });
        }
    }

    if (!dueEntries.length) {
        return null;
    }

    dueEntries.sort((left, right) => computeNextScheduleOccurrenceMs(left) - computeNextScheduleOccurrenceMs(right));
    const target = dueEntries[0];
    const collectionKey = getScheduleCollectionKey(target.kind);
    const currentEntries = Array.isArray(db[collectionKey]) ? db[collectionKey] : [];

    if (String(target.repeat || 'daily').trim() === 'once') {
        db[collectionKey] = currentEntries.filter((entry) => entry.id !== target.id);
    } else {
        const nextTriggerAtISO = new Date(computeClockOccurrenceMsForSchedule(target.time)).toISOString();
        db[collectionKey] = currentEntries.map((entry) => entry.id === target.id ? {
            ...entry,
            nextTriggerAtISO
        } : entry);
    }

    writeScheduleDb(db);
    activeScheduleAlert = buildScheduleAlert(target);
    return activeScheduleAlert;
}

function dismissScheduleAlert(alertId = '') {
    const requestedId = String(alertId || '').trim();
    if (!activeScheduleAlert) {
        return null;
    }

    if (requestedId && activeScheduleAlert.id && requestedId !== activeScheduleAlert.id) {
        return activeScheduleAlert;
    }

    activeScheduleAlert = null;
    return null;
}

const normalizeSearchQuery = (value = '') => String(value).replace(/\s+/g, ' ').trim();
const normalizeTr = (text = '') => String(text)
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();

const ASSISTANT_FLUFF_REGEX = /\b(hades|aferin|kral|oglum|oğlum|lan|lutfen|lütfen|abi|kanka|dostum|babacigim|babacığım)\b/gi;
const SEARCH_STOPWORDS = new Set(['ve', 'ile', 'icin', 'için', 'bir', 'bu', 'su', 'şu', 'mi', 'mu', 'mı', 'mü']);

const optimizeSearchQuery = (rawQuery = '') => {
    const base = normalizeSearchQuery(rawQuery);
    if (!base) return '';

    const stripped = base
        .replace(/[!?]+/g, ' ')
        .replace(ASSISTANT_FLUFF_REGEX, ' ')
        .replace(/\b(iyi bak|iyi araştır|tekrar ara|tekrar bak|yeniden ara)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return stripped || base;
};

const detectWebIntent = (query = '') => {
    const normalized = normalizeTr(query);
    const hasVideoTerm = /\b(video\w*|klip\w*|icerik\w*|belgesel\w*)\b/.test(normalized);
    const hasChannelTerm = /\b(kanal\w*|channel\w*)\b/.test(normalized);
    const latestVideo = /\b(en\s+son|latest|newest|son\s+video\w*|son\s+attigi\s+video\w*|son\s+yukledigi\s+video\w*)\b/.test(normalized)
        || (/\bson\b/.test(normalized) && hasVideoTerm);
    let wantsYoutube = /\b(youtube|yt)\b/.test(normalized)
        || hasChannelTerm
        || (hasVideoTerm && /\b(ac|izle|oynat|goster|bul)\b/.test(normalized))
        || /\bbelgesel\b/.test(normalized);
    if (latestVideo) wantsYoutube = true;
    const officialChannel = wantsYoutube && (/\b(resmi|official)\b/.test(normalized) || hasChannelTerm || /\bbelgesel\b/.test(normalized));
    const wantsLink = /\b(link|adres|url)\b/.test(normalized);

    return { officialChannel, latestVideo, wantsLink, wantsYoutube };
};

const decodeHtmlEntities = (value = '') => String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));

const stripHtml = (value = '') => decodeHtmlEntities(String(value).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const normalizeResultUrl = (value = '') => {
    const raw = String(value || '').trim();
    if (!raw) return '';

    try {
        const parsed = new URL(raw, 'https://duckduckgo.com');
        const redirected = parsed.searchParams.get('uddg');
        if (redirected) {
            return decodeURIComponent(redirected);
        }
        return parsed.href;
    } catch (_) {
        return raw;
    }
};

const flattenDuckDuckGoTopics = (topics = []) => {
    const results = [];
    for (const topic of Array.isArray(topics) ? topics : []) {
        if (topic && Array.isArray(topic.Topics)) {
            results.push(...flattenDuckDuckGoTopics(topic.Topics));
            continue;
        }
        const title = stripHtml(topic?.Text || '');
        const url = normalizeResultUrl(topic?.FirstURL || '');
        if (!title || !url) continue;
        results.push({ title, url, snippet: title });
    }
    return results;
};

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function sanitizeOverlayState(payload = {}) {
    const next = {
        ...voiceOverlayState,
        chip: String(payload.chip || voiceOverlayState.chip || '').trim() || 'Ses hazır',
        tone: String(payload.tone || voiceOverlayState.tone || 'ok').trim() === 'warn' ? 'warn' : 'ok',
        detail: String(payload.detail || voiceOverlayState.detail || '').trim() || '"HADES" deyince dinlemeye başlayacak.',
        mode: String(payload.mode || voiceOverlayState.mode || 'idle').trim() || 'idle',
        meter: clampNumber(payload.meter, 0, 100),
        updatedAt: new Date().toISOString()
    };

    voiceOverlayState = next;
    return next;
}

function normalizeOpsEventPayload(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return {};
    }
    return JSON.parse(JSON.stringify(payload));
}

function pruneOpsEvents() {
    if (opsEventLog.length <= OPS_EVENT_LIMIT) return;
    opsEventLog.splice(0, opsEventLog.length - OPS_EVENT_LIMIT);
}

function broadcastOpsEvent(event = {}) {
    const serialized = JSON.stringify({
        type: 'ops:event',
        event
    });
    for (const socket of [...opsEventClients]) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            opsEventClients.delete(socket);
            continue;
        }
        try {
            socket.send(serialized);
        } catch (_) {
            opsEventClients.delete(socket);
        }
    }
}

function pushOpsEvent(type = '', payload = {}) {
    const safeType = String(type || '').trim() || 'ops.unknown';
    const event = {
        id: `ops_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        type: safeType,
        at: new Date().toISOString(),
        payload: normalizeOpsEventPayload(payload)
    };
    opsEventLog.push(event);
    pruneOpsEvents();
    broadcastOpsEvent(event);
    return event;
}

function normalizeOpsBrowserUrl(rawUrl = '') {
    const value = String(rawUrl || '').trim();
    if (!value) return '';

    try {
        const parsed = new URL(value);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.toString();
        }
    } catch (_) {
        // Duz alan adlarini veya arama sorgularini asagida ele al.
    }

    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(value)) {
        return `https://${value}`;
    }

    return '';
}

function extractOpsBrowserIntentInput(input = {}) {
    const rawUrl = String(input.url || '').trim();
    const directUrl = normalizeOpsBrowserUrl(rawUrl);
    const rawQuery = normalizeSearchQuery(input.query || (!directUrl ? rawUrl : ''));

    return {
        rawUrl,
        directUrl,
        rawQuery
    };
}

function buildOpsBrowserTarget(input = {}) {
    const { directUrl, rawQuery } = extractOpsBrowserIntentInput(input);
    const query = rawQuery;
    const url = directUrl || `https://www.google.com/search?q=${encodeURIComponent(query || 'HADES')}`;
    return {
        url,
        title: String(input.title || '').trim(),
        query: query || '',
        source: String(input.source || 'system').trim() || 'system',
        reason: String(input.reason || (query ? 'search' : 'open')).trim() || 'open'
    };
}

function pickResolvedBrowserResult(results = [], intent = {}) {
    const ranked = Array.isArray(results) ? results : [];
    if (!ranked.length) return null;

    if (intent.latestVideo) {
        return ranked.find((item) => isYoutubeWatchUrl(item.url))
            || ranked.find((item) => isYoutubeChannelUrl(item.url))
            || ranked.find((item) => isYoutubeUrl(item.url))
            || ranked[0];
    }
    if (intent.officialChannel || (intent.wantsYoutube && intent.wantsLink)) {
        return ranked.find((item) => isYoutubeChannelUrl(item.url)) || ranked.find((item) => isYoutubeUrl(item.url)) || ranked[0];
    }
    if (intent.wantsYoutube) {
        return ranked.find((item) => isYoutubeUrl(item.url)) || ranked[0];
    }
    return ranked[0];
}

async function resolveSearchSelection(query = '', intent = {}, rankedResults = []) {
    const ranked = Array.isArray(rankedResults) ? rankedResults : [];
    if (!ranked.length) return null;

    let resolvedResult = null;
    if (intent.latestVideo) {
        const channelCandidates = ranked.filter((item) => isYoutubeChannelUrl(item.url)).slice(0, 3);
        for (const channelCandidate of channelCandidates) {
            try {
                resolvedResult = await fetchLatestYoutubeVideoFromChannel(channelCandidate);
            } catch (_) {
                resolvedResult = null;
            }
            if (resolvedResult?.url) break;
        }
    }

    return resolvedResult || pickResolvedBrowserResult(ranked, intent);
}

async function resolveOpsBrowserInput(input = {}) {
    const { rawQuery } = extractOpsBrowserIntentInput(input);
    if (!rawQuery) {
        return {
            browser: buildOpsBrowserTarget(input),
            resolution: null
        };
    }

    const query = optimizeSearchQuery(rawQuery);
    if (!query) {
        return {
            browser: buildOpsBrowserTarget(input),
            resolution: null
        };
    }

    const intent = detectWebIntent(rawQuery);
    const candidateQueries = buildSearchCandidates(query, intent);
    const htmlSettled = await Promise.allSettled(
        candidateQueries.map((candidate) => fetchDuckDuckGoHtmlResults(candidate))
    );
    const [instantResult] = await Promise.allSettled([
        fetchDuckDuckGoInstantData(query)
    ]);

    const instantRelated = instantResult.status === 'fulfilled' ? instantResult.value.related : [];
    const htmlResults = htmlSettled
        .filter((entry) => entry.status === 'fulfilled')
        .flatMap((entry) => entry.value || []);

    const mergedResults = mergeSearchResults([
        ...htmlResults,
        ...instantRelated
    ]);
    const rankedResults = prioritizeWebResults(rawQuery, mergedResults, intent).slice(0, 8);
    const resolvedResult = await resolveSearchSelection(rawQuery, intent, rankedResults);
    const previewResults = resolvedResult
        ? [resolvedResult, ...rankedResults.filter((item) => String(item.url || '') !== String(resolvedResult.url || '')).slice(0, 4)]
        : rankedResults.slice(0, 5);
    const browser = buildOpsBrowserTarget({
        ...input,
        query: rawQuery,
        url: resolvedResult?.url || '',
        title: resolvedResult?.title || '',
        reason: String(input.reason || (resolvedResult ? 'resolved_open' : 'search')).trim() || 'resolved_open'
    });

    return {
        browser,
        resolution: {
            query: rawQuery,
            effectiveQuery: query,
            intent,
            resolved: Boolean(resolvedResult?.url),
            selected: resolvedResult || null,
            results: previewResults,
            searchUrl: `https://www.google.com/search?q=${encodeURIComponent(rawQuery)}`
        }
    };
}

function setOpsBrowserState(input = {}) {
    const target = buildOpsBrowserTarget(input);
    opsBrowserState = {
        ...opsBrowserState,
        url: target.url,
        query: target.query,
        source: target.source,
        reason: target.reason,
        title: String(target.title || input.title || opsBrowserState.title || '').trim() || 'Hazir',
        updatedAt: new Date().toISOString()
    };
    return opsBrowserState;
}

function setOpsUiState(input = {}) {
    opsUiState = {
        ...opsUiState,
        browserPanelVisible: input.browserPanelVisible === undefined
            ? opsUiState.browserPanelVisible
            : Boolean(input.browserPanelVisible),
        updatedAt: new Date().toISOString()
    };
    return opsUiState;
}

async function buildOpsStatePayload() {
    return {
        health: {
            status: 'ok',
            service: 'hades-backend',
            time: new Date().toISOString(),
            openAiConfigured: isOpenAiConfigured,
            deepgramConfigured: isDeepgramConfigured,
            tuyaConfigured: isTuyaConfigured,
            tuyaConnected: isTuyaConnected,
            spotifyConfigured: isSpotifyConfigured
        },
        light: {
            configured: isTuyaConfigured,
            connected: isTuyaConnected,
            reconnectAttempt: tuyaReconnectAttempt,
            reconnectScheduled: Boolean(tuyaReconnectTimer),
            lastConnectedAt: tuyaLastConnectedAt || null,
            lastError: lastTuyaErrorMessage
        },
        spotify: await getSpotifyStatusSnapshot(),
        voice: voiceOverlayState,
        browser: opsBrowserState,
        ui: opsUiState,
        recentEvents: [...opsEventLog].slice(-40).reverse()
    };
}

function normalizeReplyInstanceId(value = '') {
    return String(value || '').trim().slice(0, 160);
}

function normalizeWakeSessionId(value = '') {
    return String(value || '').trim().slice(0, 160);
}

function hashReplyText(text = '') {
    let hash = 0;
    const input = String(text || '');
    for (let index = 0; index < input.length; index += 1) {
        hash = ((hash << 5) - hash) + input.charCodeAt(index);
        hash |= 0;
    }
    return `${input.length}:${hash}`;
}

function getReplyEventClient(instanceId = '') {
    const normalized = normalizeReplyInstanceId(instanceId);
    if (!normalized) return null;
    const socket = replyEventClients.get(normalized) || null;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (socket) replyEventClients.delete(normalized);
        return null;
    }
    return socket;
}

function emitReplyEvent(instanceId = '', payload = {}) {
    const socket = getReplyEventClient(instanceId);
    if (!socket) return false;
    try {
        socket.send(JSON.stringify(payload || {}));
        return true;
    } catch (_) {
        replyEventClients.delete(normalizeReplyInstanceId(instanceId));
        return false;
    }
}

function getWakeEventClient(instanceId = '') {
    const normalized = normalizeReplyInstanceId(instanceId);
    if (!normalized) return null;
    const socket = wakeEventClients.get(normalized) || null;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (socket) wakeEventClients.delete(normalized);
        return null;
    }
    return socket;
}

function emitWakeEvent(instanceId = '', payload = {}) {
    const socket = getWakeEventClient(instanceId) || getReplyEventClient(instanceId);
    if (!socket) return false;
    try {
        socket.send(JSON.stringify(payload || {}));
        return true;
    } catch (_) {
        wakeEventClients.delete(normalizeReplyInstanceId(instanceId));
        replyEventClients.delete(normalizeReplyInstanceId(instanceId));
        return false;
    }
}

function clearBackendReplyWatchTimer(watch = null) {
    if (!watch?.timer) return;
    clearTimeout(watch.timer);
    watch.timer = null;
}

function stopBackendReplyWatch(instanceId = '') {
    const normalized = normalizeReplyInstanceId(instanceId);
    const watch = backendReplyWatches.get(normalized);
    if (!watch) return;
    clearBackendReplyWatchTimer(watch);
    backendReplyWatches.delete(normalized);
}

function scheduleBackendReplyWatch(instanceId = '', delayMs = 420) {
    const normalized = normalizeReplyInstanceId(instanceId);
    const watch = backendReplyWatches.get(normalized);
    if (!watch) return;
    clearBackendReplyWatchTimer(watch);
    watch.timer = setTimeout(() => {
        watch.timer = null;
        void tickBackendReplyWatch(normalized);
    }, Math.max(120, Number(delayMs) || 420));
}

async function getChatgptDebugTarget() {
    const response = await fetch(`http://127.0.0.1:${HADES_REMOTE_DEBUG_PORT}/json/list`, {
        headers: {
            Accept: 'application/json'
        }
    });
    if (!response.ok) {
        throw new Error('Chromium debug hedefleri alınamadı.');
    }

    const targets = await response.json();
    const preferred = (Array.isArray(targets) ? targets : []).find((target) => {
        const type = String(target?.type || '').toLowerCase();
        const url = String(target?.url || '').toLowerCase();
        return type === 'page' && (url.startsWith('https://chatgpt.com/') || url.startsWith('https://chat.openai.com/'));
    });

    if (!preferred?.webSocketDebuggerUrl) {
        throw new Error('ChatGPT Chromium hedefi bulunamadı.');
    }

    return preferred;
}

function evaluateTargetSnapshot(debuggerUrl = '') {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(String(debuggerUrl || ''));
        const requestId = 1;
        const timeout = setTimeout(() => {
            try { socket.terminate(); } catch (_) {}
            reject(new Error('Chromium reply snapshot zaman aşımına uğradı.'));
        }, 5000);

        const finish = (handler, payload) => {
            clearTimeout(timeout);
            try { socket.close(); } catch (_) {}
            handler(payload);
        };

        socket.once('error', (error) => finish(reject, error));
        socket.on('message', (raw) => {
            let message = null;
            try {
                message = JSON.parse(String(raw || '{}'));
            } catch (_) {
                return;
            }
            if (message.id !== requestId) return;
            if (message.error) {
                finish(reject, new Error(message.error.message || 'Chromium Runtime.evaluate başarısız.'));
                return;
            }
            finish(resolve, message.result?.result?.value || null);
        });
        socket.once('open', () => {
            socket.send(JSON.stringify({
                id: requestId,
                method: 'Runtime.evaluate',
                params: {
                    awaitPromise: true,
                    returnByValue: true,
                    expression: `(() => {
                        const stopButton = () => document.querySelector('button[data-testid="stop-button"]') || document.querySelector('button[aria-label^="Stop"]') || document.querySelector('button[aria-label*="Durdur"]') || document.querySelector('button[aria-label*="Yanıtlamayı durdur"]') || document.querySelector('button[aria-label*="Yanitlamayi durdur"]');
                        const stripSpeechPayloads = (text = '') => String(text || '').replace(/\\\`\\\`\\\`(?:hades-bridge|json)?[\\s\\S]*?\\\`\\\`\\\`/gi, ' ');
                        const stripEmoji = (text = '') => String(text || '').replace(/[\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\uFE0F]/gu, ' ');
                        const collapseRepeat = (text = '') => {
                            const clean = String(text || '').replace(/\\s+/g, ' ').trim();
                            if (!clean) return '';
                            const words = clean.split(' ');
                            if (words.length >= 4 && words.length % 2 === 0) {
                                const half = words.length / 2;
                                const left = words.slice(0, half).join(' ');
                                const right = words.slice(half).join(' ');
                                if (left.toLocaleLowerCase('tr-TR') === right.toLocaleLowerCase('tr-TR')) return left;
                            }
                            return clean;
                        };
                        const speechText = (text = '') => collapseRepeat(stripEmoji(stripSpeechPayloads(String(text || '').replace(/HADES_TOOL_RESULT[\\s\\S]*$/gi, ' ').replace(/HADES_RUNTIME_STATUS[\\s\\S]*$/gi, ' ').replace(/HADES_LOCAL_EXECUTION[\\s\\S]*$/gi, ' ').replace(/HADES_BRIDGE_PROFILE_V\\d+/gi, ' ')))).replace(/\\s+/g, ' ').trim();
                        const hideTech = (text = '') => {
                            const value = String(text || '').trim();
                            if (!value) return true;
                            if (value.startsWith('HADES_BRIDGE_PROFILE_V')) return true;
                            if (value.includes('Çalışma protokolü:') && value.includes('Kullanabileceğin yerel araçlar:')) return true;
                            if (value.startsWith('HADES_TOOL_RESULT') || value.startsWith('HADES_RUNTIME_STATUS') || value.startsWith('HADES_LOCAL_EXECUTION')) return true;
                            return false;
                        };
                        const assistantNodes = [...document.querySelectorAll('[data-message-author-role="assistant"],article[data-message-author-role="assistant"]')];
                        const speakable = assistantNodes.filter((node) => {
                            const text = String(node.textContent || '').trim();
                            return text && !hideTech(text);
                        });
                        const lastText = speakable.length ? speechText(String(speakable[speakable.length - 1].textContent || '')) : '';
                        const stop = stopButton();
                        return {
                            assistantCount: speakable.length,
                            lastText,
                            stopGenerating: Boolean(stop && !stop.disabled)
                        };
                    })()`
                }
            }));
        });
    });
}

async function inspectReplyStateViaChromium() {
    const target = await getChatgptDebugTarget();
    return evaluateTargetSnapshot(target.webSocketDebuggerUrl);
}

async function tickBackendReplyWatch(instanceId = '') {
    if (!isNativeBridgeVoiceEnabled) {
        stopBackendReplyWatch(instanceId);
        return;
    }
    const normalized = normalizeReplyInstanceId(instanceId);
    const watch = backendReplyWatches.get(normalized);
    if (!watch) return;

    if (Date.now() - watch.startedAt > watch.timeoutMs) {
        emitReplyEvent(normalized, { type: 'bridge:reply-timeout' });
        stopBackendReplyWatch(normalized);
        return;
    }

    let snapshot = null;
    try {
        snapshot = await inspectReplyStateViaChromium();
    } catch (_) {
        scheduleBackendReplyWatch(normalized, 500);
        return;
    }

    const active = backendReplyWatches.get(normalized);
    if (!active || active !== watch) return;

    const text = String(snapshot?.lastText || '').trim();
    const nextSig = text ? hashReplyText(text) : '';
    const hasNewReply = Boolean(text) && ((Number(snapshot?.assistantCount) || 0) > active.baselineCount || (nextSig && nextSig !== active.baselineSig));

    if (!hasNewReply) {
        scheduleBackendReplyWatch(normalized, 500);
        return;
    }

    if (nextSig !== active.lastSig) {
        active.lastSig = nextSig;
        active.stableAt = Date.now();
        scheduleBackendReplyWatch(normalized, 260);
        return;
    }

    const stableForMs = Date.now() - active.stableAt;
    if (stableForMs < 900) {
        scheduleBackendReplyWatch(normalized, 260);
        return;
    }

    if (snapshot?.stopGenerating && stableForMs < 1800) {
        scheduleBackendReplyWatch(normalized, 320);
        return;
    }

    sanitizeOverlayState({
        chip: 'Yanıtı okuyor',
        tone: 'ok',
        detail: 'Yerel Windows sesi aktif. Yeniden "HADES" diyerek kesebilirsin.',
        mode: 'speaking',
        meter: 0
    });
    emitReplyEvent(normalized, {
        type: 'bridge:reply-speaking',
        sig: nextSig,
        text
    });

    let spoken = false;
    try {
        const result = await speakNativeText(text, 'tr-TR');
        spoken = Boolean(result?.completed !== false);
    } catch (_) {}

    emitReplyEvent(normalized, {
        type: 'bridge:reply-handled',
        sig: nextSig,
        text,
        spoken
    });
    sanitizeOverlayState({
        chip: 'Wake dinliyor',
        tone: 'ok',
        detail: '"HADES" deyince seni dinleyecek.',
        mode: 'wake',
        meter: 0
    });
    stopBackendReplyWatch(normalized);
}

function stopNativeTts() {
    const current = nativeTtsProcess;
    nativeTtsProcess = null;
    if (!current?.child || current.child.killed) {
        return false;
    }

    try {
        current.child.kill();
        return true;
    } catch (_) {
        return false;
    }
}

function getVoicePythonExecutable() {
    return fs.existsSync(VOICE_PYTHON) ? VOICE_PYTHON : '';
}

function getVoiceNodeExecutable() {
    return process.execPath || '';
}

function voiceRuntimeScript(scriptName = '') {
    return path.join(VOICE_RUNTIME_ROOT, scriptName);
}

function runVoicePythonProbe(code = '', timeout = 8000) {
    const python = getVoicePythonExecutable();
    if (!python) {
        return { ok: false, stdout: '', stderr: 'Voice Python bulunamadı.' };
    }

    const probe = spawnSync(python, ['-c', String(code || '')], {
        windowsHide: true,
        encoding: 'utf8',
        timeout
    });

    return {
        ok: probe.status === 0,
        stdout: String(probe.stdout || '').trim(),
        stderr: String(probe.stderr || '').trim()
    };
}

function runVoiceNodeProbe(code = '', timeout = 8000) {
    const node = getVoiceNodeExecutable();
    if (!node) {
        return { ok: false, stdout: '', stderr: 'Voice Node bulunamadı.' };
    }

    const probe = spawnSync(node, ['-e', String(code || '')], {
        cwd: __dirname,
        windowsHide: true,
        encoding: 'utf8',
        timeout,
        env: process.env
    });

    return {
        ok: probe.status === 0,
        stdout: String(probe.stdout || '').trim(),
        stderr: String(probe.stderr || '').trim()
    };
}

function detectGoogleCloudWakeSupport(forceRefresh = false) {
    if (!forceRefresh && nativeWakeRuntimeCache === 'google-cloud') {
        return true;
    }

    const probe = runVoiceNodeProbe([
        'const fs = require("fs");',
        'try {',
        '  require("@google-cloud/speech");',
        '  require("mic");',
        '  const keyPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();',
        '  const hasCreds = !keyPath || fs.existsSync(keyPath);',
        '  process.stdout.write(hasCreds ? "ok" : "missing_credentials");',
        '} catch (error) {',
        '  console.error(error.message || String(error));',
        '  process.exit(1);',
        '}'
    ].join('\n'));

    return probe.ok && probe.stdout === 'ok';
}

function resolveNativeWakeRuntime(forceRefresh = false) {
    if (!forceRefresh && nativeWakeRuntimeCache) {
        return nativeWakeRuntimeCache;
    }

    const preferred = String(process.env.HADES_WAKE_RUNTIME || 'auto').trim().toLowerCase();
    if (preferred === 'google-cloud' && detectGoogleCloudWakeSupport(forceRefresh)) {
        nativeWakeRuntimeCache = 'google-cloud';
        return nativeWakeRuntimeCache;
    }
    if (preferred === 'python' || preferred === 'speechrecognition') {
        nativeWakeRuntimeCache = 'python';
        return nativeWakeRuntimeCache;
    }
    const hasExplicitGoogleCreds = !!String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    if (hasExplicitGoogleCreds && detectGoogleCloudWakeSupport(forceRefresh)) {
        nativeWakeRuntimeCache = 'google-cloud';
        return nativeWakeRuntimeCache;
    }

    nativeWakeRuntimeCache = 'python';
    return nativeWakeRuntimeCache;
}

function detectNativeWakeSupport(forceRefresh = false) {
    if (!forceRefresh && nativeWakeSupportCache !== null) {
        return nativeWakeSupportCache;
    }

    const runtime = resolveNativeWakeRuntime(forceRefresh);
    if (runtime === 'google-cloud') {
        nativeWakeSupportCache = detectGoogleCloudWakeSupport(forceRefresh);
        return nativeWakeSupportCache;
    }

    const probe = runVoicePythonProbe([
        'import sys',
        'try:',
        '    import speech_recognition as sr',
        '    import sounddevice as sd',
        '    devices = sd.query_devices()',
        "    has_input = any((device.get('max_input_channels') or 0) > 0 for device in devices)",
        "    print('ok' if has_input else 'missing')",
        'except Exception as exc:',
        '    print(str(exc), file=sys.stderr)',
        '    raise'
    ].join('\n'));

    nativeWakeSupportCache = probe.ok && probe.stdout === 'ok';
    return nativeWakeSupportCache;
}

function detectNativeTtsSupport(forceRefresh = false) {
    if (!forceRefresh && nativeTtsSupportCache !== null) {
        return nativeTtsSupportCache;
    }

    const probe = runVoicePythonProbe([
        'import sys',
        'try:',
        '    import gtts',
        "    print('ok')",
        'except Exception as exc:',
        '    print(str(exc), file=sys.stderr)',
        '    raise'
    ].join('\n'));

    nativeTtsSupportCache = probe.ok && probe.stdout === 'ok';
    return nativeTtsSupportCache;
}

function cleanupGeneratedTtsFiles() {
    const now = Date.now();
    for (const [fileId, fileInfo] of generatedTtsFiles.entries()) {
        if ((now - Number(fileInfo?.createdAt || 0)) <= TTS_FILE_TTL_MS) continue;
        generatedTtsFiles.delete(fileId);
        try {
            if (fileInfo?.path && fs.existsSync(fileInfo.path)) {
                fs.unlinkSync(fileInfo.path);
            }
        } catch (_) {
            // Eski cache dosyalarını sessizce temizle.
        }
    }
}

function registerGeneratedTtsFile(filePath = '') {
    cleanupGeneratedTtsFiles();
    const fileId = `tts-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    generatedTtsFiles.set(fileId, {
        path: String(filePath || ''),
        createdAt: Date.now()
    });
    return fileId;
}

function stopNativeWakeListener(instanceId = '', sessionId = '') {
    const requestedId = normalizeReplyInstanceId(instanceId);
    const requestedSessionId = normalizeWakeSessionId(sessionId);
    const current = nativeWakeProcess;
    const activeInstanceId = normalizeReplyInstanceId(current?.instanceId || nativeWakeState.instanceId || '');
    const activeSessionId = normalizeWakeSessionId(current?.sessionId || nativeWakeState.sessionId || '');

    if (requestedId && activeInstanceId && requestedId !== activeInstanceId) {
        return false;
    }
    if (requestedSessionId && activeSessionId && requestedSessionId !== activeSessionId) {
        return false;
    }

    if (!current?.child || current.child.killed) {
        return false;
    }

    nativeWakeProcess = null;
    nativeWakeState = {
        instanceId: '',
        sessionId: '',
        locale: 'tr-TR',
        wakeWord: 'HADES',
        runtime: resolveNativeWakeRuntime()
    };

    try {
        const pid = current.child.pid;
        let gracefulStopSent = false;
        if (current.child.stdin && !current.child.stdin.destroyed) {
            try {
                current.child.stdin.write('stop\n');
                current.child.stdin.end();
                gracefulStopSent = true;
            } catch (_) {
                gracefulStopSent = false;
            }
        }

        const forceKill = () => {
            try {
                if (!current.child.killed) {
                    current.child.kill('SIGKILL');
                }
            } catch (_) {}

            if (process.platform === 'win32') {
                try {
                    const { spawnSync } = require('child_process');
                    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                        windowsHide: true,
                        stdio: 'ignore',
                        timeout: 2000
                    });
                } catch (_) {}
            }
        };

        if (gracefulStopSent) {
            const fallbackTimer = setTimeout(forceKill, 900);
            if (typeof fallbackTimer?.unref === 'function') {
                fallbackTimer.unref();
            }
        } else {
            forceKill();
        }

        return true;
    } catch (_) {
        return false;
    }
}

function startNativeWakeListener({ instanceId = '', sessionId = '', locale = 'tr-TR', wakeWord = 'HADES' } = {}) {
    const normalized = normalizeReplyInstanceId(instanceId);
    const requestedSessionId = normalizeWakeSessionId(sessionId);
    let wakeRuntime = resolveNativeWakeRuntime();
    if (!normalized) {
        throw new Error('Wake listener için instanceId gerekli.');
    }
    let nativeWakeSupported = detectNativeWakeSupport();
    if (!nativeWakeSupported) {
        wakeRuntime = resolveNativeWakeRuntime(true);
        nativeWakeSupported = detectNativeWakeSupport(true);
    }
    if (!nativeWakeSupported) {
        throw new Error(`${wakeRuntime === 'google-cloud' ? 'Google Cloud' : 'SpeechRecognition'} wake runtime hazir degil.`);
    }

    const activeInstanceId = normalizeReplyInstanceId(nativeWakeProcess?.instanceId || nativeWakeState.instanceId || '');
    const activeSessionId = normalizeWakeSessionId(nativeWakeProcess?.sessionId || nativeWakeState.sessionId || '');
    const sameInstance = !!activeInstanceId && activeInstanceId === normalized;
    const sameSession = !requestedSessionId || activeSessionId === requestedSessionId;

    if (nativeWakeProcess?.child && !nativeWakeProcess.child.killed) {
        if (sameInstance && sameSession) {
            return {
                ok: true,
                alreadyRunning: true,
                instanceId: normalized,
                sessionId: activeSessionId
            };
        }

        stopNativeWakeListener(activeInstanceId, activeSessionId);
    }

    const normalizedSessionId = requestedSessionId || `wake-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (nativeWakeProcess?.child && !nativeWakeProcess.child.killed) {
        throw new Error('Önceki wake listener kapatılamadı.');
    }

    const safeLocale = String(locale || 'tr-TR').trim() || 'tr-TR';
    const safeWakeWord = String(wakeWord || 'HADES').trim() || 'HADES';
    const scriptPath = voiceRuntimeScript(wakeRuntime === 'google-cloud'
        ? 'google_cloud_wake_listener.js'
        : 'google_wake_listener.py');

    let child = null;
    if (wakeRuntime === 'google-cloud') {
        const node = getVoiceNodeExecutable();
        if (!node || !fs.existsSync(scriptPath)) {
            throw new Error('Google Cloud wake listener dosyasi bulunamadi.');
        }
        child = spawn(node, [
            scriptPath,
            '--locale', safeLocale,
            '--wake-word', safeWakeWord
        ], {
            cwd: __dirname,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env
        });
    } else {
        const python = getVoicePythonExecutable();
        if (!python || !fs.existsSync(scriptPath)) {
            throw new Error('Python wake listener dosyasi bulunamadi.');
        }
        child = spawn(python, [
            scriptPath,
            '--locale', safeLocale,
            '--wake-word', safeWakeWord
        ], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    }

    const current = {
        child,
        instanceId: normalized,
        sessionId: normalizedSessionId,
        runtime: wakeRuntime,
        stdoutBuffer: '',
        stderrBuffer: ''
    };
    nativeWakeProcess = current;
    nativeWakeState = {
        instanceId: normalized,
        sessionId: normalizedSessionId,
        locale: safeLocale,
        wakeWord: safeWakeWord,
        runtime: wakeRuntime
    };

    // Wake algılandığında buffer'ı temizle
    let lastWakeAt = 0;

    const flushWakeStdout = (force = false) => {
        if (!nativeWakeProcess || nativeWakeProcess !== current) return;
        const parts = current.stdoutBuffer.split(/\r?\n/);
        if (!force) {
            current.stdoutBuffer = parts.pop() || '';
        } else {
            current.stdoutBuffer = '';
        }

        for (const line of parts) {
            const trimmed = String(line || '').trim();
            if (!trimmed) continue;
            let payload = null;
            try {
                payload = JSON.parse(trimmed);
            } catch (_) {
                emitWakeEvent(normalized, {
                    type: 'bridge:wake-error',
                    message: `Wake stdout parse hatasi: ${trimmed.slice(0, 160)}`,
                    sessionId: current.sessionId
                });
                continue;
            }
            
            // Wake algılandığında buffer'ı temizle ve duplicate wake'leri engelle
            if (payload.type === 'wake') {
                const now = Date.now();
                if (now - lastWakeAt < 500) {
                    // 500ms içindeki duplicate wake'leri atla
                    continue;
                }
                lastWakeAt = now;
                current.stdoutBuffer = ''; // Buffer'ı temizle
            }
            
            emitWakeEvent(normalized, {
                ...payload,
                instanceId: normalized,
                sessionId: current.sessionId
            });
        }
    };

    child.stdout.on('data', (chunk) => {
        current.stdoutBuffer += String(chunk || '');
        flushWakeStdout(false);
    });

    child.stderr.on('data', (chunk) => {
        current.stderrBuffer += String(chunk || '');
        const lines = current.stderrBuffer.split(/\r?\n/);
        current.stderrBuffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = String(line || '').trim();
            if (!trimmed) continue;
            emitWakeEvent(normalized, {
                type: 'bridge:wake-error',
                message: trimmed,
                instanceId: normalized,
                sessionId: current.sessionId
            });
        }
    });

    child.once('error', (error) => {
        if (nativeWakeProcess === current) {
            nativeWakeProcess = null;
            nativeWakeState = {
                instanceId: '',
                sessionId: '',
                locale: 'tr-TR',
                wakeWord: 'HADES',
                runtime: resolveNativeWakeRuntime()
            };
        }
        emitWakeEvent(normalized, {
            type: 'bridge:wake-error',
            message: error.message || 'Yerel wake listener baslatilamadi.',
            instanceId: normalized,
            sessionId: current.sessionId
        });
    });

    child.once('exit', (code, signal) => {
        flushWakeStdout(true);
        if (nativeWakeProcess === current) {
            nativeWakeProcess = null;
            nativeWakeState = {
                instanceId: '',
                sessionId: '',
                locale: 'tr-TR',
                wakeWord: 'HADES',
                runtime: resolveNativeWakeRuntime()
            };
        }
        emitWakeEvent(normalized, {
            type: 'bridge:wake-closed',
            code,
            signal,
            instanceId: normalized,
            sessionId: current.sessionId
        });
    });

    return {
        ok: true,
        instanceId: normalized,
        sessionId: current.sessionId,
        runtime: wakeRuntime
    };
}

function speakNativeText(text = '', locale = 'tr-TR') {
    const message = String(text || '').replace(/\s+/g, ' ').trim();
    const safeLocale = String(locale || 'tr-TR').trim() || 'tr-TR';
    if (!message) {
        throw new Error('Seslendirilecek metin boş olamaz.');
    }
    if (!detectNativeTtsSupport()) {
        throw new Error('gTTS runtime hazır değil.');
    }

    stopNativeTts();
    const python = getVoicePythonExecutable();
    const scriptPath = voiceRuntimeScript('google_tts.py');
    if (!python || !fs.existsSync(scriptPath)) {
        throw new Error('Python gTTS dosyası bulunamadı.');
    }
    fs.mkdirSync(TTS_OUTPUT_DIR, { recursive: true });
    cleanupGeneratedTtsFiles();
    const outputPath = path.join(TTS_OUTPUT_DIR, `tts-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
    const textBase64 = Buffer.from(message, 'utf8').toString('base64');

    return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const child = spawn(python, [
            scriptPath,
            '--text-base64', textBase64,
            '--locale', safeLocale,
            '--output', outputPath
        ], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const current = { child, outputPath };
        nativeTtsProcess = current;

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
        });

        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });

        child.once('error', (error) => {
            if (nativeTtsProcess === current) {
                nativeTtsProcess = null;
            }
            if (settled) return;
            settled = true;
            reject(error);
        });

        child.once('exit', (code, signal) => {
            if (nativeTtsProcess === current) {
                nativeTtsProcess = null;
            }
            if (settled) return;
            settled = true;
            if (code !== 0) {
                reject(new Error(stderr.trim() || `gTTS üretimi başarısız oldu (kod ${code ?? 'bilinmiyor'}).`));
                return;
            }

            let payload = null;
            const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            if (lines.length) {
                try {
                    payload = JSON.parse(lines[lines.length - 1]);
                } catch (_) {
                    payload = null;
                }
            }

            const filePath = String(payload?.output || outputPath).trim();
            if (!filePath || !fs.existsSync(filePath)) {
                reject(new Error('gTTS çıktı dosyası üretilemedi.'));
                return;
            }

            const fileId = registerGeneratedTtsFile(filePath);
            resolve({
                completed: true,
                stopped: Boolean(signal),
                code,
                signal,
                fileId,
                url: `/bridge/tts/file/${encodeURIComponent(fileId)}`
            });
        });
    });
}

const fetchDuckDuckGoInstantData = async (query) => {
    const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&skip_disambig=1`;
    const response = await fetch(endpoint, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'hades-assistant/1.0'
        }
    });
    if (!response.ok) return { abstract: '', related: [] };

    const payload = await response.json();
    const abstract = stripHtml(payload?.AbstractText || '');
    const related = flattenDuckDuckGoTopics(payload?.RelatedTopics || []);
    return { abstract, related };
};

const extractDuckDuckGoHtmlResults = (html = '', maxResults = 6) => {
    const rows = [];
    const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<(?:a|div)[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
    const snippets = [];
    let snippetMatch;

    while ((snippetMatch = snippetRegex.exec(html)) !== null) {
        const snippetText = stripHtml(snippetMatch[1] || '');
        snippets.push(snippetText);
    }

    let titleMatch;
    let index = 0;
    while ((titleMatch = titleRegex.exec(html)) !== null) {
        const url = normalizeResultUrl(titleMatch[1] || '');
        const title = stripHtml(titleMatch[2] || '');
        if (!url || !title) {
            index += 1;
            continue;
        }
        rows.push({
            title,
            url,
            snippet: snippets[index] || ''
        });
        index += 1;
        if (rows.length >= maxResults) break;
    }

    return rows;
};

const fetchDuckDuckGoHtmlResults = async (query) => {
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=tr-tr`;
    const response = await fetch(endpoint, {
        headers: {
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
        }
    });
    if (!response.ok) return [];

    const html = await response.text();
    return extractDuckDuckGoHtmlResults(html, 6);
};

const mergeSearchResults = (results = []) => {
    const deduped = [];
    const seen = new Set();
    for (const item of results) {
        const title = stripHtml(item?.title || '');
        const url = normalizeResultUrl(item?.url || '');
        const snippet = stripHtml(item?.snippet || '');
        if (!title || !url) continue;
        const key = `${url}__${title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push({ title, url, snippet });
    }
    return deduped;
};

const isYoutubeUrl = (url = '') => /youtube\.com|youtu\.be/i.test(url);
const isYoutubeWatchUrl = (url = '') => /youtube\.com\/watch|youtu\.be\//i.test(url);
const isYoutubeChannelUrl = (url = '') => /youtube\.com\/(@|channel\/|c\/|user\/)/i.test(url);

const extractYoutubeChannelIdFromUrl = (url = '') => {
    try {
        const parsed = new URL(String(url || '').trim());
        const direct = parsed.pathname.match(/\/channel\/([a-zA-Z0-9_-]+)/i);
        if (direct?.[1]) return direct[1];
        return String(parsed.searchParams.get('channel_id') || '').trim();
    } catch (_) {
        return '';
    }
};

const fetchTextResponse = async (url = '', extraHeaders = {}) => {
    const response = await fetch(url, {
        headers: {
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            ...extraHeaders
        }
    });
    if (!response.ok) return '';
    return response.text();
};

const extractYoutubeFeedUrlFromHtml = (html = '') => {
    const match = String(html || '').match(/<link[^>]+type="application\/rss\+xml"[^>]+href="([^"]+)"/i)
        || String(html || '').match(/https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=[a-zA-Z0-9_-]+/i);
    const feedUrl = match?.[1] || match?.[0] || '';
    return normalizeResultUrl(feedUrl);
};

const extractYoutubeChannelIdFromHtml = (html = '') => {
    const feedUrl = extractYoutubeFeedUrlFromHtml(html);
    if (feedUrl) {
        try {
            return String(new URL(feedUrl).searchParams.get('channel_id') || '').trim();
        } catch (_) {
            // Alttaki regexlerle devam et.
        }
    }

    const match = String(html || '').match(/"channelId":"([a-zA-Z0-9_-]+)"/i)
        || String(html || '').match(/channel_id=([a-zA-Z0-9_-]+)/i);
    return match?.[1] ? String(match[1]).trim() : '';
};

async function resolveYoutubeFeedUrl(channelUrl = '') {
    const directChannelId = extractYoutubeChannelIdFromUrl(channelUrl);
    if (directChannelId) {
        return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(directChannelId)}`;
    }

    const html = await fetchTextResponse(channelUrl);
    if (!html) return '';

    const feedUrl = extractYoutubeFeedUrlFromHtml(html);
    if (feedUrl) return feedUrl;

    const channelId = extractYoutubeChannelIdFromHtml(html);
    if (!channelId) return '';
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

function parseYoutubeFeedEntries(xml = '') {
    const entries = [];
    const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
    let match;

    while ((match = entryRegex.exec(String(xml || ''))) !== null) {
        const block = match[0] || '';
        const videoId = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i) || [])[1] || '';
        const title = decodeHtmlEntities((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
        const publishedAt = String((block.match(/<published>([^<]+)<\/published>/i) || [])[1] || '').trim();
        if (!videoId || !title) continue;
        entries.push({ videoId, title, publishedAt });
    }

    return entries.sort((left, right) => {
        const leftTime = Date.parse(left.publishedAt || '') || 0;
        const rightTime = Date.parse(right.publishedAt || '') || 0;
        return rightTime - leftTime;
    });
}

async function fetchLatestYoutubeVideoFromChannel(channelResult = {}) {
    const channelUrl = String(channelResult?.url || '').trim();
    if (!channelUrl) return null;

    const feedUrl = await resolveYoutubeFeedUrl(channelUrl);
    if (!feedUrl) return null;

    const xml = await fetchTextResponse(feedUrl, {
        'Accept': 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8'
    });
    if (!xml) return null;

    const [latest] = parseYoutubeFeedEntries(xml);
    if (!latest?.videoId || !latest.title) return null;

    return {
        title: latest.title,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(latest.videoId)}`,
        snippet: latest.publishedAt
            ? `Kanaldaki en yeni yukleme: ${latest.publishedAt}`
            : 'Kanaldaki en yeni yukleme',
        publishedAt: latest.publishedAt,
        channelUrl
    };
}

const scoreByKeywordOverlap = (query = '', title = '') => {
    const queryTokens = normalizeTr(query)
        .split(/\s+/)
        .filter((token) => token.length > 2 && !SEARCH_STOPWORDS.has(token));
    if (queryTokens.length === 0) return 0;
    const normalizedTitle = normalizeTr(title);
    return queryTokens.reduce((sum, token) => sum + (normalizedTitle.includes(token) ? 4 : 0), 0);
};

const rankWebResult = (result, query = '', intent = {}) => {
    let score = 0;
    const title = String(result?.title || '');
    const url = String(result?.url || '');
    const snippet = String(result?.snippet || '');
    const body = `${title} ${snippet}`;
    const youtube = isYoutubeUrl(url);

    if (intent.latestVideo && isYoutubeWatchUrl(url)) score += 120;
    if (intent.latestVideo && isYoutubeChannelUrl(url)) score += 70;
    if (intent.officialChannel && isYoutubeChannelUrl(url)) score += 120;
    if (intent.officialChannel && isYoutubeWatchUrl(url)) score += 40;
    if (intent.wantsYoutube && isYoutubeUrl(url)) score += 50;
    if (intent.wantsLink && (isYoutubeChannelUrl(url) || isYoutubeWatchUrl(url))) score += 20;
    if (intent.latestVideo && !youtube) score -= 160;
    if (intent.officialChannel && !youtube) score -= 140;
    if (intent.wantsYoutube && !youtube) score -= 80;
    score += scoreByKeywordOverlap(query, body);

    return score;
};

const prioritizeWebResults = (query = '', results = [], intent = {}) => {
    return [...(Array.isArray(results) ? results : [])]
        .map((result) => ({ ...result, _score: rankWebResult(result, query, intent) }))
        .sort((a, b) => b._score - a._score)
        .map(({ _score, ...rest }) => rest);
};

const buildSearchCandidates = (query = '', intent = {}) => {
    const candidates = [query];
    if (intent.latestVideo || intent.officialChannel || intent.wantsYoutube) {
        candidates.push(`${query} site:youtube.com`);
        candidates.push(`${query} youtube`);
    }
    if (intent.officialChannel) {
        candidates.push(`${query} resmi youtube kanali`);
    }
    if (intent.latestVideo) {
        candidates.push(`${query} site:youtube.com/watch`);
        candidates.push(`${query} latest uploaded video official channel`);
    }
    return [...new Set(candidates.map((item) => normalizeSearchQuery(item)).filter(Boolean))].slice(0, 4);
};

const buildWebAnswer = ({ query = '', abstract = '', results = [], intent = {}, selected = null }) => {
    const topic = normalizeSearchQuery(query) || 'bu konu';
    const topResult = results[0] || null;
    const topChannelResult = results.find((item) => isYoutubeChannelUrl(item.url)) || null;
    const topVideoResult = results.find((item) => isYoutubeWatchUrl(item.url)) || null;
    const primarySelected = selected && selected.url ? selected : null;

    if (intent.latestVideo) {
        if (primarySelected && isYoutubeWatchUrl(primarySelected.url)) {
            return `Guncel secilen video: ${primarySelected.title}. Link: ${primarySelected.url}`;
        }
        if (topVideoResult) {
            return `En guclu web bulgusu: ${topVideoResult.title}. Link: ${topVideoResult.url}`;
        }
        if (topChannelResult) {
            return `Doğrudan video yerine kanal sonucu buldum: ${topChannelResult.title}. Son videoyu teyit için kanal linki: ${topChannelResult.url}`;
        }
    }

    if ((intent.officialChannel || (intent.wantsYoutube && intent.wantsLink)) && topChannelResult) {
        return `Resmi YouTube kanal bulgusu: ${topChannelResult.title}. Link: ${topChannelResult.url}`;
    }

    const topYoutubeResult = results.find((item) => isYoutubeUrl(item.url)) || null;
    const primaryResult = topYoutubeResult || topResult;

    const chunks = [];
    if (abstract) {
        chunks.push(abstract);
    }

    if (primaryResult) {
        const lead = `Arastirma sonucu: ${primaryResult.title}.`;
        chunks.push(lead);
        chunks.push(`Link: ${primaryResult.url}`);
        if (primaryResult.snippet) {
            chunks.push(primaryResult.snippet);
        }
    }

    if (chunks.length === 0) {
        return `Webde araştırdım ama "${topic}" için güçlü bir özet çıkaramadım.`;
    }

    return chunks.join(' ').replace(/\s+/g, ' ').trim();
};

const OPENAI_PROXY_TIMEOUT_MS = 15 * 1000;

function sanitizeOpenAiPayload(rawPayload = {}) {
    const payload = {
        model: String(rawPayload.model || 'gpt-5-mini').trim(),
        messages: Array.isArray(rawPayload.messages) ? rawPayload.messages : []
    };

    if (rawPayload.response_format && typeof rawPayload.response_format === 'object') {
        payload.response_format = rawPayload.response_format;
    }

    if (typeof rawPayload.reasoning_effort === 'string' && rawPayload.reasoning_effort.trim()) {
        payload.reasoning_effort = rawPayload.reasoning_effort.trim();
    }

    if (rawPayload.max_completion_tokens !== undefined && rawPayload.max_completion_tokens !== null) {
        const parsed = Number(rawPayload.max_completion_tokens);
        if (Number.isFinite(parsed) && parsed > 0) {
            payload.max_completion_tokens = Math.min(Math.round(parsed), 4000);
        }
    }

    if (rawPayload.max_tokens !== undefined && rawPayload.max_tokens !== null) {
        const parsed = Number(rawPayload.max_tokens);
        if (Number.isFinite(parsed) && parsed > 0) {
            payload.max_tokens = Math.min(Math.round(parsed), 4000);
        }
    }

    if (rawPayload.temperature !== undefined && rawPayload.temperature !== null) {
        const parsed = Number(rawPayload.temperature);
        if (Number.isFinite(parsed)) {
            payload.temperature = Math.max(0, Math.min(2, parsed));
        }
    }

    if (Array.isArray(rawPayload.tools)) {
        payload.tools = rawPayload.tools;
    }

    if (rawPayload.tool_choice) {
        payload.tool_choice = rawPayload.tool_choice;
    }

    return payload;
}

async function callOpenAiChatCompletions(rawPayload = {}) {
    if (!isOpenAiConfigured) {
        throw new Error('OpenAI ayarları eksik. OPENAI_API_KEY tanımlayın.');
    }

    const payload = sanitizeOpenAiPayload(rawPayload);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENAI_PROXY_TIMEOUT_MS);

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            signal: controller.signal,
            body: JSON.stringify(payload)
        });

        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            data = { message: `OpenAI cevabi parse edilemedi (HTTP ${response.status}).` };
        }

        return {
            ok: response.ok,
            status: response.status,
            data
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'hades-backend',
        time: new Date().toISOString(),
        openAiConfigured: isOpenAiConfigured,
        deepgramConfigured: isDeepgramConfigured,
        tuyaConfigured: isTuyaConfigured,
        tuyaConnected: isTuyaConnected,
        spotifyConfigured: isSpotifyConfigured
    });
});

app.post('/openai/chat/completions', async (req, res) => {
    if (!isOpenAiConfigured) {
        return res.status(503).json({ message: 'OpenAI backend proxy hazır değil. OPENAI_API_KEY tanımlayın.' });
    }

    const payload = sanitizeOpenAiPayload(req.body || {});
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
        return res.status(400).json({ message: 'messages alani bos olamaz.' });
    }

    try {
        const result = await callOpenAiChatCompletions(payload);
        res.status(result.status || 200).json(result.data);
    } catch (error) {
        const message = error.name === 'AbortError'
            ? 'OpenAI isteği zaman aşımına uğradı.'
            : (error.message || 'OpenAI isteği başarısız oldu.');
        res.status(502).json({ message });
    }
});

app.get('/bridge/context', async (_req, res) => {
    const spotifyStatus = await getSpotifyStatusSnapshot();
    const runtime = {
        health: {
            status: 'ok',
            service: 'hades-backend',
            time: new Date().toISOString(),
            openAiConfigured: isOpenAiConfigured,
            deepgramConfigured: isDeepgramConfigured,
            tuyaConfigured: isTuyaConfigured,
            tuyaConnected: isTuyaConnected,
            spotifyConfigured: isSpotifyConfigured
        },
        spotify: spotifyStatus,
        voice: {
            deepgramConfigured: isDeepgramConfigured,
            wakeWord: 'HADES',
            locale: 'tr-TR'
        }
    };

    res.json(buildBridgeContextPayload({ runtime }));
});

app.get('/bridge/voice-config', (_req, res) => {
    const wakeRuntime = resolveNativeWakeRuntime(true);
    const nativeWakeSupported = detectNativeWakeSupport(true);
    res.json({
        deepgramConfigured: isDeepgramConfigured,
        deepgramApiKey: DEEPGRAM_API_KEY,
        wakeWord: 'HADES',
        locale: 'tr-TR',
        nativeWakeSupported,
        wakeRuntime
    });
});

app.get('/bridge/voice-overlay-state', (_req, res) => {
    res.json(voiceOverlayState);
});

app.post('/bridge/voice-overlay-state', (req, res) => {
    res.json({
        ok: true,
        state: sanitizeOverlayState(req.body || {})
    });
});

app.post('/bridge/wake-listener/start', (req, res) => {
    try {
        const result = startNativeWakeListener({
            instanceId: req.body?.instanceId || '',
            sessionId: req.body?.sessionId || '',
            locale: req.body?.locale || 'tr-TR',
            wakeWord: req.body?.wakeWord || 'HADES'
        });
        return res.json({
            ok: true,
            ...result
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message || 'Yerel wake listener başlatılamadı.'
        });
    }
});

app.post('/bridge/wake-listener/stop', (req, res) => {
    return res.json({
        ok: true,
        stopped: stopNativeWakeListener(req.body?.instanceId || '', req.body?.sessionId || '')
    });
});

app.post('/bridge/tts/speak', async (req, res) => {
    if (!isNativeBridgeVoiceEnabled) {
        return res.status(409).json({
            ok: false,
            disabled: true,
            message: 'Yerel bridge TTS devre dışı.'
        });
    }
    try {
        const result = await speakNativeText(req.body?.text || '', req.body?.locale || 'tr-TR');
        return res.json({
            ok: true,
            ...result
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message || 'Yerel TTS başlatılamadı.'
        });
    }
});

app.get('/bridge/tts/file/:fileId', (req, res) => {
    cleanupGeneratedTtsFiles();
    const fileId = String(req.params.fileId || '').trim();
    const fileInfo = generatedTtsFiles.get(fileId);
    if (!fileInfo?.path || !fs.existsSync(fileInfo.path)) {
        generatedTtsFiles.delete(fileId);
        return res.status(404).json({
            ok: false,
            message: 'TTS dosyası bulunamadı.'
        });
    }

    return res.sendFile(path.resolve(fileInfo.path));
});

app.post('/bridge/tts/stop', (_req, res) => {
    return res.json({
        ok: true,
        stopped: stopNativeTts()
    });
});

app.post('/bridge/reply-watch/start', (req, res) => {
    if (!isNativeBridgeVoiceEnabled) {
        return res.json({
            ok: true,
            skipped: true,
            disabled: true
        });
    }
    const instanceId = normalizeReplyInstanceId(req.body?.instanceId || '');
    if (!instanceId) {
        return res.status(400).json({
            ok: false,
            message: 'Reply watch için instanceId gerekli.'
        });
    }

    stopBackendReplyWatch(instanceId);
    backendReplyWatches.set(instanceId, {
        instanceId,
        baselineCount: Math.max(0, Number(req.body?.baselineCount) || 0),
        baselineSig: String(req.body?.baselineSig || '').trim(),
        startedAt: Date.now(),
        timeoutMs: Math.max(10000, Number(req.body?.timeoutMs) || 120000),
        lastSig: '',
        stableAt: 0,
        timer: null
    });
    scheduleBackendReplyWatch(instanceId, 120);
    sanitizeOverlayState({
        chip: 'Yanıt bekliyor',
        tone: 'ok',
        detail: 'HADES yanıtını bekliyor.',
        mode: 'reply',
        meter: 0
    });

    return res.json({
        ok: true
    });
});

app.post('/bridge/reply-watch/stop', (req, res) => {
    stopBackendReplyWatch(req.body?.instanceId || '');
    return res.json({
        ok: true
    });
});

app.get('/bridge/schedules/:kind', (req, res) => {
    const kind = normalizeScheduleKind(req.params.kind);
    if (!kind) {
        return res.status(400).json({ message: 'Geçersiz zamanlama türü.' });
    }

    try {
        return res.json({
            ok: true,
            kind,
            entries: getScheduleEntries(kind)
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Zamanlama veritabanı okunamadı.' });
    }
});

app.put('/bridge/schedules/:kind', (req, res) => {
    const kind = normalizeScheduleKind(req.params.kind);
    if (!kind) {
        return res.status(400).json({ message: 'Geçersiz zamanlama türü.' });
    }

    if (!Array.isArray(req.body?.entries)) {
        return res.status(400).json({ message: 'entries alanı dizi olmalıdır.' });
    }

    try {
        return res.json({
            ok: true,
            kind,
            entries: setScheduleEntries(kind, req.body.entries)
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Zamanlama veritabanı güncellenemedi.' });
    }
});

app.get('/bridge/active-alert', (_req, res) => {
    try {
        return res.json({
            ok: true,
            alert: takeDueScheduleAlert()
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message || 'Aktif alarm durumu alınamadı.'
        });
    }
});

app.post('/bridge/active-alert/dismiss', (req, res) => {
    try {
        const remaining = dismissScheduleAlert(req.body?.id || '');
        return res.json({
            ok: true,
            alert: remaining
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message || 'Aktif alarm kapatılamadı.'
        });
    }
});

app.get('/ops/state', async (_req, res) => {
    try {
        return res.json({
            ok: true,
            state: await buildOpsStatePayload()
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message || 'Ops state alinamadi.'
        });
    }
});

app.post('/ops/event', (req, res) => {
    const type = String(req.body?.type || '').trim();
    if (!type) {
        return res.status(400).json({
            ok: false,
            message: 'Ops event type gerekli.'
        });
    }

    const event = pushOpsEvent(type, req.body?.payload || {});
    return res.json({
        ok: true,
        event
    });
});

app.get('/ops/browser-state', (_req, res) => {
    return res.json({
        ok: true,
        browser: opsBrowserState
    });
});

app.get('/ops/ui-state', (_req, res) => {
    return res.json({
        ok: true,
        ui: opsUiState
    });
});

app.post('/ops/ui-state', (req, res) => {
    try {
        const ui = setOpsUiState({
            browserPanelVisible: req.body?.browserPanelVisible
        });
        const event = pushOpsEvent('ops.ui', {
            ui
        });
        return res.json({
            ok: true,
            ui,
            event
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message || 'Ops arayuz durumu guncellenemedi.'
        });
    }
});

app.post('/ops/browser/open', async (req, res) => {
    try {
        const { browser: resolvedBrowser, resolution } = await resolveOpsBrowserInput({
            url: req.body?.url || '',
            query: req.body?.query || '',
            title: req.body?.title || '',
            source: req.body?.source || 'system',
            reason: req.body?.reason || (req.body?.query ? 'search' : 'open')
        });
        const browser = setOpsBrowserState(resolvedBrowser);
        const ui = setOpsUiState({
            browserPanelVisible: true
        });
        const event = pushOpsEvent('browser.command', {
            browser,
            ui,
            resolution
        });
        return res.json({
            ok: true,
            browser,
            ui,
            event,
            resolution
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message || 'Ops browser komutu islenemedi.'
        });
    }
});

app.post('/ops/browser/report', (req, res) => {
    try {
        const browser = setOpsBrowserState({
            url: req.body?.url || opsBrowserState.url,
            query: req.body?.query || opsBrowserState.query,
            title: req.body?.title || opsBrowserState.title,
            source: req.body?.source || 'cockpit',
            reason: req.body?.reason || 'navigated'
        });
        const event = pushOpsEvent('browser.report', {
            browser
        });
        return res.json({
            ok: true,
            browser,
            event
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message || 'Ops browser durumu yazilamadi.'
        });
    }
});

app.get('/finance/rate', async (req, res) => {
    const base = String(req.query.base || 'USD').trim().toUpperCase();
    const quote = String(req.query.quote || 'TRY').trim().toUpperCase();

    if (!CURRENCY_CODE_REGEX.test(base) || !CURRENCY_CODE_REGEX.test(quote)) {
        return res.status(400).json({ message: 'base/quote 3 harfli para birimi kodu olmalidir. Ornek: USD, TRY.' });
    }

    if (base === quote) {
        return res.json({
            base,
            quote,
            rate: 1,
            source: 'local',
            fetchedAtISO: new Date().toISOString()
        });
    }

    const cacheKey = `${base}_${quote}`;
    const cached = fxCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.payload);
    }

    try {
        const response = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}`);
        if (!response.ok) {
            return res.status(502).json({ message: `Kur servisi hatası: ${response.status}` });
        }

        const data = await response.json();
        const rate = Number(data?.rates?.[quote]);
        if (!Number.isFinite(rate)) {
            return res.status(502).json({ message: `${base}/${quote} kuru alinamadi.` });
        }

        const payload = {
            base,
            quote,
            rate,
            source: 'frankfurter',
            fetchedAtISO: new Date().toISOString()
        };
        fxCache.set(cacheKey, { payload, expiresAt: Date.now() + FX_CACHE_TTL_MS });
        res.json(payload);
    } catch (error) {
        res.status(502).json({ message: `Kur servisine ulasilamadi: ${error.message}` });
    }
});

app.post('/web/search', async (req, res) => {
    const rawQuery = normalizeSearchQuery(req.body?.query || req.body?.q || '');
    const query = optimizeSearchQuery(rawQuery);
    if (!rawQuery || !query) {
        return res.status(400).json({ ok: false, message: 'Arama sorgusu bos olamaz.' });
    }

    const cacheKey = query.toLowerCase();
    const cached = webSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.payload);
    }

    const startedAt = Date.now();
    const intent = detectWebIntent(rawQuery);
    try {
        const candidateQueries = buildSearchCandidates(query, intent);
        const htmlSettled = await Promise.allSettled(
            candidateQueries.map((candidate) => fetchDuckDuckGoHtmlResults(candidate))
        );
        const [instantResult] = await Promise.allSettled([
            fetchDuckDuckGoInstantData(query)
        ]);

        const instantAbstract = instantResult.status === 'fulfilled' ? instantResult.value.abstract : '';
        const instantRelated = instantResult.status === 'fulfilled' ? instantResult.value.related : [];
        const htmlResults = htmlSettled
            .filter((entry) => entry.status === 'fulfilled')
            .flatMap((entry) => entry.value || []);

        const mergedResults = mergeSearchResults([
            ...htmlResults,
            ...instantRelated
        ]);
        const rankedResults = prioritizeWebResults(rawQuery, mergedResults, intent).slice(0, 6);

        const selected = await resolveSearchSelection(rawQuery, intent, rankedResults);
        const payload = {
            ok: true,
            query: rawQuery,
            effectiveQuery: query,
            answer: buildWebAnswer({
                query: rawQuery,
                abstract: instantAbstract,
                results: rankedResults,
                intent,
                selected
            }),
            results: rankedResults,
            selected,
            searchUrl: `https://www.google.com/search?q=${encodeURIComponent(rawQuery)}`,
            source: 'duckduckgo',
            fetchedAtISO: new Date().toISOString(),
            latencyMs: Date.now() - startedAt,
            intent
        };

        webSearchCache.set(cacheKey, {
            payload,
            expiresAt: Date.now() + WEB_CACHE_TTL_MS
        });

        return res.json(payload);
    } catch (error) {
        return res.status(502).json({
            ok: false,
            message: `Web araması başarısız: ${error.message}`,
            query: rawQuery || query,
            searchUrl: `https://www.google.com/search?q=${encodeURIComponent(rawQuery || query)}`
        });
    }
});

// --- Spotify Entegrasyonu ---
const TOKEN_PATH = path.join(__dirname, 'spotify-token.json');
const spotifyApi = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
    redirectUri: SPOTIFY_REDIRECT_URI
});

const spotifyScopes = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing'
];
let spotifyRefreshIntervalId = null;
let spotifyRefreshInFlight = null;
const SPOTIFY_DEVICE_WAIT_ATTEMPTS = 5;
const SPOTIFY_DEVICE_WAIT_DELAY_MS = 1200;
const SPOTIFY_TRANSFER_SETTLE_MS = 900;

const readSpotifyTokensFromDisk = () => {
    if (!fs.existsSync(TOKEN_PATH)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
};

const saveSpotifyTokensToDisk = (payload = {}) => {
    try {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2));
    } catch (error) {
        console.warn(`Spotify token dosyasi yazilamadi: ${error.message}`);
    }
};

const getSpotifyErrorMessage = (error) => {
    if (!error) return '';
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (typeof error.body?.error?.message === 'string' && error.body.error.message.trim()) {
        return error.body.error.message.trim();
    }
    if (typeof error.body?.error_description === 'string' && error.body.error_description.trim()) {
        return error.body.error_description.trim();
    }
    return String(error || '');
};

const isSpotifyAuthError = (error) => {
    const statusCode = Number(error?.statusCode || error?.status || error?.response?.status || 0);
    const message = getSpotifyErrorMessage(error).toLowerCase();
    if (statusCode === 401) return true;
    return /(token|auth|yetki|oturum).*(expired|invalid|gecersiz|suresi doldu|dolmus)/i.test(message)
        || /no token provided|the access token expired|invalid access token/i.test(message);
};

const scheduleSpotifyTokenRefresh = (expiresInSeconds = 3600) => {
    if (spotifyRefreshIntervalId) {
        clearInterval(spotifyRefreshIntervalId);
        spotifyRefreshIntervalId = null;
    }
    const refreshInMs = Math.max(60000, Math.floor(Number(expiresInSeconds || 3600) * 0.6 * 1000));
    spotifyRefreshIntervalId = setInterval(() => {
        refreshSpotifyToken().catch((err) => {
            console.error('Periyodik Spotify token yenileme hatası:', err);
        });
    }, refreshInMs);
};

async function refreshSpotifyToken() {
    if (!isSpotifyConfigured) return false;
    if (spotifyRefreshInFlight) return spotifyRefreshInFlight;

    spotifyRefreshInFlight = (async () => {
        try {
            const diskTokens = readSpotifyTokensFromDisk();
            const refreshToken = spotifyApi.getRefreshToken() || diskTokens.refreshToken;
            if (!refreshToken) {
                throw new Error('Spotify refresh token bulunamadı. Lütfen /spotify/login ile yeniden bağlan.');
            }

            spotifyApi.setRefreshToken(refreshToken);
            const data = await spotifyApi.refreshAccessToken();
            const accessToken = data?.body?.access_token;
            if (!accessToken) {
                throw new Error('Spotify yeni access token dönmedi.');
            }

            const nextRefreshToken = data?.body?.refresh_token || refreshToken;
            const expiresIn = Number(data?.body?.expires_in || 3600);
            spotifyApi.setAccessToken(accessToken);
            spotifyApi.setRefreshToken(nextRefreshToken);

            saveSpotifyTokensToDisk({
                ...diskTokens,
                accessToken,
                refreshToken: nextRefreshToken,
                expiresIn,
                updatedAt: Date.now()
            });
            scheduleSpotifyTokenRefresh(expiresIn);
            console.log('Spotify access token yenilendi.');
            return true;
        } catch (error) {
            console.error('Spotify token yenileme hatası:', error);
            return false;
        } finally {
            spotifyRefreshInFlight = null;
        }
    })();

    return spotifyRefreshInFlight;
}

async function ensureSpotifyAuthReady() {
    if (!isSpotifyConfigured) return false;
    if (spotifyApi.getAccessToken()) return true;
    return refreshSpotifyToken();
}

async function withSpotifyAuthRetry(operation) {
    try {
        return await operation();
    } catch (error) {
        if (!isSpotifyAuthError(error)) throw error;

        console.warn('Spotify auth hatası alındı, token yenileme deneniyor...');
        const refreshed = await refreshSpotifyToken();
        if (!refreshed) {
            throw new Error(
                "Spotify oturumu süresi dolmuş babacığım. Lütfen bir kez /spotify/login ile yeniden bağlan."
            );
        }
        return operation();
    }
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function pickSpotifyTargetDevice(devices = []) {
    const list = Array.isArray(devices) ? devices.filter(Boolean) : [];
    return list.find((device) => device.is_active)
        || list.find((device) => !device.is_restricted && (device.type === 'Computer' || device.type === 'Smartphone'))
        || list.find((device) => !device.is_restricted)
        || null;
}

async function readSpotifyDeviceState() {
    const playbackState = await withSpotifyAuthRetry(() => spotifyApi.getMyCurrentPlaybackState());
    const devicesResponse = await withSpotifyAuthRetry(() => spotifyApi.getMyDevices());
    const devices = Array.isArray(devicesResponse?.body?.devices) ? devicesResponse.body.devices : [];
    const activeDevice = devices.find((device) => device?.is_active)
        || (playbackState?.body?.device?.is_active ? playbackState.body.device : null);
    const availableDevice = activeDevice || pickSpotifyTargetDevice(devices);

    return {
        playbackState: playbackState?.body || null,
        devices,
        activeDevice,
        availableDevice
    };
}

async function getSpotifyStatusSnapshot() {
    const authenticated = await ensureSpotifyAuthReady();
    const tokens = readSpotifyTokensFromDisk();
    const baseStatus = {
        configured: isSpotifyConfigured,
        authenticated: Boolean(authenticated),
        ready: Boolean(authenticated),
        deviceReady: false,
        activeDevice: false,
        deviceCount: 0,
        activeDeviceName: null,
        availableDeviceName: null,
        redirectUri: SPOTIFY_REDIRECT_URI,
        hasRefreshToken: Boolean(tokens.refreshToken),
        hasAccessToken: Boolean(tokens.accessToken || spotifyApi.getAccessToken())
    };

    if (!authenticated) {
        return baseStatus;
    }

    try {
        const state = await readSpotifyDeviceState();
        return {
            ...baseStatus,
            deviceReady: Boolean(state.availableDevice),
            activeDevice: Boolean(state.activeDevice),
            deviceCount: state.devices.length,
            activeDeviceName: state.activeDevice?.name || null,
            availableDeviceName: state.availableDevice?.name || null
        };
    } catch (error) {
        return {
            ...baseStatus,
            statusError: getSpotifyErrorMessage(error) || 'Spotify cihaz durumu alınamadı.'
        };
    }
}

// --- Baglanti Yonetimi ---
let isTuyaConnected = false;
let lastTuyaErrorMessage = null;
let tuyaConnectInFlight = null;
let tuyaReconnectTimer = null;
let tuyaReconnectAttempt = 0;
let tuyaLastConnectedAt = 0;
let isTuyaShutdownRequested = false;
const TUYA_RECONNECT_DELAYS_MS = [1500, 4000, 10000, 20000, 30000];

function clearTuyaReconnectTimer() {
    if (tuyaReconnectTimer) {
        clearTimeout(tuyaReconnectTimer);
        tuyaReconnectTimer = null;
    }
}

function disconnectTuyaSocket() {
    if (!device) return;
    try {
        device.disconnect();
    } catch (_) {
        // Socket zaten kapali olabilir.
    }
}

function shouldRetryWithDiscovery(error) {
    const msg = String(error && error.message ? error.message : error || '');
    return /(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed out|No IP|Not found)/i.test(msg);
}

function getNextTuyaReconnectDelay() {
    const index = Math.min(tuyaReconnectAttempt, TUYA_RECONNECT_DELAYS_MS.length - 1);
    return TUYA_RECONNECT_DELAYS_MS[index];
}

function scheduleTuyaReconnect(reason = 'unknown') {
    if (!isTuyaConfigured || !device || isTuyaShutdownRequested) return;
    if (tuyaReconnectTimer || tuyaConnectInFlight) return;

    const delayMs = getNextTuyaReconnectDelay();
    tuyaReconnectAttempt += 1;
    console.log(`Tuya yeniden bağlantı planlandı. Sebep=${reason}, deneme=${tuyaReconnectAttempt}, bekleme=${delayMs}ms`);

    tuyaReconnectTimer = setTimeout(() => {
        tuyaReconnectTimer = null;
        ensureTuyaConnected({ forceReconnect: true })
            .catch((error) => {
                lastTuyaErrorMessage = error.message || String(error);
                console.error('Tuya otomatik yeniden bağlantı hatası:', error);
                scheduleTuyaReconnect('retry_failed');
            });
    }, delayMs);
}

async function connectTuya({ forceDiscovery = false, forceReconnect = false } = {}) {
    if (!isTuyaConfigured || !device) {
        throw new Error('Tuya ayarları eksik. TUYA_DEVICE_ID ve TUYA_DEVICE_KEY tanımlanmalı.');
    }

    if (tuyaConnectInFlight) {
        return tuyaConnectInFlight;
    }

    tuyaConnectInFlight = (async () => {
        clearTuyaReconnectTimer();

        if (forceReconnect) {
            disconnectTuyaSocket();
            isTuyaConnected = false;
        }

        const configuredIp = TUYA_CONFIGURED_IP || '';

        const attemptDiscoveryConnection = async () => {
            device.device.ip = undefined;
            console.log('Tuya keşif başlatılıyor... (mode=discovery)');
            await device.find({ timeout: 10 });
            console.log(`Tuya keşif sonucu IP: ${device.device.ip || 'bulunamadı'}`);
            console.log('Tuya cihazına keşif sonucu ile bağlanılıyor...');
            await device.connect();
        };

        const attemptDirectConnection = async () => {
            if (!configuredIp) {
                throw new Error('Doğrudan bağlantı için yapılandırılmış Tuya IP bulunamadı.');
            }
            device.device.ip = configuredIp;
            console.log(`Tuya doğrudan IP ile deneniyor: ${configuredIp}`);
            await device.connect();
        };

        try {
            try {
                if (forceDiscovery) {
                    await attemptDiscoveryConnection();
                } else {
                    await attemptDiscoveryConnection();
                }
            } catch (error) {
                console.error('Tuya ilk bağlantı hatası:', error);
                if (forceDiscovery || !configuredIp || !shouldRetryWithDiscovery(error)) {
                    throw error;
                }

                console.log('Tuya bağlantısı yapılandırılmış IP ile fallback deneniyor...');
                await attemptDirectConnection();
            }

            isTuyaConnected = true;
            lastTuyaErrorMessage = null;
            tuyaReconnectAttempt = 0;
            tuyaLastConnectedAt = Date.now();
            console.log('Tuya cihazına başarıyla bağlandı.');
        } catch (error) {
            isTuyaConnected = false;
            lastTuyaErrorMessage = error.message || String(error);
            throw new Error(`Akıllı lambaya bağlanılamadı: ${lastTuyaErrorMessage}`);
        }
    })();

    try {
        await tuyaConnectInFlight;
    } finally {
        tuyaConnectInFlight = null;
    }
}

async function ensureTuyaConnected({ forceReconnect = false } = {}) {
    if (!isTuyaConfigured || !device) {
        throw new Error('Tuya ayarları eksik. TUYA_DEVICE_ID ve TUYA_DEVICE_KEY tanımlanmalı.');
    }
    if (isTuyaConnected && !forceReconnect) {
        return;
    }

    await connectTuya({ forceDiscovery: false, forceReconnect });
}

// Cihaz olaylari
if (device) {
    device.on('error', error => {
        console.error('Tuya Cihaz Hatası:', error);
        isTuyaConnected = false;
        lastTuyaErrorMessage = error.message || String(error);
        scheduleTuyaReconnect('socket_error');
    });

    device.on('disconnected', () => {
        console.log('Tuya cihaz bağlantısı kesildi.');
        isTuyaConnected = false;
        if (isTuyaShutdownRequested) return;
        scheduleTuyaReconnect('socket_closed');
    });
}

// Isigi kontrol endpoint'i
app.post('/light', async (req, res) => {
    const { action, brightness, hsv } = req.body;

    if (!action) {
        return res.status(400).json({ message: 'Eylem belirtilmedi.' });
    }
    if (!isTuyaConfigured || !device) {
        return res.status(503).json({ message: 'Tuya ayarları eksik. Sunucuda TUYA_DEVICE_ID ve TUYA_DEVICE_KEY tanımlayın.' });
    }

    try {
        const rawAction = String(action).trim().toLowerCase();
        const actionAliases = {
            'on': 'on',
            'off': 'off',
            'ac': 'on',
            'aç': 'on',
            'yak': 'on',
            'kapat': 'off',
            'sondur': 'off',
            'söndür': 'off',
            'goodnight': 'goodnight',
            'iyi geceler': 'goodnight'
        };
        const resolvedAction = actionAliases[rawAction] || rawAction;
        const hasBrightness = brightness !== undefined && brightness !== null && brightness !== '';
        const hasHsv = typeof hsv === 'string' && hsv.trim().length > 0;

        if (!hasBrightness && !hasHsv && !['on', 'off', 'goodnight'].includes(resolvedAction)) {
            return res.status(400).json({ message: `Geçersiz lamba eylemi: ${action}` });
        }

        await ensureTuyaConnected();
        const status = resolvedAction === 'on';

        const commands = {
            multiple: true,
            data: {
                '20': resolvedAction === 'goodnight' ? false : ((hasBrightness || hasHsv) ? true : status),
            }
        };

        if (hasBrightness) {
            const parsedBrightness = parseInt(brightness, 10);
            if (Number.isNaN(parsedBrightness)) {
                return res.status(400).json({ message: 'Geçersiz parlaklık değeri.' });
            }
            const clampedBrightness = Math.max(10, Math.min(1000, parsedBrightness));
            commands.data['21'] = 'white';
            commands.data['22'] = clampedBrightness;
            console.log(`Parlaklık ayarlanıyor: ${clampedBrightness}`);
        }

        if (hasHsv) {
            commands.data['21'] = 'colour';
            commands.data['24'] = hsv;
            console.log(`Renk ayarlanıyor: ${hsv}`);
        }

        await device.set(commands);

        let responseMessage = '';
        if (hasBrightness) {
            responseMessage = 'Lambanın parlaklığını ayarladım babacığım.';
        } else if (resolvedAction === 'goodnight') {
            responseMessage = 'İyi geceler babacığım.';
        } else if (hasHsv) {
            responseMessage = 'Lambanın rengini değiştirdim babacığım.';
        } else {
            responseMessage = `Lamba ${status ? 'açıldı' : 'kapatıldı'} babacığım.`;
        }
        res.json({ message: responseMessage });

    } catch (error) {
        console.error('Lamba kontrolü sırasında hata:', error);
        if (isTuyaConnected) {
            try { device.disconnect(); } catch (disconnectError) {}
        }
        isTuyaConnected = false;
        lastTuyaErrorMessage = error.message || String(error);
        res.status(500).json({ message: `Üzgünüm babacığım, lambayı kontrol ederken bir sorun oluştu. ${lastTuyaErrorMessage}` });
    }
});

app.get('/light/status', async (req, res) => {
    res.json({
        configured: isTuyaConfigured,
        connected: isTuyaConnected,
        configuredIp: TUYA_CONFIGURED_IP,
        resolvedIp: device?.device?.ip || null,
        reconnectAttempt: tuyaReconnectAttempt,
        reconnectScheduled: Boolean(tuyaReconnectTimer),
        lastConnectedAt: tuyaLastConnectedAt || null,
        lastError: lastTuyaErrorMessage
    });
});

// --- Spotify Endpoint'leri ---
app.get('/spotify/login', (req, res) => {
    if (!isSpotifyConfigured) {
        return res.status(503).send('Spotify ayarları eksik. SPOTIFY_CLIENT_ID ve SPOTIFY_CLIENT_SECRET tanımlanmalı.');
    }
    res.redirect(spotifyApi.createAuthorizeURL(spotifyScopes));
});

app.get('/spotify/callback', async (req, res) => {
    if (!isSpotifyConfigured) {
        return res.status(503).send('Spotify ayarları eksik. SPOTIFY_CLIENT_ID ve SPOTIFY_CLIENT_SECRET tanımlanmalı.');
    }
    const { code } = req.query;
    try {
        const data = await spotifyApi.authorizationCodeGrant(code);
        const accessToken = data.body['access_token'];
        const refreshToken = data.body['refresh_token'];

        spotifyApi.setAccessToken(accessToken);
        spotifyApi.setRefreshToken(refreshToken);

        const expiresIn = Number(data.body['expires_in'] || 3600);
        saveSpotifyTokensToDisk({
            accessToken,
            refreshToken,
            expiresIn,
            updatedAt: Date.now()
        });
        scheduleSpotifyTokenRefresh(expiresIn);
        console.log('Spotify yetkilendirmesi başarılı! Token alındı.');

        res.send('<h1>Spotify bağlantısı başarılı!</h1><p>Bu pencereyi kapatabilirsiniz.</p><script>window.close();</script>');
    } catch (error) {
        console.error('Spotify token alma hatası:', error);
        res.status(500).send('Spotify yetkilendirmesi sırasında bir hata oluştu.');
    }
});

app.get('/spotify/status', async (_req, res) => {
    res.json(await getSpotifyStatusSnapshot());
});

async function ensureActiveDevice({
    attempts = SPOTIFY_DEVICE_WAIT_ATTEMPTS,
    delayMs = SPOTIFY_DEVICE_WAIT_DELAY_MS
} = {}) {
    if (!isSpotifyConfigured) {
        throw new Error('Spotify ayarları eksik. SPOTIFY_CLIENT_ID ve SPOTIFY_CLIENT_SECRET tanımlanmalı.');
    }
    let lastError = null;

    for (let attempt = 0; attempt < Math.max(1, Number(attempts) || 1); attempt += 1) {
        const state = await readSpotifyDeviceState();
        if (state.activeDevice) {
            console.log('Aktif bir Spotify cihazı zaten var.');
            return {
                ...state,
                targetDevice: state.activeDevice
            };
        }

        if (state.availableDevice?.id) {
            console.log(`Oynatmak için hedef cihaz seçildi: ${state.availableDevice.name} (${state.availableDevice.id})`);
            try {
                await withSpotifyAuthRetry(() => spotifyApi.transferMyPlayback([state.availableDevice.id]));
                console.log('Oynatma hedef cihaza aktarıldı.');
                await wait(SPOTIFY_TRANSFER_SETTLE_MS);
                const refreshedState = await readSpotifyDeviceState();
                return {
                    ...refreshedState,
                    targetDevice: refreshedState.activeDevice || refreshedState.availableDevice || state.availableDevice
                };
            } catch (error) {
                lastError = error;
            }
        } else {
            console.log('Aktif bir Spotify cihazı bulunamadı. Mevcut cihazlar bekleniyor...');
        }

        if (attempt < attempts - 1) {
            await wait(delayMs);
        }
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error('Spotify\'ı çalabileceğim hiçbir cihazınızı açık bulamadım babacığım. Lütfen bir cihazda Spotify uygulamasını açın ve birkaç saniye sonra tekrar deneyin.');
}

app.post('/spotify/prepare', async (_req, res) => {
    if (!isSpotifyConfigured) {
        return res.status(503).json({ message: 'Spotify ayarları eksik. SPOTIFY_CLIENT_ID ve SPOTIFY_CLIENT_SECRET tanımlanmalı.' });
    }

    const spotifyStatus = await getSpotifyStatusSnapshot();
    if (!spotifyStatus.authenticated) {
        return res.status(401).json({
            message: 'Spotify oturumu hazır değil. Lütfen /spotify/login adresinden bir kez bağlanın.',
            status: spotifyStatus
        });
    }

    try {
        const deviceState = await ensureActiveDevice();
        const nextStatus = await getSpotifyStatusSnapshot();
        const targetName = nextStatus.activeDeviceName || nextStatus.availableDeviceName || deviceState?.targetDevice?.name || 'Spotify cihazı';
        return res.json({
            ok: true,
            prepared: true,
            status: nextStatus,
            message: `${targetName} hazır babacığım.`
        });
    } catch (error) {
        return res.status(409).json({
            ok: false,
            status: await getSpotifyStatusSnapshot(),
            message: getSpotifyErrorMessage(error) || 'Spotify cihazı hazırlanamadı.'
        });
    }
});

app.post('/spotify/play', async (req, res) => {
    const { query, track: trackName, artist: artistName } = req.body;

    if (!isSpotifyConfigured) {
        return res.status(503).json({ message: 'Spotify ayarları eksik. SPOTIFY_CLIENT_ID ve SPOTIFY_CLIENT_SECRET tanımlanmalı.' });
    }

    const spotifyReady = await ensureSpotifyAuthReady();
    if (!spotifyReady) {
        return res.status(401).json({ message: 'Spotify oturumu hazır değil. Lütfen /spotify/login adresinden bir kez bağlanın.' });
    }

    if (!query && !trackName && !artistName) {
        return res.status(400).json({ message: 'Çalınacak şarkı veya sanatçı belirtilmedi.' });
    }

    try {
        const deviceState = await ensureActiveDevice();

        let finalQuery;
        let userFriendlyQuery;

        if (trackName || artistName) {
            let queryParts = [];
            if (trackName) {
                queryParts.push(`track:"${trackName}"`);
            }
            if (artistName) {
                queryParts.push(`artist:"${artistName}"`);
            }
            finalQuery = queryParts.join(' ');
            userFriendlyQuery = `${artistName || ''} - ${trackName || ''}`.trim();
        } else {
            finalQuery = query;
            userFriendlyQuery = query;
        }

        console.log(`Spotify için hassas arama sorgusu oluşturuldu: ${finalQuery}`);

        const searchResult = await withSpotifyAuthRetry(() => spotifyApi.searchTracks(finalQuery, { limit: 1 }));

        if (searchResult.body.tracks.items.length === 0) {
            console.log(`'${userFriendlyQuery}' için sonuç bulunamadı.`);
            return res.status(404).json({ message: `Üzgünüm babacığım, '${userFriendlyQuery}' için bir sonuç bulamadım.` });
        }

        const track = searchResult.body.tracks.items[0];
        const trackUri = track.uri;

        const playPayload = { uris: [trackUri] };
        if (deviceState?.targetDevice?.id) {
            playPayload.device_id = deviceState.targetDevice.id;
        }

        await withSpotifyAuthRetry(() => spotifyApi.play(playPayload));

        console.log(`Spotify'da çalınıyor: ${track.name} - ${track.artists[0].name}`);
        res.json({ message: `Elbette babacığım, ${track.artists[0].name} sanatçısından ${track.name} çalıyorum.` });

    } catch (error) {
        console.error('Spotify çalma hatası:', error);
        res.status(500).json({ message: getSpotifyErrorMessage(error) || "Spotify'da bir şeyler ters gitti babacığım." });
    }
});

app.post('/spotify/control', async (req, res) => {
    const { action, value } = req.body;

    if (!isSpotifyConfigured) {
        return res.status(503).json({ message: 'Spotify ayarları eksik. SPOTIFY_CLIENT_ID ve SPOTIFY_CLIENT_SECRET tanımlanmalı.' });
    }

    const spotifyReady = await ensureSpotifyAuthReady();
    if (!spotifyReady) {
        return res.status(401).json({ message: 'Spotify oturumu hazır değil. Lütfen /spotify/login ile yeniden bağlanın.' });
    }

    try {
        await ensureActiveDevice();

        const normalizedAction = String(action || '').trim().toLowerCase();
        const actionAliases = {
            durdur: 'pause',
            duraklat: 'pause',
            pause: 'pause',
            'devam et': 'resume',
            resume: 'resume',
            oynat: 'resume',
            cal: 'resume',
            çal: 'resume',
            sonraki: 'next',
            next: 'next',
            atla: 'next',
            onceki: 'previous',
            önceki: 'previous',
            previous: 'previous',
            volume: 'volume'
        };
        const resolvedAction = actionAliases[normalizedAction] || normalizedAction;

        let message = '';
        switch (resolvedAction) {
            case 'pause':
                await withSpotifyAuthRetry(() => spotifyApi.pause());
                message = 'Müzik durduruldu babacığım.';
                break;
            case 'resume':
                await withSpotifyAuthRetry(() => spotifyApi.play());
                message = 'Müziğe devam ediyorum babacığım.';
                break;
            case 'next':
                await withSpotifyAuthRetry(() => spotifyApi.skipToNext());
                message = 'Sonraki şarkıya geçtim babacığım.';
                break;
            case 'previous':
                await withSpotifyAuthRetry(() => spotifyApi.skipToPrevious());
                message = 'Önceki şarkıya döndüm babacığım.';
                break;
            case 'volume':
                const volumeValue = parseInt(value, 10);
                if (isNaN(volumeValue) || volumeValue < 0 || volumeValue > 100) {
                    return res.status(400).json({ message: 'Geçersiz ses seviyesi. 0 ile 100 arasında bir değer olmalı.' });
                }
                await withSpotifyAuthRetry(() => spotifyApi.setVolume(volumeValue));
                message = `Spotify ses seviyesi yüzde ${volumeValue} olarak ayarlandı babacığım.`;
                break;
            default:
                return res.status(400).json({ message: 'Geçersiz Spotify kontrol eylemi.' });
        }
        console.log(`Spotify kontrolü: ${resolvedAction}${value !== undefined ? `, Değer: ${value}` : ''}`);
        res.json({ message });
    } catch (error) {
        console.error(`Spotify ${action} hatası:`, error);
        res.status(500).json({ message: getSpotifyErrorMessage(error) || "Spotify'da bu işlemi yaparken bir hata oluştu babacığım." });
    }
});

/*
app.post('/alarm', (req, res) => {
    const { action, text } = req.body;

    if (!action || !text) {
        return res.status(400).json({ message: 'Eylem veya komut metni belirtilmedi.' });
    }

    const time = alarmManager.extractTime(text);

    let result;
    if (action === 'set') {
        result = alarmManager.setAlarm(time);
    } else if (action === 'remove') {
        result = alarmManager.removeAlarm(time);
    } else {
        return res.status(400).json({ message: 'Geçersiz alarm eylemi. Sadece "set" veya "remove" kullanılabilir.' });
    }

    if (result.success) {
        res.json({ message: result.message });
    } else {
        res.status(404).json({ message: result.message });
    }
});
*/

/*
app.get('/alarms', (req, res) => {
    const alarms = alarmManager.getAlarms();
    res.json(alarms);
});
*/

function loadSpotifyToken() {
    if (!isSpotifyConfigured) return;
    if (fs.existsSync(TOKEN_PATH)) {
        const { accessToken, refreshToken, expiresIn } = readSpotifyTokensFromDisk();
        if (refreshToken) {
            if (accessToken) spotifyApi.setAccessToken(accessToken);
            spotifyApi.setRefreshToken(refreshToken);
            refreshSpotifyToken().catch(err => console.error('Başlangıçta token yenilenemedi:', err));
            if (expiresIn) scheduleSpotifyTokenRefresh(expiresIn);
            console.log("Kaydedilmis Spotify token'i yuklendi ve yenilendi.");
        }
    }
}

let httpServer = null;
let spotifyTokenLoaded = false;

function logStartupWarnings() {
    if (!isSpotifyConfigured) {
        console.warn('Spotify devre dışı: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET tanımlı değil.');
    }
    if (!isDeepgramConfigured) {
        console.warn('Deepgram devre dışı: DEEPGRAM_API_KEY tanımlı değil.');
    }
    if (!isTuyaConfigured) {
        console.warn('Tuya devre dışı: TUYA_DEVICE_ID / TUYA_DEVICE_KEY tanımlı değil.');
    }
    if (!isOpenAiConfigured) {
        console.warn('OpenAI backend proxy devre dışı: OPENAI_API_KEY tanımlı değil.');
    }
}

function startServer({ port = DEFAULT_PORT, connectTuyaOnStart = true, loadSpotifyOnStart = true } = {}) {
    if (httpServer?.listening) {
        return Promise.resolve(httpServer);
    }

    isTuyaShutdownRequested = false;

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            httpServer = server;
            const activePort = server.address()?.port || port;
            bridgeWsServer = new WebSocketServer({ noServer: true });
            wakeWsServer = new WebSocketServer({ noServer: true });
            opsWsServer = new WebSocketServer({ noServer: true });
            server.on('upgrade', (request, socket, head) => {
                const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${activePort}`);
                const pathname = requestUrl.pathname;
                const target = pathname === '/bridge/reply-events'
                    ? bridgeWsServer
                    : (pathname === '/bridge/wake-events'
                        ? wakeWsServer
                        : (pathname === '/ops/events' ? opsWsServer : null));

                if (!target) {
                    try { socket.destroy(); } catch (_) {}
                    return;
                }

                target.handleUpgrade(request, socket, head, (ws) => {
                    target.emit('connection', ws, request);
                });
            });
            bridgeWsServer.on('connection', (socket, request) => {
                const requestUrl = new URL(request.url || '/bridge/reply-events', `http://127.0.0.1:${activePort}`);
                const instanceId = normalizeReplyInstanceId(requestUrl.searchParams.get('instanceId') || '');
                if (!instanceId) {
                    try { socket.close(); } catch (_) {}
                    return;
                }

                const previous = replyEventClients.get(instanceId);
                if (previous && previous !== socket) {
                    try { previous.close(); } catch (_) {}
                }

                replyEventClients.set(instanceId, socket);
                socket.on('close', () => {
                    if (replyEventClients.get(instanceId) === socket) {
                        replyEventClients.delete(instanceId);
                        stopBackendReplyWatch(instanceId);
                    }
                });
                socket.on('error', () => {
                    if (replyEventClients.get(instanceId) === socket) {
                        replyEventClients.delete(instanceId);
                    }
                });
            });
            wakeWsServer.on('connection', (socket, request) => {
                const requestUrl = new URL(request.url || '/bridge/wake-events', `http://127.0.0.1:${activePort}`);
                const instanceId = normalizeReplyInstanceId(requestUrl.searchParams.get('instanceId') || '');
                if (!instanceId) {
                    try { socket.close(); } catch (_) {}
                    return;
                }

                const previous = wakeEventClients.get(instanceId);
                if (previous && previous !== socket) {
                    try { previous.close(); } catch (_) {}
                }

                wakeEventClients.set(instanceId, socket);
                socket.on('close', () => {
                    if (wakeEventClients.get(instanceId) === socket) {
                        wakeEventClients.delete(instanceId);
                    }
                });
                socket.on('error', () => {
                    if (wakeEventClients.get(instanceId) === socket) {
                        wakeEventClients.delete(instanceId);
                    }
                });
            });
            opsWsServer.on('connection', (socket) => {
                opsEventClients.add(socket);
                try {
                    socket.send(JSON.stringify({
                        type: 'ops:snapshot',
                        browser: opsBrowserState,
                        ui: opsUiState,
                        recentEvents: [...opsEventLog].slice(-40).reverse()
                    }));
                } catch (_) {
                    opsEventClients.delete(socket);
                }
                socket.on('close', () => {
                    opsEventClients.delete(socket);
                });
                socket.on('error', () => {
                    opsEventClients.delete(socket);
                });
            });
            console.log(`HADES Akıllı Ev Sunucusu http://localhost:${activePort} adresinde çalışıyor.`);
            pushOpsEvent('server.started', {
                port: activePort
            });

            if (loadSpotifyOnStart && !spotifyTokenLoaded) {
                loadSpotifyToken();
                spotifyTokenLoaded = true;
            }

            logStartupWarnings();

            if (connectTuyaOnStart && isTuyaConfigured) {
                ensureTuyaConnected().catch(err => console.error('Sunucu başlangıcında Tuya bağlantısı kurulamadı:', err));
            }

            resolve(server);
        });

        server.once('error', (error) => {
            reject(error);
        });
    });
}

function stopServer() {
    isTuyaShutdownRequested = true;
    clearTuyaReconnectTimer();
    disconnectTuyaSocket();
    for (const instanceId of backendReplyWatches.keys()) {
        stopBackendReplyWatch(instanceId);
    }
    for (const socket of replyEventClients.values()) {
        try { socket.close(); } catch (_) {}
    }
    replyEventClients.clear();
    for (const socket of wakeEventClients.values()) {
        try { socket.close(); } catch (_) {}
    }
    wakeEventClients.clear();
    for (const socket of [...opsEventClients]) {
        try { socket.close(); } catch (_) {}
    }
    opsEventClients.clear();
    opsEventLog.length = 0;
    opsBrowserState = defaultOpsBrowserState();
    opsUiState = defaultOpsUiState();
    if (bridgeWsServer) {
        try { bridgeWsServer.close(); } catch (_) {}
        bridgeWsServer = null;
    }
    if (wakeWsServer) {
        try { wakeWsServer.close(); } catch (_) {}
        wakeWsServer = null;
    }
    if (opsWsServer) {
        try { opsWsServer.close(); } catch (_) {}
        opsWsServer = null;
    }
    stopNativeWakeListener();
    stopNativeTts();

    if (spotifyRefreshIntervalId) {
        clearInterval(spotifyRefreshIntervalId);
        spotifyRefreshIntervalId = null;
    }

    if (!httpServer) {
        return Promise.resolve();
    }

    const serverToClose = httpServer;
    httpServer = null;

    return new Promise((resolve, reject) => {
        serverToClose.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error('HADES sunucusu başlatılamadı:', error);
        process.exitCode = 1;
    });
}

module.exports = {
    app,
    startServer,
    stopServer
};
