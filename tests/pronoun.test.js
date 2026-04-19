const { ActionMemoryRingBuffer } = require('../src/core/action-memory');

describe('Pronoun resolution testleri', () => {
    test("su dokuza kurdugun var ya kaldir -> alarm hafizasindan cozulur", () => {
        const memory = new ActionMemoryRingBuffer(50);
        memory.push({
            domain: 'alarm',
            intent: 'set',
            params: { time: '09:00' },
            success: true
        });
        memory.push({
            domain: 'alarm',
            intent: 'set',
            params: { time: '22:00' },
            success: true
        });

        const result = memory.resolvePronounCommand('su dokuza kurdugun var ya kaldir');
        expect(result.matched).toBe(true);
        expect(result.entry).not.toBeNull();
        expect(result.entry.params.time.startsWith('09')).toBe(true);
    });
});
