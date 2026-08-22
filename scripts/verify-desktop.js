const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'desktop.html'), 'utf8');
const baseCss = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const desktopCss = fs.readFileSync(path.join(root, 'desktop-v2.css'), 'utf8');

function ruleBody(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert(match, `Missing CSS rule: ${selector}`);
    return match[1];
}

const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepStrictEqual([...new Set(duplicates)], [], 'desktop.html contains duplicate IDs');

const navTargets = [...html.matchAll(/data-desktop-target="([^"]+)"/g)].map(match => match[1]);
for (const target of navTargets) {
    assert(ids.includes(target), `Desktop navigation target #${target} does not exist`);
}

const animatedBase = ruleBody(baseCss, '.animated-section');
assert(/opacity\s*:\s*0\s*;/.test(animatedBase), 'The regression fixture changed: .animated-section no longer starts transparent');

const activeMain = ruleBody(desktopCss, '#view-lan-active .active-lan-layout > main');
assert(/animation\s*:\s*none\s*!important\s*;/.test(activeMain), 'Active LAN main should not replay the legacy entrance animation');
assert(/opacity\s*:\s*1\s*;/.test(activeMain), 'Active LAN main disables an opacity-revealing animation without restoring visibility');
assert(/transform\s*:\s*none\s*;/.test(activeMain), 'Active LAN main must establish the animation final transform');

for (const id of ['view-no-lan', 'view-voting-open', 'view-waiting-closed', 'view-lan-active', 'view-lan-finished']) {
    assert(ids.includes(id), `Missing desktop phase view #${id}`);
}

console.log(`Desktop visibility checks passed (${ids.length} unique IDs, ${navTargets.length} navigation targets).`);
