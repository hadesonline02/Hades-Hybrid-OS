const { extractLocalScheduleIntent } = require('../app/chatgpt-bridge-extension/schedule-intent-shared');

describe('schedule intent shared', () => {
    test('alarm kurma istegini yerel araca cevirir', () => {
        const intent = extractLocalScheduleIntent('Bir dakika sonrasına alarm kurar mısın?');

        expect(intent).toEqual({
            tool: 'alarm.set',
            args: {
                time: 'Bir dakika sonrasına'
            }
        });
    });

    test('aktif alarm sorusunu listelemeye cevirir', () => {
        const intent = extractLocalScheduleIntent('Aktif alarm var mı?');

        expect(intent).toEqual({
            tool: 'alarm.list',
            args: {}
        });
    });

    test('hatirlatici kurarken mesaji korur', () => {
        const intent = extractLocalScheduleIntent('1 dakika sonra bana su içmeyi hatırlat');

        expect(intent).toEqual({
            tool: 'reminder.set',
            args: {
                time: '1 dakika sonra',
                message: 'su içmeyi'
            }
        });
    });

    test('tek alarm silme istegini algilar', () => {
        const intent = extractLocalScheduleIntent('20:16 alarmını sil');

        expect(intent).toEqual({
            tool: 'alarm.delete',
            args: {
                time: '20:16'
            }
        });
    });

    test('tum hatirlatici silme istegini algilar', () => {
        const intent = extractLocalScheduleIntent('Tüm hatırlatıcıları sil');

        expect(intent).toEqual({
            tool: 'reminder.delete_all',
            args: {}
        });
    });
});
