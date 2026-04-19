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
    const WAKE_VARIANTS = [
        'hades',
        'ha des',
        'hedes',
        'he des',
        'ades',
        'a des',
        'hds',
        'hadez',
        'adez',
        'haydes',
        'heydes',
        'hey des',
        'hadis',
        'hadiz',
        'hedis',
        'hediz',
        'hedez',
        'heydis',
        'heydiz',
        'hadesi',
        'ha desi',
        'ha de si',
        'hade si',
        'hadesin',
        'ha desin',
        'ha de sin',
        'hade sin',
        'hadesim',
        'ha desim',
        'ha de sim',
        'hade sim',
        'hadese',
        'ha dese',
        'ha de se',
        'hade se',
        'hadezi',
        'hadezin',
        'hadezim',
        'hedesi',
        'he desi',
        'he de si',
        'hede si',
        'hedesin',
        'he desin',
        'he de sin',
        'hede sin',
        'hedesim',
        'he desim',
        'he de sim',
        'hede sim',
        'hedezi',
        'hedezin',
        'hedezim',
        'adesi',
        'a desi',
        'a de si',
        'ade si',
        'adesin',
        'a desin',
        'a de sin',
        'ade sin',
        'adesim',
        'a desim',
        'a de sim',
        'ade sim',
        'adezi',
        'adezin',
        'adezim'
    ];

    const WAKE_PREFIXES = [
        'hades',
        'hedes',
        'ades',
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
    ];

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
        if ([
            'hades',
            'hedes',
            'ades',
            'hds',
            'hadez',
            'adez',
            'hadis',
            'hadiz',
            'hedis',
            'hediz',
            'hedez',
            'haydes',
            'heydes',
            'heydis',
            'heydiz',
            'hadesi',
            'hadesin',
            'hadesim',
            'hadese',
            'hadesya'
        ].includes(value)) {
            return true;
        }
        if (WAKE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
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

    const extractWakeCommand = (text = '') => {
        if (wakeWord?.extractWakeCommand) {
            return wakeWord.extractWakeCommand(text);
        }

        const raw = String(text || '').trim();
        if (!raw) return '';
        const parts = raw.split(/\s+/);
        const remaining = parts.filter((part) => !wakeTokenMatch(part)).join(' ').trim();
        return remaining;
    };

    let recognizer = null;
    let activeEpoch = 0;
    let restartTimer = 0;
    let heartbeatTimer = 0;
    let stopRequested = false;
    let lastConfig = null;

    const clearRestartTimer = () => {
        if (!restartTimer) return;
        clearTimeout(restartTimer);
        restartTimer = 0;
    };

    const clearHeartbeatTimer = () => {
        if (!heartbeatTimer) return;
        clearInterval(heartbeatTimer);
        heartbeatTimer = 0;
    };

    const startHeartbeat = (epoch) => {
        clearHeartbeatTimer();
        heartbeatTimer = setInterval(() => {
            if (Number(activeEpoch) !== Number(epoch) || stopRequested || !recognizer) return;
            emit({ type: 'heartbeat', epoch });
        }, 5000);
    };

    const scheduleRestart = (epoch, delay = 120) => {
        clearRestartTimer();
        if (!lastConfig || Number(lastConfig.epoch) !== Number(epoch) || stopRequested) {
            return;
        }
        restartTimer = setTimeout(() => {
            restartTimer = 0;
            if (stopRequested || Number(activeEpoch) !== Number(epoch)) return;
            startRecognizer(lastConfig);
        }, Math.max(60, Number(delay) || 120));
    };

    const stopRecognizer = (epoch = activeEpoch, emitEnded = true) => {
        clearRestartTimer();
        clearHeartbeatTimer();
        stopRequested = true;
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
        const GrammarCtor = window.SpeechGrammarList || window.webkitSpeechGrammarList || null;
        const nextEpoch = Number(epoch) || Date.now();

        if (!WakeCtor) {
            emit({ type: 'unsupported', epoch: nextEpoch });
            return;
        }

        clearRestartTimer();
        stopRequested = false;
        lastConfig = { epoch: nextEpoch, lang: lang || 'tr-TR' };
        stopRecognizer(activeEpoch, false);
        stopRequested = false;
        activeEpoch = nextEpoch;

        try {
            const rec = new WakeCtor();
            recognizer = rec;
            rec.continuous = true;
            rec.interimResults = true;
            rec.maxAlternatives = 8;
            rec.lang = lang || 'tr-TR';
            if (GrammarCtor) {
                try {
                    const grammar = new GrammarCtor();
                    grammar.addFromString(`#JSGF V1.0; grammar wake; public <wake> = ${WAKE_VARIANTS.join(' | ')} ;`, 1);
                    rec.grammars = grammar;
                } catch (_) {
                    // Grammar destegi yoksa sessizce devam et.
                }
            }

            rec.onstart = () => {
                if (activeEpoch !== nextEpoch) return;
                startHeartbeat(nextEpoch);
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
                        const wakeOnly = isWakeOnly(transcript);
                        const inlineCommand = result.isFinal ? extractWakeCommand(transcript) : '';
                        if (wakeOnly || hasWake(transcript)) {
                            emit({ type: 'wake', epoch: nextEpoch, transcript, command: inlineCommand });
                            stopRecognizer(nextEpoch, false);
                            return;
                        }
                    }
                }
            };

            rec.onerror = (event) => {
                if (activeEpoch !== nextEpoch) return;
                const errorCode = String(event?.error || 'unknown');
                clearHeartbeatTimer();
                recognizer = null;
                if (stopRequested && errorCode === 'aborted') return;
                if (errorCode === 'no-speech' || errorCode === 'aborted') {
                    scheduleRestart(nextEpoch, 120);
                    return;
                }
                if (errorCode === 'network') {
                    scheduleRestart(nextEpoch, 480);
                    return;
                }
                activeEpoch = 0;
                emit({ type: 'error', epoch: nextEpoch, error: errorCode });
            };

            rec.onend = () => {
                if (activeEpoch !== nextEpoch) return;
                clearHeartbeatTimer();
                recognizer = null;
                if (stopRequested) {
                    activeEpoch = 0;
                    emit({ type: 'ended', epoch: nextEpoch });
                    return;
                }
                scheduleRestart(nextEpoch, 100);
            };

            rec.start();
        } catch (error) {
            recognizer = null;
            const message = String(error?.message || 'wake_start_failed');
            if (/already\s+started|starting/i.test(message)) {
                activeEpoch = nextEpoch;
                scheduleRestart(nextEpoch, 180);
                return;
            }
            activeEpoch = 0;
            emit({ type: 'error', epoch: nextEpoch, error: message });
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
