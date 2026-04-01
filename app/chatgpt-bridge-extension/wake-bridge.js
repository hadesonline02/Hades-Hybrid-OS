(() => {
    const emitReadyFallback = () => {
        try {
            if (document.documentElement) {
                document.documentElement.dataset.hadesWakeBridge = 'ready';
            }
        } catch (_) {
            // Sessizce devam et.
        }
        window.postMessage({
            __hadesWakeBridge: true,
            direction: 'to-content',
            type: 'ready'
        }, '*');
    };

    if (window.__hadesWakeBridgeLoaded) {
        if (typeof window.__hadesWakeBridgeEmitReady === 'function') {
            window.__hadesWakeBridgeEmitReady();
        } else {
            emitReadyFallback();
        }
        return;
    }
    window.__hadesWakeBridgeLoaded = true;

    const emit = (detail = {}) => {
        window.postMessage({
            __hadesWakeBridge: true,
            direction: 'to-content',
            ...detail
        }, '*');
    };

    const emitReady = () => {
        if (document.documentElement) {
            document.documentElement.dataset.hadesWakeBridge = 'ready';
        }
        emit({ type: 'ready' });
    };
    window.__hadesWakeBridgeEmitReady = emitReady;

    const wakeWord = window.HADESWakeWord || null;

    const norm = (text = '') => String(text || '')
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const wakeTokenMatch = (token = '') => {
        if (wakeWord?.wakeTokenMatch) {
            return wakeWord.wakeTokenMatch(token);
        }

        const value = norm(token);
        if (!value) return false;
        if (['hades', 'hedes', 'ades', 'hadesi', 'hadesin', 'hadesim', 'hds', 'hadese', 'hadesya'].includes(value)) {
            return true;
        }
        if (value.startsWith('hades') || value.startsWith('ades') || value.startsWith('hede')) {
            return true;
        }

        const chars = value.replace(/\s+/g, '');
        if (chars.length < 3 || chars.length > 7) return false;

        let score = 0;
        if (chars.includes('h')) score += 1;
        if (chars.includes('a')) score += 1;
        if (chars.includes('d')) score += 1;
        if (chars.includes('e')) score += 1;
        if (chars.includes('s')) score += 1;
        return score >= 4;
    };

    const hasWake = (text = '') => {
        if (wakeWord?.hasWake) {
            return wakeWord.hasWake(text);
        }

        const cleaned = norm(text);
        if (!cleaned) return false;
        if (/\b(hades|ha des|hedes|ades)\b/.test(cleaned)) return true;
        return cleaned.split(' ').some(wakeTokenMatch);
    };

    const isWakeOnly = (text = '') => {
        if (wakeWord?.isWakeOnly) {
            return wakeWord.isWakeOnly(text);
        }

        const cleaned = norm(text);
        if (!cleaned || !hasWake(cleaned)) return false;
        const rest = cleaned.split(' ').filter((part) => !wakeTokenMatch(part)).join(' ').trim();
        return !rest || rest.split(' ').length <= 1;
    };

    let recognizer = null;
    let activeEpoch = 0;

    const stopRecognizer = (epoch = activeEpoch, emitEnded = true) => {
        const current = recognizer;
        recognizer = null;
        activeEpoch = 0;

        if (current) {
            try {
                current.onstart = null;
                current.onresult = null;
                current.onerror = null;
                current.onend = null;
                current.stop();
            } catch (_) {
                // Sessizce devam et.
            }
        }

        if (emitEnded && epoch) {
            emit({ type: 'ended', epoch });
        }
    };

    const startRecognizer = ({ epoch, lang = 'tr-TR' } = {}) => {
        const WakeCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
        const nextEpoch = Number(epoch) || Date.now();

        if (!WakeCtor) {
            emit({ type: 'unsupported', epoch: nextEpoch });
            return;
        }

        stopRecognizer(activeEpoch, false);
        activeEpoch = nextEpoch;

        try {
            const rec = new WakeCtor();
            recognizer = rec;
            rec.continuous = true;
            rec.interimResults = true;
            rec.maxAlternatives = 5;
            rec.lang = lang || 'tr-TR';

            rec.onstart = () => {
                if (activeEpoch !== nextEpoch) return;
                emit({ type: 'started', epoch: nextEpoch });
            };

            rec.onresult = (event) => {
                if (activeEpoch !== nextEpoch) return;

                for (let i = event.resultIndex; i < event.results.length; i += 1) {
                    const result = event.results[i];
                    if (!result?.length) continue;

                    for (let j = 0; j < result.length; j += 1) {
                        const transcript = String(result[j]?.transcript || '').trim();
                        if (!transcript) continue;
                        if (isWakeOnly(transcript) || (result.isFinal && hasWake(transcript))) {
                            emit({ type: 'wake', epoch: nextEpoch, transcript });
                            stopRecognizer(nextEpoch, false);
                            return;
                        }
                    }
                }
            };

            rec.onerror = (event) => {
                if (activeEpoch !== nextEpoch) return;
                emit({ type: 'error', epoch: nextEpoch, error: String(event?.error || 'unknown') });
            };

            rec.onend = () => {
                if (activeEpoch !== nextEpoch) return;
                recognizer = null;
                activeEpoch = 0;
                emit({ type: 'ended', epoch: nextEpoch });
            };

            rec.start();
        } catch (error) {
            recognizer = null;
            activeEpoch = 0;
            emit({ type: 'error', epoch: nextEpoch, error: error?.message || 'wake_start_failed' });
        }
    };

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const detail = event.data || {};
        if (!detail.__hadesWakeBridge || detail.direction !== 'to-page') return;
        const action = String(detail.action || '').trim();

        if (action === 'start') {
            startRecognizer(detail);
            return;
        }

        if (action === 'stop') {
            stopRecognizer(Number(detail.epoch) || activeEpoch, true);
        }
    });

    emitReady();
})();
