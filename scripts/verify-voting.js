const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('core.js') + '\nthis.__vote={normalizeBallot,ballotCount,ballotRecordForRound,voterIds,saveBallotWithRevision,calculateScores,newLanResetUpdates,archiveAndResetLan};';
const context = vm.createContext({ console, URL, Date, Math, Promise, Set, Map });
vm.runInContext(source, context, { filename: 'core.js' });
const vote = context.__vote;
const plain = value => JSON.parse(JSON.stringify(value));

function mockRef(initial) {
    let value = initial;
    return {
        transaction(update, done) {
            const next = update(value);
            if (next === undefined) return done(null, false, { val: () => value });
            value = next;
            done(null, true, { val: () => value });
        },
        value: () => value
    };
}

async function run() {
    assert.deepStrictEqual(plain(vote.normalizeBallot({
        p1: [' LORT ', 'illegal second P1'],
        p2: ['lort', ' Cameleon '],
        p3: { 0: 'Minecraft' },
        p_other: 'Warframe'
    })), {
        p1: ['LORT'], p2: ['Cameleon'], p3: ['Minecraft'], p_other: ['Warframe']
    });

    assert.deepStrictEqual(plain(vote.calculateScores({
        attacker: { votes: { p1: ['A', 'B'], p2: ['a', 'C'], injected: ['Z'] } }
    })), [{ name: 'A', score: 5 }, { name: 'C', score: 3 }]);

    assert.deepStrictEqual(plain(vote.voterIds({
        good: { roundId: 'r1', votes: { p1: ['LORT'] } },
        stale: { roundId: 'r0', votes: { p1: ['Cameleon'] } },
        empty: { roundId: 'r1', votes: {} }
    }, { voteRoundId: 'r1' })), ['good']);

    const ref = mockRef(null);
    const first = await vote.saveBallotWithRevision(ref, {
        name: 'Greg', votes: { p1: ['LORT'] }, roundId: 'r1',
        baseRevision: 0, device: 'desktop', serverTimestamp: 1
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.record.revision, 1);

    const stale = await vote.saveBallotWithRevision(ref, {
        name: 'Greg', votes: { p1: ['Minecraft'] }, roundId: 'r1',
        baseRevision: 0, device: 'mobile', serverTimestamp: 2
    });
    assert.strictEqual(stale.ok, false);
    assert.deepStrictEqual(plain(ref.value().votes.p1), ['LORT']);

    const wrongRound = await vote.saveBallotWithRevision(ref, {
        name: 'Greg', votes: { p1: ['Minecraft'] }, roundId: 'r2',
        baseRevision: 0, force: true, device: 'mobile', serverTimestamp: 3
    });
    assert.strictEqual(wrongRound.ok, false, 'Force may replace a revision, never a different round');
    assert.deepStrictEqual(plain(ref.value().votes.p1), ['LORT']);

    const forced = await vote.saveBallotWithRevision(ref, {
        name: 'Greg', votes: { p1: ['Minecraft'] }, roundId: 'r1',
        baseRevision: 0, force: true, device: 'mobile', serverTimestamp: 3
    });
    assert.strictEqual(forced.record.revision, 2);

    const reset = vote.newLanResetUpdates('r2', 'Next');
    for (const key of ['votes', 'events', 'polls', 'steamLibraries', 'economy/ledger']) {
        assert.strictEqual(reset[key], null);
    }
    assert.strictEqual(reset['settings/voteRoundId'], 'r2');

    const calls = [];
    const db = { ref(firebasePath) {
        if (firebasePath.indexOf('lan/history/') === 0) {
            return { async transaction(update) { calls.push(firebasePath); update(null); } };
        }
        return { async update(updates) { calls.push(updates); } };
    } };
    await vote.archiveAndResetLan(db, 'round.current', { name: 'Old' }, reset);
    assert.strictEqual(calls[0], 'lan/history/round-current');
    assert.strictEqual(calls[1]['settings/voteRoundId'], 'r2');

    const desktop = read('newScript.js');
    const mobile = read('mobile.js');
    const start = desktop.indexOf('function renderActiveLanAllGames');
    const end = desktop.indexOf('\n    function ', start + 20);
    assert(start >= 0 && end > start);
    assert(!/players\.forEach|writes\.push|closureAchievements/.test(desktop.slice(start, end)));
    assert(/saveBallotWithRevision/.test(desktop) && /saveBallotWithRevision/.test(mobile));
    assert(/archiveAndResetLan/.test(desktop) && /archiveAndResetLan/.test(mobile));
    assert(!/archiveVotesOnClose/.test(desktop));

    const rules = read('database.rules.json');
    JSON.parse(rules);
    assert(/isVotingOpen'\)\.val\(\) === true/.test(rules));
    assert(/isLanActive'\)\.val\(\) !== true/.test(rules));
    assert(/lanFinished'\)\.val\(\) !== true/.test(rules));
    assert(/\$g\.matches\(\/\^0\$\/\)/.test(rules));
    assert(/newData\.hasChildren\(\['roundId', 'revision', 'updatedAt', 'updatedByDevice'\]\)/.test(rules));

    assert(/core\.js\?v=20260831-lan-infographic/.test(read('desktop.html')));
    assert(/newScript\.js\?v=20260831-lan-infographic/.test(read('desktop.html')));
    assert(/core\.js\?v=20260831-lan-infographic/.test(read('m.html')));
    assert(/mobile\.js\?v=20260831-lan-infographic/.test(read('m.html')));
    console.log('Voting lifecycle checks passed (desktop, mobile, rules, conflicts, reset).');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
