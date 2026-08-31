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
const externalScripts = [...html.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g)].map(match => match[0]);
assert(externalScripts.length >= 7 && externalScripts.every(tag => /\bdefer\b/.test(tag)),
    'Every desktop script must preserve ordered, non-blocking loading');
assert(!/\bsrc=""/.test(html) && !/\.src\s*=\s*['"]['"]/.test(script),
    'Desktop must not create empty image requests');
assert(/userAvatarImg\.src = safeAvatarUrl\(user\.photoURL/.test(script)
    && /winnerImage\.removeAttribute\('src'\)/.test(script), 'Desktop avatar and winner fallbacks are incomplete');
assert(/:is\(a,button,input,select,textarea,summary,\[tabindex\]\):focus-visible/.test(desktopCss),
    'Desktop controls need a global visible keyboard-focus fallback');

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

// Le rail et la barre secondaire sont la route : un « ← Retour » de plus dans
// l'écran était un vestige de l'époque sans coque.
assert(!ids.includes('btn-calendar-back') && !/desktop-back-btn/.test(desktopCss),
    'Programme must rely on the rail, not on a leftover back button');
assert(/event\.target\s*===\s*playerModal/.test(script), 'Player profile must close when its overlay is clicked');
assert(/id="user-info-menu"[^>]*role="button"[^>]*tabindex="0"/.test(html), 'Own-profile trigger must remain keyboard accessible');
assert(/admin-command-card--broadcast/.test(html) && /admin-command-card--danger/.test(html), 'Active admin console structure is incomplete');
assert(/id="vote-history-podium"/.test(html) && /id="vote-history-game-count"/.test(html), 'Vote history must keep its desktop summary and podium');
assert(/class="desktop-vote-intro"/.test(html) && /class="vote-panel-heading/.test(html), 'Voting phase must use the desktop editorial structure');
/* Le rappel « POIDS DU BULLETIN · 5 · 3 · 2 · 1 » a été retiré le 24 août : il
   répétait le barème déjà porté par chaque priorité du bulletin, juste à côté.
   L'accroche, elle, reste. */
assert(/À quoi joue-t-on/.test(html), 'Voting intro must keep its editorial hook');
assert(!/desktop-vote-intro__rule/.test(html), 'The ballot-weight reminder was removed as redundant');
assert((html.match(/class="add-game-btn"/g) || []).length === 3 && /add-game-btn"><span[^>]*>\+<\/span> Ajouter un jeu/.test(html), 'Voting add controls must be explicit and remain below their lists');
assert(/let desktopVotingDestination = 'games'/.test(script) && /phase === 'voting' && destination === 'home'/.test(script), 'Events must route to Programme while voting is open');
// Pendant le vote, on quitte le Programme par le rail : « Jeux » ramène au
// bulletin. C'est la seule route depuis que le bouton « Retour » a disparu.
assert(/phase === 'voting' && destination === 'games'\)\s*\{\s*desktopVotingDestination = 'games'/.test(script),
    'The rail must lead back to the ballot while voting is open');
assert(!/Quand & où/.test(html) && !/Quand & où/.test(script), 'Desktop copy must use Quand et où');
assert(/class="luxury-panel recap-admin"/.test(html) && /id="recap-seal-date"/.test(html), 'Finished LAN must expose the redesigned next-chapter panel');
assert(ids.includes('recap-awards-panel') && ids.includes('recap-awards') && ids.includes('recap-stats-panel'),
    'Finished LAN must expose conditional stats and a hall of fame');
assert(/lanRecapHighlights\(globalEconomy, globalTcg, economyPlayers\(\)\)/.test(script)
    && /Złotych gagnés/.test(script)
    && /filter\(\(\[, amount\]\) => Number\(amount\) > 0\)/.test(script),
    'Desktop recap must derive economy and collection figures and suppress zero metrics');
assert(/@keyframes recap-badge-in/.test(baseCss)
    && /@keyframes recap-badge-shine/.test(baseCss)
    && /prefers-reduced-motion[\s\S]*\.recap-award/.test(baseCss),
    'Desktop recap badges need an accessible motion treatment');

assert(/const activeValueWatches = \[\]/.test(script) && /function stopValueWatches\(\)/.test(script), 'Firebase value listeners must be tracked for logout teardown');
assert(/stopValueWatches\(\);[\s\S]{0,240}await auth\.signOut\(\)/.test(script), 'Logout must detach Firebase listeners before removing authentication');
assert(/globalPolls = \{\};\s*globalFoodRuns = \{\};\s*globalInstalled = \{\};\s*announcedPolls\.clear\(\)/.test(script), 'Logout must clear stale countdown and checklist data');
assert(/if \(leftSidebar\) leftSidebar\.style\.display = 'none'/.test(script), 'The hidden voting admin rail must not reserve space for players');
assert(/#view-voting-open \.add-game-btn\s*\{[\s\S]{0,120}position: static/.test(desktopCss), 'Voting add controls must sit in document flow below each priority');
assert(/const addButton = e\.target\.closest\('\.add-game-btn'\)/.test(script), 'Nested add-control content must preserve the click target');
assert(/className = 'user-roster-copy'/.test(script) && /À la table/.test(script), 'Desktop roster must use the name and presence space beside each avatar');
assert(/#view-voting-open #vote-form\s*\{[\s\S]{0,180}grid-template-columns: repeat\(2/.test(desktopCss), 'Voting ballot must use the ranked-card composition');
/* Une destination verrouillée l'est pour la table, pas pour l'admin : c'est
   hors soirée qu'on garnit la carte, qu'on écrit des défis et qu'on compose le
   set. Avant, seule la Collection y avait droit, par un bouton caché en CSS. */
assert(/const gamesUnlocked = phase === 'voting' \|\| phase === 'active' \|\| !!window\.currentUserIsAdmin/.test(script)
    && /const liveUnlocked = phase === 'active' \|\| !!window\.currentUserIsAdmin/.test(script),
    'Every LAN screen must stay open to the admin, whatever the phase');
assert(/let desktopPreviewSubview = ''/.test(script)
    && /desktopPreviewSubview && window\.currentUserIsAdmin && phase !== 'active'/.test(script),
    'The admin preview must remember which screen is open');
assert(!/tcgAdminPreview/.test(script) && !ids.includes('btn-tcg-preview'),
    'The Collection-only preview button must be gone: the rail opens it in every phase');
assert(/const adminPreview = phase !== 'active' && !votingProgramme && !!window\.currentUserIsAdmin/.test(script),
    'activateDesktopSubview must let the admin through outside the active LAN');
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
/* La déconnexion se dépliait au survol du bandeau : le mot apparaissait sous
   le curseur au moment où l'on visait son profil, et tout glissait vers la
   gauche. Une largeur fixe ne déplace rien. */
assert(/id="logout-btn"[\s\S]{0,400}<svg/.test(html) && /id="logout-btn"[\s\S]{0,400}class="sr-only"/.test(html),
    'Logout must be an icon with an accessible name, not a word that appears on hover');
assert(!/#top-right-actions:hover #logout-btn/.test(desktopCss)
    && /#top-right-actions #logout-btn \{[\s\S]{0,200}width: 40px;/.test(desktopCss),
    'The account bar must not reflow when the pointer enters it');
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
    && /<section class="pane" data-pane="bar"[\s\S]{0,900}id="kocktail-master-list"/.test(html),
    'Kocktails must live inside Les Fins Gourmets, behind its own tab');
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
for (const id of ['shop-feed', 'shop-leaderboard', 'shop-my-purchases', 'lan-titles', 'xp-board']) {
    assert(ids.includes(id), `Shop panel #${id} disappeared instead of getting a route`);
}
// Les hauts faits sont personnels : ils appartiennent à la Signature, pas à la
// boutique. Le badge verrouillé doit dire quoi faire, pas seulement « 1 / 7 ».
assert(!ids.includes('ach-list') && !/renderAchievements/.test(script),
    'Achievements belong to the profile: the shop must not list them a second time');
assert(/row\.ach\.hint\)\} · \$\{row\.current\} \/ \$\{row\.goal\}/.test(script),
    'A locked Signature badge must state what unlocks it, not just a ratio');
// Un volet fermé ne se construit pas : six panneaux se redessinaient à chaque
// mouvement de l'économie pour un DOM que personne ne regardait.
for (const fn of ['renderShopFeed', 'renderShopLeaderboard', 'renderLanTitlesPanel', 'renderXpBoard']) {
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
/* Posséder un jeu et l'avoir installé sont deux choses différentes : la
   checklist est déclarative, chacun ne coche que la sienne. Le nœud est neuf,
   donc les règles Firebase doivent voyager avec — une mise en ligne Vercel ne
   les publie pas, et sans elles la coche est refusée en silence. */
assert(/function renderWaitingInstall/.test(script)
    && /db\.ref\('lan\/installed\/' \+ user\.uid \+ '\/' \+ key\)/.test(script),
    'Readiness must be a personal declaration, not a guess from the Steam library');
assert(/"installed":\s*\{[\s\S]{0,700}"\$uid":\s*\{\s*"\.write":\s*"auth != null && \(\$uid === auth\.uid/.test(rules),
    'lan/installed must be writable only by its own player');
assert(/"\$game_key":\s*\{\s*"\.validate":\s*"!newData\.exists\(\) \|\| newData\.isBoolean\(\)"/.test(rules),
    'lan/installed entries must be booleans');
assert(/installed:\s*null/.test(core) && /newLanResetUpdates/.test(script),
    'A new LAN must start from an empty install checklist');
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
/* Deux portes du rail abritent plusieurs pièces. La barre secondaire ne doit
   montrer que celles de la porte ouverte, et aucune de ses étiquettes ne doit
   répéter un nom du rail — c'est ce qui rendait « Événements » illisible. */
assert(/id="desktop-subnav"/.test(html)
    && /soiree: \['lan-dashboard', 'lan-calendar', 'lan-polls'\]/.test(script)
    && /jeux: \['lan-games', 'lan-library'\]/.test(script),
    'Rooms behind a rail door need one shared group table');
const railLabels = [...html.matchAll(/desktop-nav__item[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(m => m[1].trim());
const subnavLabels = [...html.matchAll(/class="desktop-subnav__item"[^>]*data-desktop-target="[^"]*">([^<]+)/g)].map(m => m[1].trim());
for (const label of subnavLabels) {
    assert(!railLabels.includes(label), `Subnav entry "${label}" repeats a rail destination`);
}
assert(!/id="lan-events"/.test(html) && !/events-list/.test(html) && !/events-list/.test(script),
    'Programme is the single events screen: the flat card list must be gone');
assert(/item\.classList\.toggle\('is-locked', locked\)[\s\S]{0,120}item\.disabled = locked/.test(script),
    'Subnav destinations must lock, never disappear');

/* --- L'illustration d'une carte -------------------------------------------
   La jaquette se déduit de l'appId sans appel réseau, mais tous les appId n'ont
   pas de header.jpg : jeu retiré du magasin, DLC, entrée de bibliothèque sans
   fiche. Sans repli, ces cartes-là affichaient un cadre vide. L'escalier doit
   finir sur une data: URI, qui ne peut pas échouer à son tour et donc pas
   boucler. */
assert(/function armCardArtFallback\(imgEl, card\)/.test(script)
    && /imgEl\.addEventListener\('error'/.test(script),
    'A card cover that fails to load must fall back instead of leaving a hole');
assert(/imgEl\.dataset\.artStep = 'mirror'/.test(script)
    && /imgEl\.dataset\.artStep = 'search'/.test(script)
    && /imgEl\.dataset\.artStep = 'done';[\s\S]{0,80}imgEl\.src = DEFAULT_GAME_ICON;/.test(script),
    'The cover fallback must end on the inline icon so it cannot loop');
assert(/const DEFAULT_GAME_ICON = `data:image\/svg\+xml/.test(script),
    'The last fallback must be an inline image that cannot 404');

/* --- Les onglets internes -------------------------------------------------
   Un seul mécanisme pour la Boutique et Les Fins Gourmets : un onglet par
   pièce, un `hidden` sur le volet fermé. Chaque nom d'onglet doit avoir son
   panneau, sinon on retombe sur un écran sans route. */
const paneNames = [...html.matchAll(/data-pane="([a-z-]+)"/g)].map(match => match[1]);
for (const pane of ['carte', 'registre', 'table', 'bar']) {
    assert(paneNames.filter(name => name === pane).length === 2,
        `Pane "${pane}" needs both its tab and its panel`);
}
assert(/function activatePane\(rootId, name\)/.test(script)
    && /node\.hidden = node\.dataset\.pane !== name/.test(script),
    'A closed pane must be hidden by markup, not by another display:none');
assert(!/shop-pane|gourmet-section/.test(desktopCss) && !/data-shop-pane/.test(html),
    'The two tab mechanisms must have been merged into one');

/* --- Le tiroir du maître du jeu -------------------------------------------
   Créditer des points ou frapper le set ne concernent qu'une personne sur six.
   Ces postes vivent repliés dans l'écran qu'ils pilotent — pas en tête de
   page, et pas dans le panneau admin où l'on ne va pas en pleine soirée. */
for (const id of ['shop-gm-tools', 'tcg-gm-tools']) {
    assert(ids.includes(id), `Missing contextual gamemaster drawer #${id}`);
}
assert(/<details id="shop-gm-tools"[\s\S]{0,2600}id="shop-grant-panel"/.test(html),
    'Créditer des points belongs inside the shop drawer');
assert(/<details id="tcg-gm-tools"[\s\S]{0,900}id="tcg-gm-panel"/.test(html),
    'Le set de la soirée belongs inside the collection drawer');
assert(html.indexOf('id="shop-gm-tools"') < html.indexOf('id="shop-catalog"'),
    'The drawer is a single collapsed line: it may sit above the catalogue');
assert(!/shopTools\.open = true/.test(script),
    'The drawer must stay collapsed: opening it pushes the catalogue below the fold');

/* --- Le niveau de départ --------------------------------------------------
   Toutes les LAN n'ont pas été comptées ici. Le réglage ajoute le crédit qui
   manquait ; il n'efface jamais ce qui a été gagné, et les règles Firebase
   refusent de toute façon un delta négatif. */
for (const id of ['level-user-select', 'level-target', 'level-current', 'btn-set-level']) {
    assert(ids.includes(id), `Missing level adjustment control #${id}`);
}
assert(/function levelAdjustId\(uid\)[\s\S]{0,120}uid \+ '__adjust'/.test(script),
    'The starting credit must live at one deterministic key per player');
assert(/const credit = Math\.max\(0, xpForLevel\(wanted\) - earned\)/.test(script),
    'A starting credit may never be negative: earned experience is not taken back');
assert(rules.includes("newData.child('delta').val() >= 0"),
    'Firebase must keep refusing negative experience');
// Réécrire le crédit passe par le .write admin du nœud parent : la règle
// enfant est en création seule, et seul un admin peut donc le corriger.
assert(/"xp":\s*\{\s*"\.read"[^}]*"\.write":\s*"auth != null && \(root\.child\('lan\/roles'\)/.test(rules),
    'Only an admin may rewrite a starting credit');

/* --- Les sondages ---------------------------------------------------------
   Une option est une ligne de scrutin : nom à gauche, score aligné à droite.
   Le `float: right` décrochait dès que le libellé passait sur deux lignes. */
assert(/\.poll-option \{[\s\S]{0,400}display: grid;/.test(baseCss)
    && !/\.poll-option__score \{[\s\S]{0,200}float: right/.test(baseCss),
    'Poll options must be laid out as a grid, not floated');
assert(/\.polls-layout \{[\s\S]{0,200}display: grid;/.test(desktopCss)
    && !/#lan-polls\.active\s*\{[^}]*display:\s*grid\s*!important/.test(desktopCss),
    'The polls layout must sit on an inner container instead of fighting the inline display');

/* --- La console d'administration ------------------------------------------
   Huit cartes de même facture dans une seule grille. Trois flottaient dans la
   grille et le reste s'empilait en pleine largeur dessous. */
const adminCards = (html.match(/class="admin-control-item/g) || []).length;
assert(adminCards >= 8, `The admin console should be one grid of cards (found ${adminCards})`);
assert(/#view-admin-dashboard \.admin-control-item \.section-title \{[\s\S]{0,300}text-transform: uppercase;/.test(desktopCss),
    'Admin card titles must be quiet labels, not centred display type');

/* --- La liste de départ des défis -----------------------------------------
   Trente-sept défis livrés avec l'application, et deux façons de les poser :
   le bouton de l'état vide, et le complément en bas de liste une fois le
   catalogue garni. Regarnir deux fois ne doit jamais créer de doublon. */
assert(/const CHALLENGE_STARTER = \[/.test(core)
    && (core.match(/\{ title: '/g) || []).length >= 30,
    'The starter challenge list must ship with the app');
assert(/window\.currentUserIsGamemaster\s*\?\s*missingStarterChallenges\(globalQuests\)\.length : 0/.test(script)
    && /Ajouter ou actualiser \$\{missing\} défis de la liste de départ/.test(script),
    'A gamemaster must be able to top the starter list up once the catalogue is no longer empty');
assert(/function missingStarterChallenges/.test(core)
    && /have\[normalizeGameName\(c\.title\)\]/.test(core),
    'Seeding twice must not duplicate the starter list');
// Une réclamation appartient à la soirée où elle a été faite : la file « à
// valider » traînait sinon d'une LAN à l'autre, pastille de rail comprise.
assert(/claims:\s*null/.test(core) && /newLanResetUpdates/.test(script),
    'A new LAN must start from an empty claims queue');

/* ==========================================================================
   LES RÈGLES FIREBASE DOIVENT ÊTRE LISIBLES PAR FIREBASE
   Une clé sans point n'est pas un commentaire : Firebase la lit comme un
   chemin enfant et attend un objet derrière. Un `"//": "…"` bien intentionné
   fait échouer toute la publication sur un « Expected '{' », et le fichier
   reste pourtant du JSON parfaitement valide — donc rien ne le signale.
   ========================================================================== */

const ruleTree = JSON.parse(rules).rules;
const RULE_KEYWORDS = new Set(['.read', '.write', '.validate', '.indexOn', '.priority']);
(function walkRules(node, path) {
    assert(node && typeof node === 'object' && !Array.isArray(node),
        `Firebase rules: ${path || '/'} must be an object`);
    for (const [key, value] of Object.entries(node)) {
        if (RULE_KEYWORDS.has(key)) continue;
        assert(!key.startsWith('.'), `Firebase rules: unknown keyword ${path}/${key}`);
        walkRules(value, `${path}/${key}`);
    }
}(ruleTree, ''));

/* --- Les notifications ----------------------------------------------------
   `senderId` était facultatif : une notif sans expéditeur passait, et
   « L'admin a annulé la LAN » n'était attribuable à personne. */
const notif = ruleTree.lan.notifications.$uid.$notif_id;
assert(notif['.write'].includes("$notif_id.beginsWith(auth.uid + '__')"),
    'A notification key must carry its real sender');
assert(notif['.validate'].includes("newData.hasChild('senderId')"),
    'A new notification must name its sender');
assert(/user\.uid \+ '__' \+ db\.ref\(\)\.push\(\)\.key/.test(script),
    'The desktop client must prefix notification keys with the sender uid');
/* Pas de liste blanche : c'est un risque accepté (voir le dossier EBIOS RM,
   fiche R1). Tout compte Google connecté est donc un joueur — d'où
   l'importance des .validate ci-dessus, qui sont la seule limite restante. */

/* --- Le scrutin -----------------------------------------------------------
   Une priorité écrite à la main (chaîne, ou clés arbitraires) revenait sous une
   forme sans .forEach : l'exception cassait le rendu chez TOUS les joueurs. */
for (const p of ['p1', 'p2', 'p3', 'p_other']) {
    const node = ruleTree.lan.votes.$user_id.votes[p];
    assert(node['.validate'].includes('newData.hasChildren()'),
        'lan/votes .../' + p + ' must be a list, never a bare value');
    const keyRule = node.$g['.validate'];
    if (p === 'p1') {
        assert(keyRule.includes('$g.matches(/^0$/)'),
            'lan/votes p1 must allow exactly one first choice');
    } else {
        assert(keyRule.includes('$g.matches(/^[0-9]{1,2}$/)'),
            'lan/votes .../' + p + ' must keep numeric keys, which also caps the ballot');
    }
}
assert(/const voteList = /.test(core) && /Array\.isArray\(value\)/.test(core),
    'calculateScores must normalise a priority before iterating it');

for (const id of ['view-no-lan', 'view-voting-open', 'view-waiting-closed', 'view-lan-active', 'view-lan-finished']) {
    assert(ids.includes(id), `Missing desktop phase view #${id}`);
}

console.log(`Desktop shell checks passed (${ids.length} unique IDs, ${navTargets.length} navigation targets).`);
