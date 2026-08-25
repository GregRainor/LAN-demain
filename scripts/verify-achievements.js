const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('core.js') + '\nthis.__ach={achievementAwardId,achievementById,achievementState,pendingAchievements,xpTotal,hasXpAward,isXpAwardRevoked,achievementGrantRecord,achievementResetRecord,achievementResetUpdates};';
const context = vm.createContext({ console, URL, Date, Math, Promise, Set, Map });
vm.runInContext(source, context, { filename: 'core.js' });
const ach = context.__ach;
const plain = value => JSON.parse(JSON.stringify(value));

const uid = 'player-beta';
const admin = { uid: 'admin-1', name: 'Greg' };
const beta = ach.achievementById('beta');
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

const desktop = read('newScript.js');
const mobile = read('mobile.js');
const desktopHtml = read('desktop.html');
const mobileHtml = read('m.html');
const rules = JSON.parse(read('database.rules.json'));
assert(desktopHtml.includes('id="ach-admin-list"') && desktop.includes('achievementResetUpdates('));
assert(mobileHtml.includes('id="m-ach-admin-list"') && mobile.includes('achievementResetUpdates('));
assert(desktop.includes('isXpAwardRevoked(globalXp, awardId)'));
assert(mobile.includes('isXpAwardRevoked(state.xp, awardId)'));
const userRules = rules.rules.lan.users['$uid'];
for (const field of ['equippedTitleId', 'featuredAchievement1', 'featuredAchievement2', 'featuredAchievement3']) {
    assert(userRules[field]['.write'].includes("val() === 'admin'"), `${field} must allow admin cleanup`);
}
assert.strictEqual(rules.rules.lan.xp.awards['$award_id'].revoked['.validate'], '!newData.exists() || newData.isBoolean()');

console.log('Achievement administration checks passed (grant, durable reset, profile cleanup, desktop/mobile parity).');