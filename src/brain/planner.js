(function initHadesPlanner(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESPlanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPlannerModule() {
    'use strict';

    const generatePlanId = () => `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ALLOWED_RISKS = new Set(['low', 'medium', 'high']);
    const JOIN_REGEX = /(?:\b(?:ve|sonra|ardindan)\b|,|;)/i;

    const normalizeTr = (text = '') => String(text)
        .toLocaleLowerCase('tr-TR')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0131/g, 'i')
        .replace(/\s+/g, ' ')
        .trim();

    const normalizeRisk = (risk) => (ALLOWED_RISKS.has(risk) ? risk : 'low');
    const normalizeConfidence = (value) => {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) return 0.5;
        return Math.max(0, Math.min(1, numericValue));
    };

    const normalizeSteps = (steps = []) => (steps || [])
        .filter(step => step && step.domain && step.intent)
        .map((step, index) => ({
            id: step.id || `s${index + 1}`,
            domain: step.domain,
            intent: step.intent,
            params: step.params && typeof step.params === 'object' ? { ...step.params } : {},
            requires_confirmation: Boolean(step.requires_confirmation || step.requiresConfirmation),
            order: typeof step.order === 'number' ? step.order : (index + 1)
        }));

    const toActionType = (step) => {
        const domain = step.domain || 'system';
        const intent = step.intent || 'noop';
        return `${domain}.${intent}`;
    };

    const toActionPlanSchema = (inputText, normalizedSteps = []) => ({
        input: inputText || '',
        steps: normalizedSteps
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map((step) => ({
                type: toActionType(step),
                ...((step.params && Object.keys(step.params).length > 0) ? step.params : {})
            }))
    });

    const extractHourMinute = (segment) => {
        const match = segment.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\b/);
        if (!match) return null;
        const hour = String(parseInt(match[1], 10)).padStart(2, '0');
        const minute = match[2] ? String(parseInt(match[2], 10)).padStart(2, '0') : '00';
        return `${hour}:${minute}`;
    };

    const buildIsoFromToday = (hhmm, nowIso = null) => {
        const now = nowIso ? new Date(nowIso) : new Date();
        const [hour, minute] = hhmm.split(':').map((value) => parseInt(value, 10));
        const nextDate = new Date(now);
        nextDate.setSeconds(0, 0);
        nextDate.setHours(hour, minute, 0, 0);
        if (nextDate.getTime() < now.getTime()) {
            nextDate.setDate(nextDate.getDate() + 1);
        }
        return nextDate.toISOString();
    };

    const createDeterministicActionPlan = (rawInput = '', options = {}) => {
        const normalizedInput = normalizeTr(rawInput);
        const segments = normalizedInput
            .split(JOIN_REGEX)
            .filter((segment) => typeof segment === 'string')
            .map((segment) => segment.trim())
            .filter(Boolean);

        const steps = [];
        let order = 1;
        for (const segment of segments) {
            if (/\b(isik\w*|isig\w*|lamba\w*)\b/.test(segment) && /\b(ac|yak)\w*\b/.test(segment)) {
                steps.push({
                    domain: 'light',
                    intent: 'set',
                    params: { state: 'on' },
                    order: order++
                });
            }
            if (/\b(isik\w*|isig\w*|lamba\w*)\b/.test(segment) && /\b(kapat|sondur)\w*\b/.test(segment)) {
                steps.push({
                    domain: 'light',
                    intent: 'set',
                    params: { state: 'off' },
                    order: order++
                });
            }
            if (/\b(alarm|hatirlatici|zamanlayici)\b/.test(segment) && /\b(kur|ayarla|ekle)\w*\b/.test(segment)) {
                const hhmm = extractHourMinute(segment) || '09:00';
                steps.push({
                    domain: 'alarm',
                    intent: 'set',
                    params: {
                        when: buildIsoFromToday(hhmm, options.nowISO),
                        label: 'alarm'
                    },
                    order: order++
                });
            }
        }

        const normalizedSteps = normalizeSteps(steps);
        const payload = buildActionPlanPayload({
            planId: options.planId,
            steps: normalizedSteps,
            assumptions: options.assumptions || [],
            confidence: normalizedSteps.length > 0 ? 0.86 : 0.35,
            risk: 'low'
        });
        return {
            payload,
            actionPlan: toActionPlanSchema(rawInput, normalizedSteps)
        };
    };

    const buildActionPlanPayload = (input = {}) => {
        return {
            plan_id: input.planId || generatePlanId(),
            steps: normalizeSteps(input.steps),
            assumptions: Array.isArray(input.assumptions) ? input.assumptions.filter(Boolean) : [],
            risk: normalizeRisk(input.risk),
            confidence: normalizeConfidence(input.confidence),
            undo: Array.isArray(input.undo) ? input.undo : []
        };
    };

    return Object.freeze({
        normalizeTr,
        buildActionPlanPayload,
        createDeterministicActionPlan,
        toActionPlanSchema
    });
});
