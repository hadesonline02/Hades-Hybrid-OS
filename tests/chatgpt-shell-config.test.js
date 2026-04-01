const path = require('path');

const {
    bridgeExtensionPath,
    buildChromeLikeUserAgent,
    canGrantPermission,
    getChromiumLaunchArgs,
    isTrustedPermissionUrl,
    isTrustedShellUrl
} = require('../app/chatgpt-shell-config');

describe('chatgpt shell config', () => {
    test('chatgpt ve openai auth adreslerini shell içinde tutar', () => {
        expect(isTrustedShellUrl('https://chatgpt.com')).toBe(true);
        expect(isTrustedShellUrl('https://auth.openai.com/u/login')).toBe(true);
        expect(isTrustedShellUrl('https://accounts.google.com/signin/v2')).toBe(true);
        expect(isTrustedShellUrl('https://example.com')).toBe(false);
    });

    test('medya izinlerini sadece chatgpt alan adlarina verir', () => {
        expect(isTrustedPermissionUrl('https://chatgpt.com')).toBe(true);
        expect(isTrustedPermissionUrl('https://chat.openai.com')).toBe(true);
        expect(isTrustedPermissionUrl('https://example.com')).toBe(false);
        expect(canGrantPermission('media', 'https://chatgpt.com')).toBe(true);
        expect(canGrantPermission('microphone', 'https://chat.openai.com')).toBe(true);
        expect(canGrantPermission('media', 'https://example.com')).toBe(false);
    });

    test('krom benzeri user agent uretir', () => {
        const userAgent = buildChromeLikeUserAgent();
        expect(userAgent).toContain('Mozilla/5.0');
        expect(userAgent).toContain('Chrome/');
        expect(userAgent).not.toContain('Electron/');
    });

    test('chromium argumanlari bridge extensioni yukler', () => {
        const args = getChromiumLaunchArgs();
        expect(args).toContain(`--disable-extensions-except=${bridgeExtensionPath}`);
        expect(args).toContain(`--load-extension=${bridgeExtensionPath}`);
        expect(args).toContain('--use-fake-ui-for-media-stream');
        expect(args).toContain('--app=https://chatgpt.com/');
    });

    test('chromium argumanlari ozel extension path kabul eder', () => {
        const customPath = path.join('C:', 'tmp', 'hades-bridge-test');
        const args = getChromiumLaunchArgs(customPath);
        expect(args).toContain(`--disable-extensions-except=${customPath}`);
        expect(args).toContain(`--load-extension=${customPath}`);
    });
});
