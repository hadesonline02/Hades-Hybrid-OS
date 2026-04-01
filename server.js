// server.js

const express = require('express');
const TuyaDevice = require('tuyapi');
const SpotifyWebApi = require('spotify-web-api-node');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
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
let voiceOverlayState = defaultVoiceOverlayState();
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
    const wantsYoutube = /\b(youtube|yt|kanal|channel)\b/.test(normalized);
    const officialChannel = /\b(resmi|official)\b/.test(normalized) && wantsYoutube;
    const latestVideo = /\b(en son|son video|latest)\b/.test(normalized) && /\b(video|videoyu|youtube|yt)\b/.test(normalized);
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

    if (intent.latestVideo && isYoutubeWatchUrl(url)) score += 120;
    if (intent.latestVideo && isYoutubeChannelUrl(url)) score += 70;
    if (intent.officialChannel && isYoutubeChannelUrl(url)) score += 120;
    if (intent.officialChannel && isYoutubeWatchUrl(url)) score += 40;
    if (intent.wantsYoutube && isYoutubeUrl(url)) score += 50;
    if (intent.wantsLink && (isYoutubeChannelUrl(url) || isYoutubeWatchUrl(url))) score += 20;
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
    }
    if (intent.officialChannel) {
        candidates.push(`${query} resmi youtube kanali`);
    }
    return [...new Set(candidates.map((item) => normalizeSearchQuery(item)).filter(Boolean))].slice(0, 3);
};

const buildWebAnswer = ({ query = '', abstract = '', results = [], intent = {} }) => {
    const topic = normalizeSearchQuery(query) || 'bu konu';
    const topResult = results[0] || null;
    const topChannelResult = results.find((item) => isYoutubeChannelUrl(item.url)) || null;
    const topVideoResult = results.find((item) => isYoutubeWatchUrl(item.url)) || null;

    if ((intent.officialChannel || (intent.wantsYoutube && intent.wantsLink)) && topChannelResult) {
        return `Resmi YouTube kanal bulgusu: ${topChannelResult.title}. Link: ${topChannelResult.url}`;
    }

    if (intent.latestVideo) {
        if (topVideoResult) {
            return `En guclu web bulgusu: ${topVideoResult.title}. Link: ${topVideoResult.url}`;
        }
        if (topChannelResult) {
            return `Doğrudan video yerine kanal sonucu buldum: ${topChannelResult.title}. Son videoyu teyit için kanal linki: ${topChannelResult.url}`;
        }
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
    res.json({
        deepgramConfigured: isDeepgramConfigured,
        deepgramApiKey: DEEPGRAM_API_KEY,
        wakeWord: 'HADES',
        locale: 'tr-TR'
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

        const payload = {
            ok: true,
            query: rawQuery,
            effectiveQuery: query,
            answer: buildWebAnswer({
                query: rawQuery,
                abstract: instantAbstract,
                results: rankedResults,
                intent
            }),
            results: rankedResults,
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
            console.log(`HADES Akıllı Ev Sunucusu http://localhost:${activePort} adresinde çalışıyor.`);

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
