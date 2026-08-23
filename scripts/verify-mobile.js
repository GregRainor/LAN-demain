const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'm.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'mobile.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');

const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepStrictEqual([...new Set(duplicates)], [], 'm.html contains duplicate IDs');

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

for (const motion of ['m-prof-sweep', 'm-prof-prism', 'm-prof-lock', 'm-prof-orbit', 'm-prof-impact', 'm-prof-vote', 'm-prof-scan', 'm-prof-polonia']) {
    assert(css.includes('@keyframes ' + motion), 'Missing mobile Signature motion: ' + motion);
}
assert(/\.m-prof__name[\s\S]{0,500}overflow-wrap:\s*anywhere/.test(css)
    && /\.m-prof__nick[\s\S]{0,700}overflow-wrap:\s*anywhere/.test(css), 'Long mobile profile names and titles must wrap');
assert(/\.m-prof-card\s*\{[\s\S]{0,260}width:\s*100%[\s\S]{0,260}min-width:\s*0/.test(css)
    && /\.m-prof__name[\s\S]{0,520}word-break:\s*break-word/.test(css), 'Mobile Signature content must stay inside narrow phone sheets');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.m-prof-card__motif[\s\S]*animation:\s*none\s*!important/.test(css), 'Reduced motion must disable mobile Signature animation');

console.log('Mobile Signature checks passed (' + ids.length + ' unique IDs).');
