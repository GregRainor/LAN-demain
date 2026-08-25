const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('core.js') + '\nthis.__ach={achievementAwardId,achievementById,achievementRevealTheme,achievementState,pendingAchievements,xpTotal,hasXpAward,isXpAwardRevoked,achievementGrantRecord,achievementResetRecord,achievementResetUpdates,unseenAchievementAwards};';
const context = vm.createContext({ console, URL, Date, Math, Promise, Set, Map });
vm.runInContext(source, context, { filename: 'core.js' });
const ach = context.__ach;
const plain = value => JSON.parse(JSON.stringify(value));

const uid = 'player-beta';
const admin = { uid: 'admin-1', name: 'Greg' };
const beta = ach.achievementById('beta');
const themedIds = ['first-buy', 'pack-1', 'lan-3', 'challenge-all', 'vote-kingmaker', 'beta'];
const revealThemes = themedIds.map(id => ach.achievementRevealTheme(ach.achievementById(id)));
assert.deepStrictEqual(plain([...new Set(revealThemes.map(theme => theme.family))].sort()),
    ['challenge', 'collection', 'commerce', 'legacy', 'prototype', 'vote']);
assert(revealThemes.every(theme => theme.accent && theme.accent2 && theme.rarity && theme.mark));
const awardId = ach.achievementAwardId(uid, beta.id);
const data = {
    economy: {}, tcg: {}, cards: [], history: {}, quests: {}, profiles: {}, roles: {},
    votes: { [uid]: { name: 'Beta', votes: { p1: ['LORT'] } } },
    settings: { beta: true }, xp: { awards: {} }
};

const initial = ach.achievementState(data, uid).find(row => row.ach.id === 'beta');
assert.strictEqual(initial.reached, true, 'Beta Tester fixture should be eligible');
assert.strictEqual(initial.pending, true, 'Eligible unawarded achievement should be pending');

const grant = ach.achievementGrantRecord(uid, beta, admin, 100);
data.xp.awards[awardId] = grant;
assert.strictEqual(ach.hasXpAward(data.xp, awardId), true);
assert.strictEqual(ach.xpTotal(data.xp, uid), 200);
assert.strictEqual(ach.achievementState(data, uid).find(row => row.ach.id === 'beta').owned, true);

const reset = ach.achievementResetRecord(uid, beta, admin, 200);
data.xp.awards[awardId] = reset;
const resetState = ach.achievementState(data, uid).find(row => row.ach.id === 'beta');
assert.strictEqual(ach.hasXpAward(data.xp, awardId), false);
assert.strictEqual(ach.isXpAwardRevoked(data.xp, awardId), true);
assert.strictEqual(resetState.owned, false);
assert.strictEqual(resetState.revoked, true);
assert.strictEqual(resetState.pending, false, 'Admin reset must suppress automatic reacquisition');
assert.strictEqual(ach.xpTotal(data.xp, uid), 0, 'Reset must remove achievement XP');
assert(!ach.pendingAchievements(data, [uid]).some(row => row.ach.id === 'beta'));

const updates = plain(ach.achievementResetUpdates(uid, beta, {
    equippedTitleId: 'beta',
    featuredAchievement1: 'first-buy',
    featuredAchievement2: 'beta',
    featuredAchievement3: 'beta'
}, admin, 300));
assert.strictEqual(updates[`lan/xp/awards/${awardId}`].revoked, true);
assert.strictEqual(updates[`lan/users/${uid}/equippedTitleId`], null);
assert(!Object.prototype.hasOwnProperty.call(updates, `lan/users/${uid}/featuredAchievement1`));
assert.strictEqual(updates[`lan/users/${uid}/featuredAchievement2`], null);
assert.strictEqual(updates[`lan/users/${uid}/featuredAchievement3`], null);

const reassigned = ach.achievementGrantRecord(uid, beta, admin, 400);
assert.strictEqual(Object.prototype.hasOwnProperty.call(reassigned, 'revoked'), false);
data.xp.awards[awardId] = reassigned;
assert.strictEqual(ach.achievementState(data, uid).find(row => row.ach.id === 'beta').owned, true);
assert.strictEqual(ach.xpTotal(data.xp, uid), 200);

