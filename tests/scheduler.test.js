const { SchedulerEngine } = require('../src/core/scheduler');

describe('Scheduler testleri', () => {
    test('deferred_action zamani geldiginde tetiklenir', () => {
        const fired = [];
        const scheduler = new SchedulerEngine({
            onFire: (task) => fired.push(task),
            nowFn: () => Date.parse('2026-02-23T10:00:00.000Z')
        });

        scheduler.addTask({
            type: 'deferred_action',
            datetimeISO: '2026-02-23T09:59:58.000Z',
            payload: { domain: 'light', intent: 'set', params: { state: 'on' } }
        });
        scheduler.addTask({
            type: 'deferred_action',
            datetimeISO: '2026-02-23T10:10:00.000Z',
            payload: { domain: 'light', intent: 'set', params: { state: 'off' } }
        });

        const due = scheduler.tick(Date.parse('2026-02-23T10:00:00.000Z'));
        expect(due).toHaveLength(1);
        expect(fired).toHaveLength(1);
        expect(fired[0].type).toBe('deferred_action');
        expect(fired[0].status).toBe('fired');
    });
});
