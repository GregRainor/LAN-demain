const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('core.js') + '\nthis.__calendar={buildLanCalendarEvent,buildLanCalendarLinks,buildLanIcs,utcCalendarDateTime};';
const context = vm.createContext({ console, URL, Date, Math, Promise, Set, Map });
vm.runInContext(source, context, { filename: 'core.js' });
const calendar = context.__calendar;

const timedSettings = {
    lanName: 'LAN Août',
    lanDate: '2026-08-28',
    lanStartTime: '14:00',
    lanEndDate: '2026-08-30',
    lanPlace: 'La Kiks'
};
const timedEvent = calendar.buildLanCalendarEvent(timedSettings);
assert(timedEvent && !timedEvent.allDay, 'A LAN with a start time must create a timed event');
assert.strictEqual(timedEvent.end.getFullYear(), 2026);
assert.strictEqual(timedEvent.end.getMonth(), 7);
assert.strictEqual(timedEvent.end.getDate(), 30, 'A timed multi-day LAN must end on its announced final day');
assert.strictEqual(timedEvent.end.getHours(), 20, 'The final day keeps the six-hour evening duration');

const singleDayEvent = calendar.buildLanCalendarEvent({
    lanDate: '2026-08-28', lanStartTime: '14:00', lanPlace: 'La Kiks'
});
assert.strictEqual(singleDayEvent.end.getTime() - singleDayEvent.start.getTime(), 6 * 60 * 60 * 1000,
    'A timed single-day LAN still reserves six hours');

const timedLinks = calendar.buildLanCalendarLinks(timedSettings);
const google = new URL(timedLinks.google);
assert.strictEqual(google.hostname, 'calendar.google.com');
assert.strictEqual(google.searchParams.get('action'), 'TEMPLATE');
assert.strictEqual(google.searchParams.get('text'), 'LAN Août');
assert.strictEqual(google.searchParams.get('location'), 'La Kiks');
assert.strictEqual(google.searchParams.get('dates'),
    calendar.utcCalendarDateTime(timedEvent.start) + '/' + calendar.utcCalendarDateTime(timedEvent.end));

const outlook = new URL(timedLinks.outlook);
assert.strictEqual(outlook.hostname, 'outlook.live.com');
assert.strictEqual(outlook.searchParams.get('rru'), 'addevent');
assert.strictEqual(outlook.searchParams.get('subject'), 'LAN Août');
assert.strictEqual(outlook.searchParams.get('allday'), 'false');
assert.strictEqual(Date.parse(outlook.searchParams.get('startdt')), timedEvent.start.getTime());
assert.strictEqual(Date.parse(outlook.searchParams.get('enddt')), timedEvent.end.getTime());

const yahoo = new URL(timedLinks.yahoo);
assert.strictEqual(yahoo.hostname, 'calendar.yahoo.com');
assert.strictEqual(yahoo.searchParams.get('title'), 'LAN Août');
assert.strictEqual(yahoo.searchParams.get('in_loc'), 'La Kiks');
assert.strictEqual(yahoo.searchParams.has('dur'), false);

const allDaySettings = {
    lanName: 'LAN complète',
    lanDate: '2026-08-28',
    lanEndDate: '2026-08-30',
    lanPlace: 'La Kiks'
};
const allDayEvent = calendar.buildLanCalendarEvent(allDaySettings);
assert(allDayEvent && allDayEvent.allDay);
assert.strictEqual(allDayEvent.exclusiveEndKey, '2026-08-31',
    'Multi-day calendar end dates must remain exclusive');

const allDayLinks = calendar.buildLanCalendarLinks(allDaySettings);
assert.strictEqual(new URL(allDayLinks.google).searchParams.get('dates'), '20260828/20260831');
assert.strictEqual(new URL(allDayLinks.outlook).searchParams.get('startdt'), '2026-08-28');
assert.strictEqual(new URL(allDayLinks.outlook).searchParams.get('enddt'), '2026-08-31');
assert.strictEqual(new URL(allDayLinks.outlook).searchParams.get('allday'), 'true');
assert.strictEqual(new URL(allDayLinks.yahoo).searchParams.get('dur'), 'allday');

const timedIcs = calendar.buildLanIcs(timedSettings);
assert(/DTSTART:20260828T140000\r\n/.test(timedIcs));
assert(/DTEND:20260830T200000\r\n/.test(timedIcs),
    'The .ics timed event must preserve the announced 28–30 August range');
const ics = calendar.buildLanIcs(allDaySettings);
assert(/DTSTART;VALUE=DATE:20260828\r\n/.test(ics));
assert(/DTEND;VALUE=DATE:20260831\r\n/.test(ics));
assert(/DESCRIPTION:Retrouve les informations et le programme sur LAN Demain\.\r\n/.test(ics));
assert.strictEqual(calendar.buildLanCalendarLinks({ lanPlace: 'Quelque part' }), null);
assert.strictEqual(calendar.buildLanIcs({ lanPlace: 'Quelque part' }), null);

const desktopHtml = read('desktop.html');
const desktopScript = read('newScript.js');
const desktopCss = read('desktop-v2.css');
for (const id of ['calendar-choice-modal', 'calendar-choice-google', 'calendar-choice-outlook',
    'calendar-choice-yahoo', 'calendar-choice-ics']) {
    assert(desktopHtml.includes(`id="${id}"`), `Missing desktop calendar control #${id}`);
}
assert(/openLanCalendarChooser/.test(desktopScript));
assert(/waiting-ics'\)\?\.addEventListener\('click', openLanCalendarChooser\)/.test(desktopScript));
assert(/\.calendar-choice__option\s*\{[\s\S]{0,320}min-height:66px/.test(desktopCss));
assert(/target="_blank" rel="noopener"/.test(desktopHtml));

const mobileScript = read('mobile.js');
const mobileCss = read('mobile.css');
assert(/function openMobileCalendarChooser\(/.test(mobileScript));
assert(/add\.addEventListener\('click', openMobileCalendarChooser\)/.test(mobileScript));
assert((mobileScript.match(/mobileCalendarOption\(/g) || []).length >= 5,
    'Mobile must expose three providers and the .ics fallback');
assert(/\.m-calendar-option\s*\{[\s\S]{0,180}min-height:64px/.test(mobileCss));
assert(/20260831-lan-recap/.test(desktopHtml) && /20260831-lan-recap/.test(read('m.html')),
    'Calendar assets need a shared cache-busting release tag');

console.log('Calendar checks passed (shared event model, Google, Outlook, Yahoo, .ics, desktop, mobile).');
