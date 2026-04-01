(function initHadesSchemas(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESSchemas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSchemaModule() {
    'use strict';

    const ACTION_PLAN_SCHEMA = Object.freeze({
        type: 'object',
        required: ['input', 'steps'],
        additionalProperties: false
    });

    const validateActionPlan = (candidate) => {
        const errors = [];

        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            errors.push('Plan JSON object olmalidir.');
            return { ok: false, errors };
        }

        const allowedTopLevel = new Set(['input', 'steps', 'assumptions', 'risk', 'confidence', 'undo', 'plan_id']);
        for (const key of Object.keys(candidate)) {
            if (!allowedTopLevel.has(key)) {
                errors.push(`Izin verilmeyen alan: ${key}`);
            }
        }

        if (typeof candidate.input !== 'string' || !candidate.input.trim()) {
            errors.push('input metni zorunludur.');
        }

        if (!Array.isArray(candidate.steps)) {
            errors.push('steps dizi olmalidir.');
        } else if (candidate.steps.length === 0) {
            errors.push('steps bos olamaz.');
        } else {
            candidate.steps.forEach((step, index) => {
                if (!step || typeof step !== 'object' || Array.isArray(step)) {
                    errors.push(`steps[${index}] object olmalidir.`);
                    return;
                }
                if (typeof step.type !== 'string' || !step.type.trim()) {
                    errors.push(`steps[${index}].type zorunludur.`);
                }
            });
        }

        return { ok: errors.length === 0, errors };
    };

    const parseStrictActionPlan = (rawText) => {
        try {
            const parsed = JSON.parse(rawText);
            const validation = validateActionPlan(parsed);
            if (!validation.ok) {
                return { ok: false, errors: validation.errors, data: null };
            }
            return { ok: true, errors: [], data: parsed };
        } catch (error) {
            return { ok: false, errors: [`JSON parse hatası: ${error.message}`], data: null };
        }
    };

    return Object.freeze({
        ACTION_PLAN_SCHEMA,
        validateActionPlan,
        parseStrictActionPlan
    });
});
