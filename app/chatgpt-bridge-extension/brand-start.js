(() => {
    const LOGO_URL = chrome.runtime.getURL('hades-cover.png');
    const TITLE = 'HADES';
    const ICON_RELS = ['icon', 'shortcut icon', 'apple-touch-icon'];
    const BRAND_RECHECK_MS = 5000;
    let headObserver = null;
    let observedHead = null;
    let rootObserver = null;
    let applyTimer = 0;

    function ensureHead() {
        return document.head || document.documentElement?.querySelector('head') || null;
    }

    function ensureMeta(name, content) {
        const head = ensureHead();
        if (!head) return;

        let meta = head.querySelector(`meta[name="${name}"]`);
        if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('name', name);
            head.appendChild(meta);
        }

        if (meta.getAttribute('content') !== content) {
            meta.setAttribute('content', content);
        }
    }

    function ensureLink(rel) {
        const head = ensureHead();
        if (!head) return;

        let link = head.querySelector(`link[rel="${rel}"]`);
        if (!link) {
            link = document.createElement('link');
            link.rel = rel;
            head.appendChild(link);
        }

        if (link.href !== LOGO_URL) {
            link.href = LOGO_URL;
        }
    }

    function stripCompetingBrandAssets() {
        const head = ensureHead();
        if (!head) return;

        for (const node of Array.from(head.querySelectorAll('link[rel*="icon"], link[rel="manifest"]'))) {
            const rel = String(node.getAttribute('rel') || '').toLowerCase();
            if (node.href === LOGO_URL) continue;
            if (rel.includes('icon') || rel === 'manifest') {
                node.remove();
            }
        }
    }

    function applyBrand() {
        if (!document.documentElement) return;

        document.documentElement.setAttribute('data-hades-shell', 'true');
        if (document.title !== TITLE) {
            document.title = TITLE;
        }

        stripCompetingBrandAssets();
        for (const rel of ICON_RELS) ensureLink(rel);
        ensureMeta('application-name', TITLE);
        ensureMeta('apple-mobile-web-app-title', TITLE);
    }

    function queueApplyBrand(delay = 0) {
        if (applyTimer) {
            clearTimeout(applyTimer);
        }

        applyTimer = window.setTimeout(() => {
            applyTimer = 0;
            applyBrand();
        }, delay);
    }

    function startWatching() {
        const root = document.documentElement;
        if (!root) return;

        const head = ensureHead();
        if (head && observedHead !== head) {
            if (headObserver) {
                headObserver.disconnect();
            }
            headObserver = new MutationObserver(() => queueApplyBrand(60));
            headObserver.observe(head, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['href', 'rel', 'content']
            });
            observedHead = head;
        }

        if (!rootObserver) {
            rootObserver = new MutationObserver(() => {
                startWatching();
                queueApplyBrand(60);
            });
            rootObserver.observe(root, { childList: true });
        }
    }

    queueApplyBrand(0);
    startWatching();
    document.addEventListener('readystatechange', () => queueApplyBrand(40), { passive: true });
    document.addEventListener('DOMContentLoaded', () => queueApplyBrand(40), { once: true });
    window.addEventListener('load', () => queueApplyBrand(40), { once: false });
    window.setTimeout(() => queueApplyBrand(0), 600);
    window.setTimeout(() => queueApplyBrand(0), 1800);
    window.setInterval(() => queueApplyBrand(0), BRAND_RECHECK_MS);
})();
