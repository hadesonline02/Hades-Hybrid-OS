const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const userDataDir = path.join(projectRoot, 'UserData');
const bridgeExtensionPath = path.join(projectRoot, 'app', 'chatgpt-bridge-extension');
const runtimeExtensionRoot = path.join(userDataDir, 'runtime-extensions');
const appIconPath = path.join(bridgeExtensionPath, 'hades-cover.png');
const backendBase = String(process.env.HADES_BACKEND_BASE || 'http://127.0.0.1:3001').trim().replace(/\/+$/, '');
const chatgptStartUrl = String(process.env.HADES_CHATGPT_URL || 'https://chatgpt.com/').trim();

const trustedShellHosts = new Set([
    'chatgpt.com',
    'chat.openai.com',
    'openai.com',
    'auth.openai.com',
    'auth0.openai.com',
    'accounts.google.com',
    'login.microsoftonline.com',
    'login.live.com',
    'appleid.apple.com',
    'idmsa.apple.com'
]);

const trustedPermissionHosts = new Set([
    'chatgpt.com',
    'chat.openai.com'
]);

const allowedPermissions = new Set([
    'media',
    'microphone',
    'camera',
    'notifications',
    'fullscreen',
    'clipboard-read',
    'clipboard-sanitized-write',
    'pointerLock',
    'speaker-selection',
    'window-management'
]);

function normalizeUrl(rawUrl = '') {
    try {
        return new URL(String(rawUrl || '').trim());
    } catch (_) {
        return null;
    }
}

function matchesTrustedHost(hostname = '', trustedHosts = trustedShellHosts) {
    const normalizedHost = String(hostname || '').toLowerCase();
    if (!normalizedHost) return false;

    for (const trustedHost of trustedHosts) {
        if (normalizedHost === trustedHost || normalizedHost.endsWith(`.${trustedHost}`)) {
            return true;
        }
    }

    return false;
}

function isTrustedShellUrl(rawUrl = '') {
    const parsed = normalizeUrl(rawUrl);
    if (!parsed) return false;
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    return matchesTrustedHost(parsed.hostname, trustedShellHosts);
}

function isTrustedPermissionUrl(rawUrl = '') {
    const parsed = normalizeUrl(rawUrl);
    if (!parsed) return false;
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    return matchesTrustedHost(parsed.hostname, trustedPermissionHosts);
}

function canGrantPermission(permission = '', rawUrl = '') {
    return allowedPermissions.has(String(permission || '')) && isTrustedPermissionUrl(rawUrl);
}

function buildChromeLikeUserAgent() {
    const chromeVersion = process.versions.chrome || '141.0.0.0';
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

module.exports = {
    allowedPermissions,
    appIconPath,
    backendBase,
    buildChromeLikeUserAgent,
    bridgeExtensionPath,
    canGrantPermission,
    chatgptStartUrl,
    isTrustedPermissionUrl,
    isTrustedShellUrl,
    projectRoot,
    runtimeExtensionRoot,
    trustedPermissionHosts,
    trustedShellHosts,
    userDataDir
};
