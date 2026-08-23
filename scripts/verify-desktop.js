const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'desktop.html'), 'utf8');
const baseCss = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const desktopCss = fs.readFileSync(path.join(root, 'desktop-v2.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'newScript.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'database.rules.json'), 'utf8');

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

const scopedSizing = ruleBody(desktopCss, 'body.desktop-authenticated #app-container.desktop-os *::after');
assert(/box-sizing\s*:\s*border-box\s*;/.test(scopedSizing), 'Desktop OS must use border-box sizing so padded 100% panels stay inside the canvas');

const stageView = ruleBody(desktopCss, '.desktop-stage > #view-waiting-closed');
assert(/overflow-x\s*:\s*hidden\s*;/.test(stageView), 'Desktop phase views must contain horizontal overflow');

assert(ids.includes('btn-calendar-back'), 'Programme is missing its explicit back action');
assert(/btn-calendar-back[\s\S]{0,360}activateDesktopSubview\('lan-dashboard'\)/.test(script), 'Programme back action must return to the active LAN dashboard');
assert(/event\.target\s*===\s*playerModal/.test(script), 'Player profile must close when its overlay is clicked');
assert(/id="user-info-menu"[^>]*role="button"[^>]*tabindex="0"/.test(html), 'Own-profile trigger must remain keyboard accessible');
assert(/admin-command-card--broadcast/.test(html) && /admin-command-card--danger/.test(html), 'Active admin console structure is incomplete');
assert(/id="vote-history-podium"/.test(html) && /id="vote-history-game-count"/.test(html), 'Vote history must keep its desktop summary and podium');
assert(/class="desktop-vote-intro"/.test(html) && /class="vote-panel-heading/.test(html), 'Voting phase must use the desktop editorial structure');
assert(/desktop-vote-intro__rule/.test(html) && /À quoi joue-t-on/.test(html), 'Voting intro must use the compact ballot framing');
assert((html.match(/class="add-game-btn"/g) || []).length === 3 && /add-game-btn"><span[^>]*>\+<\/span> Ajouter un jeu/.test(html), 'Voting add controls must be explicit and remain below their lists');
assert(/let desktopVotingDestination = 'games'/.test(script) && /phase === 'voting' && destination === 'home'/.test(script), 'Events must route to Programme while voting is open');
assert(/desktopPhase\(\) === 'voting'[\s\S]{0,180}desktopVotingDestination = 'games'/.test(script), 'Programme back action must return to the voting ballot');
assert(!/Quand & où/.test(html) && !/Quand & où/.test(script), 'Desktop copy must use Quand et où');
assert(/class="luxury-panel recap-admin"/.test(html) && /id="recap-seal-date"/.test(html), 'Finished LAN must expose the redesigned next-chapter panel');

assert(/const activeValueWatches = \[\]/.test(script) && /function stopValueWatches\(\)/.test(script), 'Firebase value listeners must be tracked for logout teardown');
assert(/stopValueWatches\(\);[\s\S]{0,240}await auth\.signOut\(\)/.test(script), 'Logout must detach Firebase listeners before removing authentication');
assert(/globalPolls = \{\};\s*globalFoodRuns = \{\};\s*announcedPolls\.clear\(\)/.test(script), 'Logout must clear stale countdown data');
assert(/if \(leftSidebar\) leftSidebar\.style\.display = 'none'/.test(script), 'The hidden voting admin rail must not reserve space for players');
assert(/#view-voting-open \.add-game-btn\s*\{[\s\S]{0,120}position: static/.test(desktopCss), 'Voting add controls must sit in document flow below each priority');
assert(/const addButton = e\.target\.closest\('\.add-game-btn'\)/.test(script), 'Nested add-control content must preserve the click target');
assert(/className = 'user-roster-copy'/.test(script) && /À la table/.test(script), 'Desktop roster must use the name and presence space beside each avatar');
assert(/#view-voting-open #vote-form\s*\{[\s\S]{0,180}grid-template-columns: repeat\(2/.test(desktopCss), 'Voting ballot must use the ranked-card composition');
assert(/const gamesUnlocked = phase === 'voting' \|\| phase === 'active'/.test(script), 'Games navigation must lock outside voting and active LAN phases');
assert(/phase === 'voting' \? desktopVotingDestination === 'events' : true/.test(script)
    && /phase === 'voting' && desktopVotingDestination === 'games'/.test(script), 'Events and Games navigation highlights must remain exclusive');
// Le panneau admin est une destination, pas une phase. Testé après la branche
// « terminée », le clic sur « Panneau admin » se faisait reprendre la main par
// le récapitulatif et n'ouvrait jamais la console.
assert(script.indexOf("if (desktopAdminOverride && window.currentUserIsAdmin && phase !== 'active')")
    < script.indexOf("if (phase === 'finished')"), 'Admin console must be reachable once the LAN is over');
assert(!/recapAdmin\.scrollIntoView/.test(script), 'The finished-LAN admin fallback must not survive the real console');
assert(/adminBox\.style\.display = window\.currentUserIsAdmin \? 'grid' : 'none'/.test(script), 'Finished-LAN admin controls must preserve their grid layout');
assert(/class="luxury-panel modal-content prof-dossier"/.test(html)
    && ids.includes('player-prof-progress-copy')
    && ids.includes('player-prof-achievement-count')
    && /class="prof-signature-layout"/.test(html), 'Player profile must use the centered Signature Card structure');
assert(/class="prof-signature-card"/.test(html)
    && /class="prof-signature-card__core"/.test(html)
    && ids.includes('player-prof-customizer')
    && ids.includes('player-prof-title-options')
    && ids.includes('player-prof-feature-options'), 'Player profile customization structure is incomplete');
assert(/\.prof-signature-card__core\s*\{[\s\S]*?place-content:\s*center;[\s\S]*?justify-items:\s*center;/.test(desktopCss), 'Signature identity block must be centered horizontally and vertically');
assert(/\.prof-featured-trophy\s*>\s*svg\s*\{[\s\S]*?box-sizing:\s*border-box;/.test(desktopCss)
    && /\.prof-badge\s*>\s*svg\s*\{[\s\S]*?box-sizing:\s*border-box;/.test(desktopCss), 'Achievement icons must keep a bounded column separate from their labels');
assert(/equippedTitleId/.test(script) && /featuredAchievement/.test(script), 'Player title and trophy choices must persist on the durable profile');
assert(/dataset\.playerNameLength/.test(script), 'Long desktop player names must adjust the centered Signature composition');
assert(/id="player-prof-customize-btn"[\s\S]{0,320}<svg/.test(html), 'Profile customization needs its visible brush icon');
assert(/id="btn-notifications"[\s\S]{0,260}<svg/.test(html), 'Desktop notifications must use a real bell icon');
assert(!html.includes('btn-mobile-version') && !script.includes('lan_vue=mobile'), 'Desktop must not expose the obsolete reciprocal interface switch');
assert(/#top-right-actions #btn-notifications\s*\{[\s\S]{0,500}display:\s*grid;[\s\S]{0,260}place-items:\s*center;[\s\S]{0,260}line-height:\s*0;/.test(desktopCss)
    && /#top-right-actions #btn-notifications svg\s*\{[\s\S]{0,180}display:\s*block;/.test(desktopCss)
    && !/btnNotif(?:Preview|Recap)?\.style\.display\s*=\s*'inline-flex'/.test(script), 'Desktop bell must remain centered in every phase');
assert(/applyProfileTheme/.test(script) && /data-title-rarity/.test(html) && /data-title-motion/.test(html), 'Equipped titles must drive a controlled visual and motion theme');
assert(/PROFILE_ROLE_TITLES/.test(core)
    && /administrator/.test(core)
    && /newData\.val\(\) === 'administrator'/.test(rules), 'Administrator must be a role-gated Signature title');
assert(/class="results-table__score-col"/.test(html), 'Live ranking must reserve a stable score column');
assert(/class="results-empty"/.test(script) && /La tendance apparaîtra ici en direct/.test(script), 'Live ranking must have an intentional empty state');
assert(/prof-votes-empty/.test(script) && /prof-vote-group--\$\{tier\}/.test(script), 'Player votes must use dossier components instead of inline legacy styles');

const adminNav = ruleBody(desktopCss, '.desktop-admin-nav');
assert(/margin\s*:\s*auto 25px 0\s*;/.test(adminNav), 'Desktop Admin navigation must stay anchored at the bottom-left');
const scoreColumn = ruleBody(desktopCss, '#view-voting-open .results-table__score-col');
assert(/width\s*:\s*78px\s*;/.test(scoreColumn), 'Live ranking score column must remain aligned');
const profileBody = ruleBody(desktopCss, '#player-votes-modal .prof-dossier__body');
assert(/grid-template-columns\s*:\s*minmax\(0, 1fr\) 300px\s*;/.test(profileBody), 'Desktop profile must separate achievements from the compact ballot');

for (const animation of ['desktopAmbientDrift', 'desktopShellDown', 'desktopShellSide', 'desktopStageReveal', 'desktopNavSettle', 'desktopPresencePulse', 'desktopViewIn', 'desktopPanelIn', 'desktopScrollReveal', 'desktopScrollRevealSide', 'desktopProfileOpen', 'desktopLevelBreathe', 'profileTitleShimmer', 'profileCardFoil', 'profileHaloTurn', 'profileTrophyRise', 'profileCommerceSweep', 'profileCollectionFoil', 'profileMischiefLock', 'profileLegacyOrbit', 'profileChallengeImpact', 'profileVoteSignal', 'profilePrototypeScan', 'profilePoloniaRibbon']) {
    assert(desktopCss.includes(`@keyframes ${animation}`), `Missing desktop motion keyframes: ${animation}`);
}
assert(/\.lan-subview\.active\s*\{[^}]*animation:\s*desktopViewIn/.test(desktopCss), 'Active desktop views must animate when navigation changes');
assert(/\.lan-subview\.active\s*\{[^}]*animation:\s*desktopViewIn[^;}]*backwards/.test(desktopCss), 'View entrances must release transform control after playing');
assert(/new IntersectionObserver/.test(script) && /new MutationObserver\(scheduleDesktopMotionRefresh\)/.test(script), 'Dynamic desktop catalogues must use viewport-aware motion');
assert(/#tcg-set-grid \.tcard/.test(desktopCss), 'Collection motion must target the generated .tcard elements');
assert(/--desktop-scroll-progress/.test(desktopCss) && /updateDesktopScrollProgress/.test(script), 'Long desktop views must expose scroll progress');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.desktop-os \.animated-section\s*\{[\s\S]*opacity:\s*1\s*!important/.test(desktopCss), 'Reduced-motion mode must keep legacy animated sections visible');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*#player-votes-modal > \.modal-content[\s\S]*animation:\s*none\s*!important/.test(desktopCss), 'Reduced-motion mode must disable profile animation');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*#player-votes-modal \.prof-head__nick::after[\s\S]*animation:\s*none\s*!important/.test(desktopCss), 'Reduced-motion mode must disable earned-title shimmer');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*#player-votes-modal \.prof-signature-card__foil[\s\S]*animation:\s*none\s*!important/.test(desktopCss), 'Reduced-motion mode must disable Signature Card foil motion');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*#player-votes-modal \.prof-signature-card__motif[\s\S]*#player-votes-modal \.prof-head__nick[\s\S]*animation:\s*none\s*!important/.test(desktopCss), 'Reduced-motion mode must disable family-specific Signature motion');
assert(/\.prof-head__nick[\s\S]{0,900}overflow-wrap:\s*anywhere/.test(desktopCss)
    && /\.prof-title-choice strong[\s\S]{0,400}-webkit-line-clamp:\s*2/.test(desktopCss)
    && /\.prof-featured-trophy strong[\s\S]{0,400}-webkit-line-clamp:\s*2/.test(desktopCss), 'Long profile titles and trophy labels must wrap without collision');

/* ==========================================================================
   TOUT SOUS-ÉCRAN DOIT AVOIR UNE ROUTE
   La coque a été posée par-dessus le DOM existant en masquant en CSS. Quatre
   sous-écrans se sont retrouvés rendus, stylés — et injoignables. Cette
   vérification est le garde-fou : un .lan-subview qu'aucun bouton n'ouvre est
   une régression, pas un détail.
   ========================================================================== */

const subviewIds = [...html.matchAll(/<div id="(lan-[^"]+)" class="lan-subview/g)].map(match => match[1]);
assert(subviewIds.length >= 10, 'The subview fixture changed: no .lan-subview found in desktop.html');

// Les routes déclarées dans le balisage (rail et barre secondaire) …
const routed = new Set([...html.matchAll(/data-desktop-target="([^"]+)"/g)].map(match => match[1]));
// … et celles écrites en dur dans activateDesktopSubview / les gestionnaires.
for (const hardcoded of ['lan-dashboard', 'lan-calendar', 'lan-games', 'lan-admin']) {
    assert(new RegExp(`activateDesktopSubview\\('${hardcoded}'\\)`).test(script)
        || new RegExp(`data-target="${hardcoded}"`).test(html), `No code route opens #${hardcoded}`);
    routed.add(hardcoded);
}
for (const id of subviewIds) {
    assert(routed.has(id), `Dead screen: #${id} is rendered but nothing opens it`);
}

// L'aiguillage hérité doit encore contenir chaque cible : activateDesktopSubview
// clique dedans, et un clic sur une entrée absente ne fait rien du tout.
for (const id of subviewIds) {
    assert(html.includes(`data-target="${id}"`), `The legacy funnel lost its entry for #${id}`);
}
assert(/<div class="lan-nav-funnel" hidden>/.test(html)
    && !/active-lan-layout > aside\s*\{[^}]*display:\s*none/.test(desktopCss),
    'The legacy funnel must be hidden by markup, not by another display:none');

// Kocktails a rejoint Les Fins Gourmets : une porte, deux sections.
assert(!subviewIds.includes('lan-kocktails')
    && /id="gourmet-bar-title"/.test(html)
    && /id="kocktail-master-list"/.test(html), 'Kocktails must live inside Les Fins Gourmets');
assert(/targetId === 'lan-food'[\s\S]{0,220}renderCocktails/.test(script), 'Opening Les Fins Gourmets must render the bar too');

/* --- L'historique est un onglet permanent -------------------------------- */
assert(/data-desktop-destination="history"/.test(html)
    && !/id="btn-lan-history"/.test(html), 'LAN history must be a rail destination, not a hidden topbar button');
assert(!/#btn-lan-history/.test(desktopCss), 'Nothing should hide the LAN history control any more');
assert(/function openLanHistory\(\)/.test(script)
    && /destination === 'history'[\s\S]{0,120}openLanHistory\(\)/.test(script), 'The rail must open the history window');
// Supprimer une LAN archivée : les règles autorisent l'écriture sur
// lan/history aux seuls admins, la confirmation reste obligatoire.
assert(/db\.ref\(`lan\/history\/\$\{entry\.id\}`\)\.remove\(\)/.test(script)
    && /askConfirm\([\s\S]{0,160}de l'historique/.test(script), 'Deleting an archived LAN must be admin-only and confirmed');
assert(/"history":\s*\{\s*"\.read"[^}]*"\.write":\s*"auth != null && \(root\.child\('lan\/roles'\)/.test(rules),
    'lan/history must stay admin-writable for the delete action to work');

/* --- La Boutique : trois volets, plus aucun panneau éteint ---------------- */
assert(!/#lan-boutique[^{]*\.dashboard-grid\s*\{[^}]*display:\s*none/.test(desktopCss),
    'Shop panels must have a route, not a display:none');
for (const id of ['shop-feed', 'shop-leaderboard', 'shop-my-purchases', 'ach-list', 'lan-titles', 'xp-board']) {
    assert(ids.includes(id), `Shop panel #${id} disappeared instead of getting a route`);
}
const shopPanes = [...html.matchAll(/data-shop-pane="([a-z-]+)"/g)].map(match => match[1]);
for (const pane of ['carte', 'registre', 'hauts-faits']) {
    assert(shopPanes.filter(name => name === pane).length === 2,
        `Shop pane "${pane}" needs both its tab and its panel`);
}
// Un volet fermé ne se construit pas : six panneaux se redessinaient à chaque
// mouvement de l'économie pour un DOM que personne ne regardait.
for (const fn of ['renderShopFeed', 'renderShopLeaderboard', 'renderAchievements']) {
    assert(new RegExp(`function ${fn}\\(\\) \\{\\s*if \\(!shopPaneIsOpen\\(`).test(script),
        `${fn} must not build DOM for a closed pane`);
}
assert(/function renderMyShopRequests\(user\) \{\s*if \(!shopPaneIsOpen\('registre'\)\)/.test(script),
    'renderMyShopRequests must not build DOM for a closed pane');

/* --- Le niveau et le solde ne s'affichent qu'une fois --------------------- */
assert(!ids.includes('xp-level') && !ids.includes('xp-segs') && !ids.includes('wallet-value'),
    'Level and balance belong to the topbar: the shop must not repeat them');
assert(ids.includes('desktop-level-value') && ids.includes('desktop-wallet-value'),
    'The topbar must remain the single place that states level and balance');
assert(ids.includes('wallet-hint'), 'Where the points come from is the one thing the topbar cannot say');

/* --- Entre le vote et la soirée ------------------------------------------ */
assert(/Les jeux sont faits/.test(html)
    && /PROCHAIN RENDEZ-VOUS/.test(html)
    && ids.includes('waiting-days') && ids.includes('waiting-hours') && ids.includes('waiting-minutes'),
    'The locked phase must show the countdown banner from the design');
assert(/VAINQUEUR DES VOTES/.test(html) && /À INSTALLER/.test(html) && /PROGRAMME ANNONCÉ/.test(html),
    'The locked phase must show its three columns');
assert(/function renderWaitingInstall/.test(script) && /knownGames\(\{ libraries:/.test(script),
    'Readiness must be read from the declared Steam libraries, not from a new write path');
assert(!/renderMarquee/.test(script) && !/marquee/.test(html) && !/marquee/.test(baseCss),
    'The scrolling backdrop was hidden in every phase: it must be gone, not hidden');

/* --- Le tableau de bord de la soirée -------------------------------------- */
assert(/LA PARTIE EN COURS/.test(html) && /ENSUITE/.test(html) && /COMMANDE OUVERTE/.test(html)
    && /ACTIONS RAPIDES/.test(html) && /À VALIDER/.test(html),
    'The active LAN dashboard must answer the four questions of the evening');
assert(/function renderBoardReview/.test(script) && /isGm \? \(purchase\.userName/.test(script),
    'The review panel must show the gamemaster his queue and a player his own');
assert(/#lan-dashboard \[data-desktop-target\]/.test(script),
    'Dashboard shortcuts must reuse the rail routing instead of their own');

/* --- La barre secondaire de la soirée ------------------------------------- */
assert(/id="desktop-subnav"/.test(html)
    && /const DESKTOP_EVENT_SPACE = \['lan-dashboard', 'lan-calendar', 'lan-events', 'lan-polls', 'lan-library'\]/.test(script),
    'The five rooms behind Événements need one shared list');
assert(/item\.classList\.toggle\('is-locked', locked\)[\s\S]{0,120}item\.disabled = locked/.test(script),
    'Subnav destinations must lock, never disappear');

for (const id of ['view-no-lan', 'view-voting-open', 'view-waiting-closed', 'view-lan-active', 'view-lan-finished']) {
    assert(ids.includes(id), `Missing desktop phase view #${id}`);
}

console.log(`Desktop shell checks passed (${ids.length} unique IDs, ${navTargets.length} navigation targets).`);
