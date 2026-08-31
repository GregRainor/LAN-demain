const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'm.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'mobile.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');
const vercel = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');

function functionSource(name) {
    const start = script.indexOf('function ' + name + '(');
    assert(start >= 0, 'Missing function ' + name);
    const brace = script.indexOf('{', start);
    let depth = 0;
    for (let index = brace; index < script.length; index += 1) {
        if (script[index] === '{') depth += 1;
        if (script[index] === '}') depth -= 1;
        if (depth === 0) return script.slice(start, index + 1);
    }
    throw new Error('Unclosed function ' + name);
}

const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepStrictEqual([...new Set(duplicates)], [], 'm.html contains duplicate IDs');
const externalScripts = [...html.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g)].map(match => match[0]);
assert(externalScripts.length >= 7 && externalScripts.every(tag => /\bdefer\b/.test(tag)),
    'Every mobile script must preserve ordered, non-blocking loading');
assert(!/\bsrc=""/.test(html) && !/\.src\s*=\s*['"]['"]/.test(script),
    'Mobile must not create empty image requests');

assert(/profiles:\s*state\.profiles/.test(script)
    && /roles:\s*state\.roles/.test(script)
    && /adminUid:\s*ADMIN_UID/.test(script), 'Mobile profile data must honor equipped and role titles');
assert(/function applyMobileProfileTheme/.test(script)
    && /dataset\.titleMotion/.test(script)
    && /m-prof-card__foil/.test(script), 'Mobile Signature theme binding is incomplete');
assert(/id="m-profile-trigger"/.test(html)
    && /m-profile-trigger'\)\.addEventListener\('click'[\s\S]{0,120}openProfile/.test(script), 'Own mobile avatar must open the player profile');
assert(/body\.classList\.add\('m-sheet__body--profile'\)/.test(script)
    && /applyMobileProfileTheme\(root, profile\.equippedTitle\)/.test(script)
    && /\.m-prof\[data-title-motif="polonia"\]::before/.test(css), 'The equipped title must theme the full mobile dossier');
assert(/Personnaliser ma Signature/.test(script)
    && /featuredAchievement/.test(script)
    && /equippedTitleId/.test(script), 'Mobile Signature customization is incomplete');
assert(/function phaseFallbackScreen/.test(script)
    && /function repairUnavailableNavigation/.test(script)
    && /history\.replaceState\(\{ screen: fallback \}/.test(script), 'Unavailable history entries must repair to a safe mobile root');
assert(/document\.querySelectorAll\('\[data-goto\]'\)/.test(script)
    && /control\.disabled\s*=\s*locked/.test(script)
    && /aria-disabled/.test(script), 'Every unavailable mobile destination must be truly disabled');
assert(/\.m-sheet__body\s*\{[\s\S]{0,260}flex:\s*1 1 auto[\s\S]{0,180}min-height:\s*0[\s\S]{0,240}overflow-y:\s*auto/.test(css)
    && /\.m-sheet\.m-sheet--profile \.m-sheet__panel\s*\{\s*height:\s*90dvh/.test(css)
    && /classList\.toggle\('m-sheet--profile'/.test(script)
    && /\.m-prof\s*\{[\s\S]{0,260}flex:\s*0 0 auto/.test(css)
    && /touch-action:\s*pan-y/.test(css), 'Long mobile sheets must own a bounded touch scroll area');
assert(/#m-btn-notifs svg\s*\{[\s\S]{0,180}display:\s*block/.test(css)
    && /\.m-iconbtn\s*\{[\s\S]{0,180}padding:\s*0/.test(css), 'The notification glyph must be explicitly centered in its button');
assert(!html.includes('m-goto-desktop')
    && !script.includes('lan_vue=bureau')
    && !vercel.includes('"key": "lan_vue"'), 'Mobile routing must not expose or honor a persistent desktop switch');
assert(/id="m-editorial"/.test(html)
    && /id="m-overview"/.test(html)
    && /function renderEditorialHome\(/.test(script)
    && /Composez la prochaine nuit/.test(script), 'Direction A editorial home is incomplete');
assert((html.match(/class="m-tab(?:\s|")/g) || []).length === 5
    && /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/.test(css)
    && /data-goto="cartes"/.test(html), 'The mobile dock must mirror the five-destination desktop architecture');
assert(/data-goto="miam"/.test(html)
    && /data-goto="sondages"/.test(html)
    && /m-plus-miam/.test(html)
    && /m-plus-sondages/.test(html), 'Food runs and polls must remain reachable from Plus');
for (const motion of ['m-shell-down', 'm-title-in', 'm-line-draw', 'm-stat-in', 'm-rank-in', 'm-tab-ink', 'm-action-sweep', 'm-phase-shift']) {
    assert(css.includes('@keyframes ' + motion), 'Missing Bureau en poche motion: ' + motion);
}
assert(/lanRecapHighlights\([\s\S]{0,160}state\.quests, recapSince/.test(script)
    && /Złotych gagnés/.test(script)
    && /filter\(\(\[, amount\]\) => Number\(amount\) > 0\)/.test(script),
    'Mobile recap must derive economy and collection figures and suppress zero metrics');
assert(/Plus gros gain de złotych/.test(script) && /Plus de défis relevés/.test(script)
    && !/title: 'Plus riche'/.test(script), 'Mobile recap must reward earnings and challenges, not leftover balance');
assert(/m-recap-infographic/.test(script)
    && /\.m-recap-metric\s*\{/.test(css)
    && /@keyframes m-recap-metric-in/.test(css), 'Mobile figures must render as an animated infographic');
for (const motion of ['m-recap-badge-in', 'm-recap-badge-shine']) {
    assert(css.includes('@keyframes ' + motion), 'Missing mobile recap motion: ' + motion);
}
assert(/prefers-reduced-motion[\s\S]*\.m-recap-award/.test(css),
    'Mobile recap badges must honor reduced motion');

/* Régression exacte du cas signalé : vote ouvert, LAN non active. Les écrans
   de soirée sont fermés, mais Jeux et Vote restent atteignables et la racine
   de secours ne peut jamais être une destination verrouillée. */
const navState = { settings: {} };
const navFactory = new Function('state', 'LAN_SCREENS', [
    functionSource('phase'),
    functionSource('screenAvailable'),
    functionSource('phaseFallbackScreen'),
    'return { phase, screenAvailable, phaseFallbackScreen };'
].join('\n'));
const nav = navFactory(navState, ['miam', 'sondages', 'evenements', 'kocktails', 'boutique']);

navState.settings = { isVotingOpen: true, isLanActive: false, lanFinished: false };
assert.strictEqual(nav.phase(), 'vote');
assert.strictEqual(nav.screenAvailable('vote'), true);
assert.strictEqual(nav.screenAvailable('jeux'), true);
assert.strictEqual(nav.screenAvailable('evenements'), false);
assert.strictEqual(nav.screenAvailable('boutique'), false);
assert.strictEqual(nav.phaseFallbackScreen(), 'soiree');

navState.settings = { isVotingOpen: false, isLanActive: false, lanFinished: true };
assert.strictEqual(nav.phase(), 'finished');
assert.strictEqual(nav.screenAvailable('bilan'), true);
assert.strictEqual(nav.screenAvailable('vote'), false);
assert.strictEqual(nav.phaseFallbackScreen(), 'bilan');

for (const motion of ['m-prof-sweep', 'm-prof-prism', 'm-prof-lock', 'm-prof-orbit', 'm-prof-impact', 'm-prof-vote', 'm-prof-scan', 'm-prof-polonia']) {
    assert(css.includes('@keyframes ' + motion), 'Missing mobile Signature motion: ' + motion);
}
assert(/\.m-prof__name[\s\S]{0,500}overflow-wrap:\s*anywhere/.test(css)
    && /\.m-prof__nick[\s\S]{0,700}overflow-wrap:\s*anywhere/.test(css), 'Long mobile profile names and titles must wrap');
assert(/\.m-prof-card\s*\{[\s\S]{0,260}width:\s*100%[\s\S]{0,260}min-width:\s*0/.test(css)
    && /\.m-prof__name[\s\S]{0,520}word-break:\s*break-word/.test(css), 'Mobile Signature content must stay inside narrow phone sheets');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.m-prof-card__motif[\s\S]*animation:\s*none\s*!important/.test(css), 'Reduced motion must disable mobile Signature animation');

console.log('Mobile Signature checks passed (' + ids.length + ' unique IDs).');
