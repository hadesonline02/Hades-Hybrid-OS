const { createDeterministicActionPlan } = require('../src/brain/planner');

describe('Planner testleri', () => {
    test('multi-intent adim sirasi korunur', () => {
        const { actionPlan } = createDeterministicActionPlan('yarin 21de isigi yak, 22de alarm kur');
        expect(actionPlan.steps.length).toBeGreaterThanOrEqual(2);
        expect(actionPlan.steps[0].type).toBe('light.set');
        expect(actionPlan.steps[1].type).toBe('alarm.set');
    });
});
