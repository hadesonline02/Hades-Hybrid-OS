const wakeWord = require('../app/chatgpt-bridge-extension/wake-word-shared');

describe('wake word helpers', () => {
    test('saf wake ifadelerini ayirt eder', () => {
        expect(wakeWord.hasWake('hades')).toBe(true);
        expect(wakeWord.isWakeOnly('hades ya')).toBe(true);
        expect(wakeWord.isWakeOnly('ha de s')).toBe(true);
    });

    test('tek kelimelik komutlari wake-only sanmaz', () => {
        expect(wakeWord.isWakeOnly('hades ac')).toBe(false);
        expect(wakeWord.extractWakeCommand('hades ac')).toBe('ac');
    });

    test('yakin telaffuz varyantlarini da yakalar', () => {
        expect(wakeWord.hasWake('hediz spotify ac')).toBe(true);
        expect(wakeWord.extractWakeCommand('hedez alarm kur')).toBe('alarm kur');
        expect(wakeWord.isWakeOnly('heydiz ya')).toBe(true);
        expect(wakeWord.extractWakeCommand('ha de si spotify ac')).toBe('spotify ac');
        expect(wakeWord.extractWakeCommand('a de sin alarm kur')).toBe('alarm kur');
        expect(wakeWord.hasWake('hadezi isiklari ac')).toBe(true);
        expect(wakeWord.extractWakeCommand('hadesh spotify ac')).toBe('spotify ac');
        expect(wakeWord.hasWake('hadesz alarm kur')).toBe(true);
    });

    test('wake sonrasindaki komutu dogrudan cikarir', () => {
        expect(wakeWord.extractWakeCommand('hey hades spotify ac')).toBe('spotify ac');
        expect(wakeWord.extractWakeCommand('tamam ha des alarm kur')).toBe('alarm kur');
        expect(wakeWord.stripWake('hades isigi ac')).toBe('isigi ac');
    });

    test('wake yoksa metni bozmadan birakir', () => {
        expect(wakeWord.stripWake('bugun hava nasil')).toBe('bugun hava nasil');
        expect(wakeWord.stripWake('hades')).toBe('');
        expect(wakeWord.hasWake('hadi sen')).toBe(false);
    });
});
