(() => {
    const THEME_NAME = 'hades-ember';
    const BRAND_NAME = 'HadesAI';
    const LOGO_URL = chrome.runtime.getURL('hades-cover.png');
    const ROOT_ATTR = 'data-hades-theme-root';
    const SIDEBAR_ATTR = 'data-hades-sidebar';
    const SIDEBAR_HEADER_ATTR = 'data-hades-sidebar-header';
    const TOPBAR_ATTR = 'data-hades-topbar';
    const MAIN_ATTR = 'data-hades-main';
    const THREAD_ATTR = 'data-hades-thread';
    const THREAD_BOTTOM_ATTR = 'data-hades-thread-bottom';
    const COMPOSER_ATTR = 'data-hades-composer';
    const BRAND_BUTTON_ATTR = 'data-hades-brand-button';
    const SIDEBAR_LOGO_ATTR = 'data-hades-sidebar-logo';
    const NATIVE_HIDDEN_ATTR = 'data-hades-native-hidden';
    const THEME_REFRESH_SELECTOR = [
        '#stage-slideover-sidebar',
        '#sidebar-header',
        '#page-header',
        '#main',
        '#thread',
        '#thread-bottom-container',
        'form.group\\/composer',
        '#page-header [data-testid="model-switcher-dropdown-button"]',
        '#sidebar-header a'
    ].join(', ');
    const DISCLAIMER_TEXT = 'HADES, wake word, Deepgram komutları, yerel AI araçları ve cihaz kontrolünü tek masaüstü akışında birleştirir.';
    let applyTimer = 0;
    let bodyObserver = null;

    function setAttr(node, attr) {
        if (node) node.setAttribute(attr, 'true');
    }

    function ensureBrandButton() {
        const button = document.querySelector('#page-header [data-testid="model-switcher-dropdown-button"]');
        if (!button) return;
        setAttr(button, BRAND_BUTTON_ATTR);
        const textSpan = button.querySelector('.font-oai') || button.querySelector('span');
        if (textSpan) textSpan.textContent = BRAND_NAME;
        const nativeIcon = button.querySelector('svg');
        if (nativeIcon) nativeIcon.setAttribute(NATIVE_HIDDEN_ATTR, 'true');
        let logo = button.querySelector('img[data-hades-brand-logo="true"]');
        if (!logo) {
            logo = document.createElement('img');
            logo.setAttribute('data-hades-brand-logo', 'true');
            logo.alt = `${BRAND_NAME} logo`;
            button.insertBefore(logo, button.firstChild || null);
        }
        logo.src = LOGO_URL;
    }

    function ensureSidebarLogo() {
        const anchor = document.querySelector('#sidebar-header a');
        if (!anchor) return;
        setAttr(anchor, SIDEBAR_LOGO_ATTR);
        const nativeIcon = anchor.querySelector('svg');
        if (nativeIcon) nativeIcon.setAttribute(NATIVE_HIDDEN_ATTR, 'true');
        let logo = anchor.querySelector('img[data-hades-sidebar-brand="true"]');
        if (!logo) {
            logo = document.createElement('img');
            logo.setAttribute('data-hades-sidebar-brand', 'true');
            logo.alt = `${BRAND_NAME} logo`;
            anchor.appendChild(logo);
        }
        logo.src = LOGO_URL;
    }

    function ensureDisclaimerText() {
        const existing = document.querySelector('#thread-bottom-container [data-hades-project-note="true"]');
        if (existing) {
            existing.textContent = DISCLAIMER_TEXT;
            return;
        }
        const candidates = Array.from(document.querySelectorAll('#thread-bottom-container div, #thread-bottom-container p, #thread-bottom-container span'));
        for (const node of candidates) {
            const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            if (!/ChatGPT hata yapabilir/i.test(text)) continue;
            node.textContent = DISCLAIMER_TEXT;
            node.setAttribute('data-hades-project-note', 'true');
            return;
        }
    }

    function setThemeMeta() {
        if (!document.head) return;
        let meta = document.head.querySelector('meta[name="theme-color"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('name', 'theme-color');
            document.head.appendChild(meta);
        }
        meta.setAttribute('content', '#0b1320');
    }

    function applyThemeState() {
        document.documentElement.setAttribute('data-hades-theme', THEME_NAME);
        document.documentElement.setAttribute('data-hades-shell', 'true');
        document.documentElement.setAttribute(ROOT_ATTR, 'true');
        if (document.body) document.body.setAttribute('data-hades-theme-active', 'true');
        if (document.title) document.title = document.title.replace(/chat\s*gpt/gi, BRAND_NAME);
        setThemeMeta();

        setAttr(document.getElementById('stage-slideover-sidebar'), SIDEBAR_ATTR);
        setAttr(document.getElementById('sidebar-header'), SIDEBAR_HEADER_ATTR);
        setAttr(document.getElementById('page-header'), TOPBAR_ATTR);
        setAttr(document.getElementById('main'), MAIN_ATTR);
        setAttr(document.getElementById('thread'), THREAD_ATTR);
        setAttr(document.getElementById('thread-bottom-container'), THREAD_BOTTOM_ATTR);
        setAttr(document.querySelector('form.group\\/composer'), COMPOSER_ATTR);

        ensureBrandButton();
        ensureSidebarLogo();
        ensureDisclaimerText();
    }

    function queueApply(delay = 0) {
        if (applyTimer) clearTimeout(applyTimer);
        applyTimer = window.setTimeout(() => {
            applyTimer = 0;
            applyThemeState();
        }, delay);
    }

    function isIgnoredNode(node) {
        if (!(node instanceof Element)) return false;
        return node.id === 'hades-bridge-root' || Boolean(node.closest('#hades-bridge-root'));
    }

    function touchesThemeSurface(node) {
        if (!node) return false;
        if (node.nodeType === Node.TEXT_NODE) {
            return touchesThemeSurface(node.parentElement);
        }
        if (!(node instanceof Element) || isIgnoredNode(node)) return false;
        if (node.matches(THEME_REFRESH_SELECTOR)) return true;
        if (node.querySelector(THEME_REFRESH_SELECTOR)) return true;
        if (node.closest('#thread-bottom-container')) {
            const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            if (/ChatGPT hata yapabilir/i.test(text)) return true;
        }
        return false;
    }

    function shouldRefreshTheme(mutations = []) {
        for (const mutation of mutations) {
            const nodes = [mutation.target, ...mutation.addedNodes, ...mutation.removedNodes];
            for (const node of nodes) {
                if (touchesThemeSurface(node)) return true;
            }
        }
        return false;
    }

    function wrapHistoryMethod(name) {
        const original = history[name];
        if (typeof original !== 'function') return;
        history[name] = function hadesThemeHistoryWrapper(...args) {
            const result = original.apply(this, args);
            queueApply(40);
            return result;
        };
    }

    function startWatching() {
        if (!document.body || bodyObserver) return;
        bodyObserver = new MutationObserver((mutations) => {
            if (shouldRefreshTheme(mutations)) {
                queueApply(90);
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    queueApply(0);
    document.addEventListener('readystatechange', () => queueApply(30), { passive: true });
    document.addEventListener('DOMContentLoaded', () => {
        queueApply(0);
        startWatching();
    }, { once: true });
    window.addEventListener('load', () => queueApply(50), { passive: true });
    window.addEventListener('popstate', () => queueApply(40), { passive: true });
    window.addEventListener('hashchange', () => queueApply(40), { passive: true });
    window.setTimeout(() => queueApply(0), 400);
    window.setTimeout(() => queueApply(0), 1200);
})();