let unseen = ach.unseenAchievementAwards(data.xp, uid, {}, 350);
assert.deepStrictEqual(plain(unseen.map(row => row.refId)), ['beta']);
assert.strictEqual(ach.unseenAchievementAwards(data.xp, uid, { beta: 400 }, 350).length, 0,
    'An acknowledged grant must not replay on another device');
data.xp.awards[awardId] = ach.achievementGrantRecord(uid, beta, admin, 500);
unseen = ach.unseenAchievementAwards(data.xp, uid, { beta: 400 }, 350);
assert.strictEqual(unseen.length, 1, 'A newer regrant must replay the ceremony');
data.xp.awards[awardId] = ach.achievementResetRecord(uid, beta, admin, 600);
assert.strictEqual(ach.unseenAchievementAwards(data.xp, uid, { beta: 400 }, 350).length, 0,
    'Reset tombstones are not unlock ceremonies');

const desktop = read('newScript.js');
const mobile = read('mobile.js');
const desktopHtml = read('desktop.html');
const mobileHtml = read('m.html');
const desktopCss = read('desktop-v2.css');
const mobileCss = read('mobile.css');
const rules = JSON.parse(read('database.rules.json'));
assert(desktopHtml.includes('id="ach-admin-list"') && desktop.includes('achievementResetUpdates('));
assert(desktopHtml.includes('id="ach-admin-list-dashboard"'), 'Editor must exist outside the active LAN view');
assert(desktopHtml.includes('id="btn-preview-achievement-dashboard"'));
assert(desktopHtml.includes('id="achievement-preview-select-dashboard"') && desktopHtml.includes('id="btn-preview-all-achievements-dashboard"'));
assert(desktopHtml.includes('id="achievement-preview-select-lan"') && desktopHtml.includes('id="btn-preview-all-achievements-lan"'));
assert(desktop.includes('previewAllAchievementReveals') && desktop.includes('achievementRevealTheme(ach)'));
assert(desktopHtml.includes('id="achievement-unlock-overlay"') && desktop.includes('unseenAchievementAwards('));
assert(mobileHtml.includes('id="m-ach-admin-list"') && mobile.includes('achievementResetUpdates('));
assert(mobileHtml.includes('id="m-ach-preview"') && mobileHtml.includes('id="m-ach-unlock"'));
assert(mobileHtml.includes('id="m-ach-preview-select"') && mobileHtml.includes('id="m-ach-preview-all"'));
assert(mobile.includes('previewAllMobileAchievementReveals') && mobile.includes('achievementRevealTheme(ach)'));
assert(mobile.includes('queuePendingMobileAchievementReveals') && mobile.includes('navigator.vibrate'));
for (const family of ['commerce', 'collection', 'legacy', 'challenge', 'vote', 'prototype']) {
    assert(desktopCss.includes(`data-ach-family="${family}"`), `Desktop reveal theme missing: ${family}`);
    assert(mobileCss.includes(`data-ach-family="${family}"`), `Mobile reveal theme missing: ${family}`);
}
assert(desktop.includes('isXpAwardRevoked(globalXp, awardId)'));
assert(mobile.includes('isXpAwardRevoked(state.xp, awardId)'));
const userRules = rules.rules.lan.users['$uid'];
for (const field of ['equippedTitleId', 'featuredAchievement1', 'featuredAchievement2', 'featuredAchievement3']) {
    assert(userRules[field]['.write'].includes("val() === 'admin'"), `${field} must allow admin cleanup`);
}
assert.strictEqual(rules.rules.lan.xp.awards['$award_id'].revoked['.validate'], '!newData.exists() || newData.isBoolean()');
assert(userRules.seenAchievements['$achievement_id']['.write'].includes('auth.uid === $uid'));
assert(/20260825-calendar-choice/.test(desktopHtml) && /20260825-calendar-choice/.test(mobileHtml));

console.log('Achievement administration checks passed (grant, durable reset, permanent editor, queued desktop/mobile ceremony).');