// normalizeGameName, escapeHtml, levenshtein, checkTypos et calculateScores
// vivent désormais dans core.js, partagé avec l'interface téléphone.

/* Les interfaces suivent à nouveau l'appareil sans choix persistant. Effacer
   l'ancien cookie répare les téléphones qui avaient forcé la vue bureau. */
document.cookie = 'lan_vue=; path=/; max-age=0; samesite=lax';

function animateCounter(element, target) {
    if (element.animationFrameId) cancelAnimationFrame(element.animationFrameId);
    const startValue = parseInt(element.textContent) || 0;
    if (startValue === target) {
        element.textContent = target;
        return;
    }
    const duration = 1000;
    let startTime = null;
    function animationStep(timestamp) {
        if (!startTime) startTime = timestamp;
        const progress = timestamp - startTime;
        const currentVal = progress < duration ? startValue + Math.floor(progress / duration * (target - startValue)) : target;
        element.textContent = currentVal;
        if (progress < duration) element.animationFrameId = requestAnimationFrame(animationStep);
    }
    element.animationFrameId = requestAnimationFrame(animationStep);
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 4000);
}

/* Firebase accepte un second callback sur .on(), appelé quand la lecture
   échoue : règle refusée, jeton expiré, transport bloqué. Aucun listener n'en
   passait, si bien qu'un échec était parfaitement muet — l'écran restait vide
   et rien n'indiquait pourquoi. C'est ce qui a laissé l'application morte sur
   certains navigateurs sans que personne puisse la diagnostiquer. */
const reportedDbErrors = new Set();
const activeValueWatches = [];
let connectionWatchTimer = null;

function watchValue(ref, handler) {
    const onError = (error) => {
        const path = String(ref);
        console.error('Lecture Firebase refusée :', path, error);
        // Une déconnexion retire le jeton avant que Firebase ait fini de vider
        // sa file. Ces refus sont attendus et ne concernent plus l'utilisateur.
        if (!auth.currentUser) return;
        // Un seul message par type d'erreur : une coupure fait échouer les
        // douze listeners d'un coup, et douze toasts identiques n'apprennent
        // rien de plus que le premier.
        const errorKey = error.code || 'database-error';
        if (reportedDbErrors.has(errorKey)) return;
        reportedDbErrors.add(errorKey);
        showToast(`Base de données inaccessible (${error.code || 'erreur'}).`, 'error');
    };
    ref.on('value', handler, onError);
    activeValueWatches.push({ ref, handler });
    return ref;
}

function stopValueWatches() {
    activeValueWatches.splice(0).forEach(({ ref, handler }) => ref.off('value', handler));
    reportedDbErrors.clear();
    if (connectionWatchTimer) clearTimeout(connectionWatchTimer);
    connectionWatchTimer = null;
}

/* Un transport bloqué (extension, CSP, pare-feu) ne déclenche aucune erreur :
   la connexion reste simplement en attente et l'application semble vide sans
   raison. Au bout de dix secondes sans connexion, on le dit. */
function watchConnection(connectedRef, isConnected) {
    let announced = false;
    if (connectionWatchTimer) clearTimeout(connectionWatchTimer);
    connectionWatchTimer = setTimeout(() => {
        if (announced || isConnected()) return;
        announced = true;
        console.error('Aucune connexion à la Realtime Database après 10 s.');
        showToast("Connexion à la base impossible. Un bloqueur de contenu ou le mode strict du navigateur peut en être la cause.", 'error');
    }, 10000);
    return connectedRef;
}

// --- INITIALISATION ---
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();
const googleProvider = new firebase.auth.GoogleAuthProvider();

document.addEventListener('DOMContentLoaded', () => {
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const googleLoginBtn = document.getElementById('google-login-btn');
    const loginBtnText = document.getElementById('login-btn-text');
    const loginSpinner = document.getElementById('login-spinner');
    const authErrorP = document.getElementById('auth-error');
    const logoutBtn = document.getElementById('logout-btn');
    const userNameSpan = document.getElementById('user-name');
    const userAvatarImg = document.getElementById('user-avatar');

    let votesRef = null;
    let settingsRef = null;
    let eventsRef = null;
    let cocktailsRef = null;
    let notificationsRef = null;

    let globalVotes = {};
    let globalSettings = { isVotingOpen: true, topGamesCount: 10, isLanActive: false };
    // L'économie de la soirée : carte de la boutique, registre, compteurs de
    // présence et demandes d'achat. Aucun solde n'y est stocké, il se recalcule.
    let globalEconomy = {};
    // Le set, les paquets scellés et le journal des échanges. Aucune
    // collection n'y est stockée : elle se rejoue depuis les paquets ouverts.
    let globalTcg = {};
    /* Expérience et hauts faits. Ce nœud survit à la clôture : c'est ce qui
       distingue l'assiduité de la fortune. */
    let globalXp = {};
    /* Défis, réclamations et boîte à idées. Un défi ne se calcule pas : c'est
       un humain qui tranche, et c'est la seule source d'XP qui se rejoue. */
    let globalQuests = { challenges: {}, claims: {}, suggestions: {} };
    /* Les soirées passées, pour compter les LAN de chacun. */
    let globalHistory = {};
    let globalUsers = {};
    let globalRoles = {};
    // Fiches durables (nom + avatar). /status disparaît à la déconnexion : sans
    // ce miroir, un joueur qui a voté puis fermé l'onglet n'avait plus de photo.
    let globalProfiles = {};
    let openProfileUid = null;
    let openProfileName = '';
    let profileDraft = null;
    // Notre entrée dans /status : une par session, pas une par joueur.
    let myConnectionRef = null;
    let myConnectionKey = null;
    let firebaseConnected = false;
    let appInitialized = false;
    let isEditing = false;
    let agendaMinuteTimer = null;
    let tickTimer = null;
    const imageCache = new Map();

    /* ======================================================================
       DESKTOP OS

       The desktop now has one stable shell for every LAN phase. The feature
       panels below remain the source of truth: global navigation activates
       their existing hidden nav items, so Firebase writes and permissions are
       not duplicated in a second implementation.
       ====================================================================== */

    let desktopAdminOverride = false;
    let desktopVotingDestination = 'games';

    /* Long desktop catalogues need motion where the eye is, not only when the
       tab opens. Items are observed once and revealed in short waves as they
       enter the scroll viewport. A mutation observer catches Firebase renders
       and filter changes without coupling the effect to every renderer. */
    const DESKTOP_SCROLL_MOTION_SELECTOR = [
        '#shop-catalog .shop-cat-title',
        '#shop-catalog .shop-item',
        '#challenge-list .shop-item',
        '#tcg-set-grid .rarity-bar',
        '#tcg-set-grid .tcard',
        '#tcg-dupes .tcard',
        '#vote-history-podium .vote-history-podium__card',
        '#active-lan-all-games .vote-history-row'
    ].join(', ');
    let desktopRevealObserver = null;
    let desktopMotionRefreshFrame = 0;
    let desktopScrollProgressFrame = 0;

    function desktopMotionIsReduced() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function desktopRevealItems(scope) {
        if (!scope) return;
        const candidates = [];
        if (scope.matches && scope.matches(DESKTOP_SCROLL_MOTION_SELECTOR)) candidates.push(scope);
        if (scope.querySelectorAll) candidates.push(...scope.querySelectorAll(DESKTOP_SCROLL_MOTION_SELECTOR));
        const fresh = candidates.filter(item => !item.classList.contains('desktop-scroll-item'));
        if (!fresh.length) return;

        if (!desktopRevealObserver && 'IntersectionObserver' in window && !desktopMotionIsReduced()) {
            desktopRevealObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    entry.target.classList.add('is-scroll-revealed');
                    observer.unobserve(entry.target);
                });
            }, { root: null, rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
        }

        fresh.forEach((item, index) => {
            item.classList.add('desktop-scroll-item');
            item.style.setProperty('--desktop-reveal-delay', `${(index % 6) * 42}ms`);
            if (desktopMotionIsReduced() || !desktopRevealObserver) item.classList.add('is-scroll-revealed');
            else desktopRevealObserver.observe(item);
        });
    }

    function updateDesktopScrollProgress() {
        desktopScrollProgressFrame = 0;
        const stage = document.querySelector('.desktop-stage');
        if (!stage) return;
        const root = [...stage.children].find(child => child.offsetParent !== null && child.scrollHeight > child.clientHeight + 2);
        const max = root ? root.scrollHeight - root.clientHeight : 0;
        const progress = max > 0 ? Math.min(1, Math.max(0, root.scrollTop / max)) : 0;
        stage.style.setProperty('--desktop-scroll-progress', progress.toFixed(4));
        stage.classList.toggle('is-scrollable', max > 0);
    }

    function scheduleDesktopMotionRefresh() {
        if (desktopMotionRefreshFrame) return;
        desktopMotionRefreshFrame = requestAnimationFrame(() => {
            desktopMotionRefreshFrame = 0;
            desktopRevealItems(document.getElementById('view-lan-active'));
            updateDesktopScrollProgress();
        });
    }

    function scheduleDesktopScrollProgress() {
        if (desktopScrollProgressFrame) return;
        desktopScrollProgressFrame = requestAnimationFrame(updateDesktopScrollProgress);
    }

    function setupDesktopScrollMotion() {
        const stage = document.querySelector('.desktop-stage');
        const activeView = document.getElementById('view-lan-active');
        if (!stage || !activeView) return;

        [...stage.children].forEach(root => root.addEventListener('scroll', scheduleDesktopScrollProgress, { passive: true }));
        window.addEventListener('resize', scheduleDesktopScrollProgress, { passive: true });
        new MutationObserver(scheduleDesktopMotionRefresh).observe(activeView, { childList: true, subtree: true });
        scheduleDesktopMotionRefresh();
    }

    function desktopPhase() {
        if (globalSettings.lanFinished && !globalSettings.isLanActive) return 'finished';
        if (globalSettings.isLanActive) return 'active';

        const hasVotes = Object.keys(globalVotes || {}).length > 0;
        const hasAnnouncement = !!(globalSettings.lanDate || globalSettings.lanPlace);
        if (!hasAnnouncement && !hasVotes) return 'idle';
        return globalSettings.isVotingOpen ? 'voting' : 'locked';
    }

    function desktopData() {
        return {
            economy: globalEconomy,
            tcg: globalTcg,
            cards: tcgCards(globalTcg),
            xp: globalXp,
            history: globalHistory,
            votes: globalVotes,
            settings: globalSettings,
            quests: globalQuests,
            profiles: globalProfiles,
            roles: globalRoles,
            adminUid: ADMIN_UID
        };
    }

    function desktopLatestHistory() {
        return Object.values(globalHistory || {})
            .filter(Boolean)
            .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))[0] || null;
    }

    function desktopProfile() {
        const user = auth.currentUser;
        if (!user) return null;
        return playerProfile(desktopData(), user.uid);
    }

    function renderDesktopIdle() {
        const user = auth.currentUser;
        if (!user) return;

        const history = desktopLatestHistory();
        const profile = desktopProfile();
        const subtitle = document.getElementById('desktop-idle-subtitle');
        const podium = document.getElementById('desktop-last-podium');
        const setName = document.getElementById('desktop-last-set');
        const setCopy = document.getElementById('desktop-last-set-copy');

        if (subtitle) {
            subtitle.textContent = history
                ? `La dernière, « ${history.name || 'LAN Demain'} », s’est terminée le ${history.date || 'dernier'}. Tout le reste a été archivé.`
                : 'Le premier vote ouvrira la prochaine histoire du groupe.';
        }

        if (podium) {
            podium.innerHTML = '';
            const games = history && Array.isArray(history.topGames) ? history.topGames.slice(0, 3) : [];
            if (!games.length) {
                podium.innerHTML = '<p class="panel-section__hint">Aucun podium archivé pour le moment.</p>';
            } else {
                games.forEach((game, index) => {
                    const row = document.createElement('div');
                    row.className = 'desktop-mini-list__row';
                    const rank = document.createElement('i');
                    rank.textContent = String(index + 1);
                    const name = document.createElement('span');
                    name.textContent = game.name || 'Jeu sans nom';
                    const score = document.createElement('small');
                    score.textContent = `${Number(game.score) || 0} pts`;
                    row.append(rank, name, score);
                    podium.appendChild(row);
                });
            }
        }

        const archivedSet = history && history.tcgStandings;
        if (setName) setName.textContent = archivedSet?.setName || 'Aucun set archivé';
        if (setCopy) {
            const mine = archivedSet && Array.isArray(archivedSet.standings)
                ? archivedSet.standings.find(row => row.name === playerLabel(user.uid))
                : null;
            setCopy.textContent = mine
                ? `${mine.owned} cartes sur ${mine.total}, dont ${mine.foils || 0} brillante(s).`
                : 'Les cartes de la prochaine soirée naîtront du vote.';
        }

        if (profile) {
            const title = document.getElementById('desktop-player-title');
            const titleCopy = document.getElementById('desktop-player-title-copy');
            const level = document.getElementById('desktop-idle-level');
            const achievements = document.getElementById('desktop-idle-achievements');
            const xpCopy = document.getElementById('desktop-idle-xp-copy');
            if (title) title.textContent = profile.nickname || levelTitle(profile.level.level);
            if (titleCopy) {
                titleCopy.textContent = profile.nickname
                    ? `${playerFullName(user.displayName || user.email || 'Joueur', profile.nickname)} — un titre gagné, jamais choisi.`
                    : `Encore ${profile.level.toNext} XP avant le niveau ${profile.level.level + 1}.`;
            }
            if (level) level.textContent = String(profile.level.level);
            if (achievements) achievements.textContent = `${profile.achievementCount} / ${profile.achievementTotal}`;
            if (xpCopy) {
                xpCopy.textContent = `${profile.level.total} XP au total · ${levelTitle(profile.level.level)}. Le solde, lui, repart à zéro avec la soirée.`;
            }
        }

        const panel = document.getElementById('desktop-announce-panel');
        if (panel) panel.style.display = window.currentUserIsAdmin ? 'block' : 'none';
    }

    function desktopPendingCount() {
        let count = 0;
        if (window.currentUserIsGamemaster) {
            count += pendingPurchases(globalEconomy).length;
            count += Object.values(globalQuests.claims || {}).filter(item => item && item.status === 'pending').length;
            count += Object.values(globalQuests.challenges || {}).filter(item => item && item.status === 'pending').length;
        }
        return count;
    }

    function renderDesktopShell() {
        const user = auth.currentUser;
        if (!user) return;

        const phase = desktopPhase();
        const schedule = describeLanSchedule(globalSettings, new Date());
        const meta = document.getElementById('desktop-lan-meta');
        if (meta) {
            const details = schedule
                ? [schedule.when, schedule.time && `à ${schedule.time}`, schedule.place && `chez ${schedule.place}`].filter(Boolean).join(' · ')
                : '';
            meta.textContent = details || (phase === 'idle' ? 'AUCUNE DATE ANNONCÉE' : (globalSettings.lanName || 'LAN À VENIR'));
        }

        const profile = desktopProfile();
        const level = profile ? profile.level : xpLevel(0);
        const levelValue = document.getElementById('desktop-level-value');
        if (levelValue) levelValue.textContent = String(level.level);
        const bars = document.getElementById('desktop-level-bars');
        if (bars) {
            const filled = Math.max(0, Math.min(10, Math.round(level.ratio * 10)));
            bars.innerHTML = Array.from({ length: 10 }, (_, index) =>
                `<i class="${index < filled ? 'is-filled' : ''}"></i>`).join('');
        }

        const wallet = document.getElementById('desktop-wallet-value');
        if (wallet) {
            wallet.textContent = formatPoints(economyBalance(globalEconomy, user.uid));
            wallet.style.display = phase === 'idle' ? 'none' : 'block';
        }

        /* Verrouillé pour la table, ouvert pour l'admin : c'est hors soirée
           qu'on prépare la soirée. */
        const liveUnlocked = phase === 'active' || !!window.currentUserIsAdmin;
        document.querySelectorAll('[data-live-only]').forEach(item => {
            item.classList.toggle('is-locked', !liveUnlocked);
            item.disabled = !liveUnlocked;
            item.setAttribute('aria-disabled', String(!liveUnlocked));
        });

        // Jeux désigne le bulletin pendant le vote, puis l'historique pendant
        // la soirée. Entre deux LAN et après la clôture, il n'y a plus d'action
        // possible : le laisser cliquable promettait une page qui ne s'ouvrait pas.
        const gamesNav = document.querySelector('.desktop-nav__item[data-desktop-destination="games"]');
        const gamesUnlocked = phase === 'voting' || phase === 'active' || !!window.currentUserIsAdmin;
        if (gamesNav) {
            gamesNav.classList.toggle('is-locked', !gamesUnlocked);
            gamesNav.disabled = !gamesUnlocked;
            gamesNav.setAttribute('aria-disabled', String(!gamesUnlocked));
        }

        const challengeBadge = document.getElementById('desktop-challenge-badge');
        const challengeCount = window.currentUserIsGamemaster
            ? Object.values(globalQuests.claims || {}).filter(item => item && item.status === 'pending').length
            : Object.values(globalQuests.claims || {}).filter(item => item && item.uid === user.uid && item.status === 'pending').length;
        if (challengeBadge) challengeBadge.textContent = challengeCount ? String(challengeCount) : '';

        const collectionBadge = document.getElementById('desktop-collection-badge');
        const collectionCount = sealedPacksOf(globalTcg, user.uid).length + pendingTradesFor(globalTcg, user.uid).length;
        if (collectionBadge) collectionBadge.textContent = collectionCount ? String(collectionCount) : '';

        const admin = document.getElementById('desktop-admin-nav');
        if (admin) admin.style.display = window.currentUserIsAdmin ? 'grid' : 'none';
        const adminBadge = document.getElementById('desktop-admin-badge');
        const waiting = desktopPendingCount();
        if (adminBadge) adminBadge.textContent = waiting ? String(waiting) : '';

        renderDesktopIdle();
        syncDesktopNavigation();
    }

    /* Deux portes du rail ouvrent sur plusieurs pièces. Les groupes sont
       listés ici plutôt que dispersés : c'est cette table qui décide à la fois
       du surlignage du rail et du contenu de la barre secondaire. */
    const DESKTOP_GROUPS = {
        soiree: ['lan-dashboard', 'lan-calendar', 'lan-polls'],
        jeux: ['lan-games', 'lan-library']
    };

    function desktopGroupOf(subviewId) {
        return Object.keys(DESKTOP_GROUPS).find(name => DESKTOP_GROUPS[name].includes(subviewId)) || '';
    }

    function syncDesktopNavigation(targetId) {
        const phase = desktopPhase();
        const currentSubview = targetId || document.querySelector('#view-lan-active .lan-subview.active')?.id || '';
        const adminActive = !!desktopAdminOverride || currentSubview === 'lan-admin';
        document.querySelectorAll('.desktop-nav__item').forEach(item => {
            let active = false;
            if (item.dataset.desktopTarget) active = currentSubview === item.dataset.desktopTarget;
            if (item.dataset.desktopDestination === 'home') {
                active = !adminActive && (phase === 'active'
                    ? desktopGroupOf(currentSubview) === 'soiree'
                    : (phase === 'voting' ? desktopVotingDestination === 'events' : true));
            }
            if (item.dataset.desktopDestination === 'games') {
                active = !adminActive && ((phase === 'voting' && desktopVotingDestination === 'games')
                    || (phase === 'active' && desktopGroupOf(currentSubview) === 'jeux'));
            }
            // L'historique est une fenêtre, pas une destination : il ne
            // s'allume jamais, sinon le rail mentirait sur l'écran ouvert.
            if (item.dataset.desktopDestination === 'history') active = false;
            if (item.disabled || item.classList.contains('is-locked')) active = false;
            item.classList.toggle('active', active);
        });
        document.getElementById('desktop-admin-nav')?.classList.toggle('active', adminActive);
        syncDesktopSubnav(currentSubview, adminActive);
    }

    /* La barre secondaire ne montre que les pièces de la porte ouverte :
       proposer celles d'une autre destination serait un retour vers un endroit
       où l'on n'est pas. */
    function syncDesktopSubnav(currentSubview, adminActive) {
        const subnav = document.getElementById('desktop-subnav');
        if (!subnav) return;
        const group = adminActive ? '' : desktopGroupOf(currentSubview);
        subnav.style.display = group ? 'flex' : 'none';
        // Pendant le vote, seul le Programme existe : les autres se verrouillent
        // au lieu de disparaître, comme le rail au-dessus.
        const live = desktopPhase() === 'active' || !!window.currentUserIsAdmin;
        subnav.querySelectorAll('.desktop-subnav__item').forEach(item => {
            const mine = item.dataset.desktopGroup === group;
            item.hidden = !mine;
            const locked = !live && item.dataset.desktopTarget !== 'lan-calendar';
            item.classList.toggle('is-locked', locked);
            item.disabled = locked;
            item.setAttribute('aria-disabled', String(locked));
            item.classList.toggle('active', mine && !locked && item.dataset.desktopTarget === currentSubview);
        });
        const pollBadge = document.getElementById('desktop-subnav-poll-badge');
        if (pollBadge) {
            const open = Object.values(globalPolls || {}).filter(poll => poll && !isPollClosed(poll)).length;
            pollBadge.textContent = open ? String(open) : '';
        }
    }

    function activateDesktopSubview(targetId) {
        const phase = desktopPhase();
        const votingProgramme = phase === 'voting' && targetId === 'lan-calendar';
        const adminPreview = phase !== 'active' && !votingProgramme && !!window.currentUserIsAdmin;
        if (phase !== 'active' && !votingProgramme && !adminPreview) return;
        if (votingProgramme) desktopVotingDestination = 'events';
        desktopAdminOverride = false;
        // Hors soirée, l'admin visite : la phase reste ce qu'elle est, seul
        // l'écran change. updateVotingUIState() se charge d'afficher la coque
        // de LAN active autour.
        desktopPreviewSubview = adminPreview ? targetId : '';
        if (adminPreview) {
            updateVotingUIState();
            if (targetId === 'lan-tcg') renderCollection();
            return;
        }
        const activeView = document.getElementById('view-lan-active');
        if (activeView) activeView.scrollTop = 0;
        const legacy = document.querySelector(`.lan-nav-list .nav-item[data-target="${targetId}"]`);
        if (legacy) legacy.click();
        syncDesktopNavigation(targetId);
        scheduleDesktopMotionRefresh();
    }

    function setupDesktopShell() {
        setupPanes();
        document.querySelectorAll('#desktop-subnav .desktop-subnav__item').forEach(item => {
            item.addEventListener('click', () => activateDesktopSubview(item.dataset.desktopTarget));
        });

        document.querySelectorAll('.desktop-nav__item, .desktop-brand').forEach(item => {
            item.addEventListener('click', () => {
                if (item.disabled || item.classList.contains('is-locked')) return;
                const destination = item.dataset.desktopDestination;
                const target = item.dataset.desktopTarget;
                // L'historique s'ouvre par-dessus l'écran courant : il ne
                // touche ni à la phase, ni au surlignage du rail.
                if (destination === 'history') {
                    openLanHistory();
                    return;
                }
                if (target) {
                    activateDesktopSubview(target);
                    return;
                }
                desktopAdminOverride = false;
                desktopPreviewSubview = '';
                const phase = desktopPhase();
                if (phase === 'voting' && destination === 'home') {
                    desktopVotingDestination = 'events';
                    updateVotingUIState();
                    return;
                }
                if (phase === 'voting' && destination === 'games') {
                    desktopVotingDestination = 'games';
                    updateVotingUIState();
                    return;
                }
                updateVotingUIState();
                if (destination === 'home' && phase === 'active') activateDesktopSubview('lan-dashboard');
                if (destination === 'games' && phase === 'active') {
                    // On rouvre la dernière pièce visitée de cet espace plutôt
                    // que de toujours retomber sur l'historique.
                    const current = document.querySelector('#view-lan-active .lan-subview.active')?.id;
                    activateDesktopSubview(desktopGroupOf(current) === 'jeux' ? current : 'lan-games');
                }
                syncDesktopNavigation();
            });
        });

        document.getElementById('desktop-admin-nav')?.addEventListener('click', () => {
            if (!window.currentUserIsAdmin) return;
            if (desktopPhase() === 'active') {
                activateDesktopSubview('lan-admin');
                return;
            }
            desktopAdminOverride = true;
            desktopPreviewSubview = '';
            updateVotingUIState();
            syncDesktopNavigation('lan-admin');
        });

        document.getElementById('desktop-open-history')?.addEventListener('click', openLanHistory);

        // Les raccourcis du tableau de bord partagent l'aiguillage du rail :
        // un seul chemin vers un sous-écran, quel que soit le bouton cliqué.
        document.querySelectorAll('#lan-dashboard [data-desktop-target]').forEach(item => {
            item.addEventListener('click', () => activateDesktopSubview(item.dataset.desktopTarget));
        });

        const openOwnProfile = () => {
            const user = auth.currentUser;
            if (user) showPlayerVotesModal(user.uid, user.displayName || user.email || 'Joueur', globalVotes);
        };
        const userInfoMenu = document.getElementById('user-info-menu');
        userInfoMenu?.addEventListener('click', openOwnProfile);
        userInfoMenu?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openOwnProfile();
        });

        document.getElementById('desktop-announce-submit')?.addEventListener('click', async () => {
            if (!window.currentUserIsAdmin) return;
            const date = document.getElementById('desktop-announce-date')?.value || '';
            const time = document.getElementById('desktop-announce-time')?.value || '';
            const place = document.getElementById('desktop-announce-place')?.value.trim() || '';
            if (!date) {
                showToast('Choisis au moins une date pour annoncer la LAN.', 'error');
                return;
            }
            const button = document.getElementById('desktop-announce-submit');
            if (button) button.disabled = true;
            try {
                await db.ref('lan/settings').update({
                    lanDate: date,
                    lanStartTime: time,
                    lanPlace: place,
                    isVotingOpen: true,
                    isLanActive: false,
                    lanFinished: false
                });
                showToast('La prochaine LAN est annoncée, les votes sont ouverts.', 'success');
            } catch (error) {
                showToast('Impossible d’annoncer la LAN : ' + error.message, 'error');
            } finally {
                if (button) button.disabled = false;
            }
        });
    }

    setupDesktopShell();
    setupDesktopScrollMotion();
    const DEFAULT_GAME_ICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23666'%3E%3Cpath d='M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-2.5 14H6.5v-1.5h11V18zm0-2.5H6.5v-1.5h11V15.5zm0-2.5H6.5v-1.5h11V13zm-5-3.25L10.25 8h1.5l2.25 1.75V8h1.5v6h-1.5v-1.75L13.25 14h-1.5L9.5 12.25V14H8V8h1.5v1.75z'/%3E%3C/svg%3E`;

    const voteForm = document.getElementById('vote-form');
    const voterSelectMenu = document.getElementById('voter-select-menu');
    const correctionModal = document.getElementById('correction-modal');

    auth.onAuthStateChanged(user => {
        if (user) {
            stopValueWatches();
            if (agendaMinuteTimer) clearInterval(agendaMinuteTimer);
            document.body.classList.add('desktop-authenticated');
            authContainer.style.display = 'none';
            appContainer.style.display = 'block';
            userNameSpan.textContent = user.displayName || user.email;
            userAvatarImg.src = user.photoURL || '';
            initializeApp(user);
        } else {
            stopValueWatches();
            if (agendaMinuteTimer) clearInterval(agendaMinuteTimer);
            agendaMinuteTimer = null;
            if (tickTimer) clearInterval(tickTimer);
            tickTimer = null;
            globalPolls = {};
            globalFoodRuns = {};
            globalInstalled = {};
            announcedPolls.clear();
            firebaseConnected = false;
            appInitialized = false;
            document.body.classList.remove('desktop-authenticated');
            authContainer.style.display = 'block';
            appContainer.style.display = 'none';
        }
    });

    googleLoginBtn.addEventListener('click', () => {
        authErrorP.textContent = '';
        googleLoginBtn.disabled = true;
        loginBtnText.style.display = 'none';
        loginSpinner.style.display = 'block';

        auth.signInWithPopup(googleProvider)
            .catch(error => {
                authErrorP.textContent = error.message;
            })
            .finally(() => {
                googleLoginBtn.disabled = false;
                loginBtnText.style.display = 'inline-block';
                loginSpinner.style.display = 'none';
            });
    });

    logoutBtn.addEventListener('click', async () => {
        const user = auth.currentUser;
        logoutBtn.disabled = true;
        // On ne retire que cette session : le téléphone du même joueur, s'il est
        // ouvert, reste connecté.
        try {
            if (myConnectionRef) {
                await myConnectionRef.remove();
                myConnectionRef = null;
            } else if (user) {
                await db.ref('/status/' + user.uid).remove();
            }
        } catch (error) {
            console.debug('Présence déjà retirée :', error);
        } finally {
            stopValueWatches();
            const toastContainer = document.getElementById('toast-container');
            if (toastContainer) toastContainer.innerHTML = '';
            await auth.signOut();
            logoutBtn.disabled = false;
        }
    });

    // Vérifie qu'une URL d'image se charge vraiment : le CDN Steam renvoie parfois
    // une URL valide en apparence mais introuvable (404), d'où la vignette cassée.
    function imageLoads(url) {
        return new Promise(resolve => {
            const probe = new Image();
            probe.onload = () => resolve(true);
            probe.onerror = () => resolve(false);
            probe.src = url;
        });
    }

    // v2 : l'endpoint exige désormais une correspondance exacte. Le paramètre
    // change la clé de cache du CDN, sinon les anciennes vignettes erronées
    // (Ruined King pour LoL) resteraient servies jusqu'à 24 h.
    const IMAGE_API_VERSION = '2';

    // Le cache mémoire disparaît à chaque rechargement : sans persistance, la
    // page refait un aller-retour API par jeu et les vignettes clignotent.
    // On garde donc les URL résolues dans localStorage.
    const IMAGE_STORE_KEY = 'lan-demain:thumbs:v2';
    const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    function loadImageStore() {
        try {
            const raw = localStorage.getItem(IMAGE_STORE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            const now = Date.now();
            Object.entries(data).forEach(([name, entry]) => {
                if (entry && entry.url && (now - entry.ts) < IMAGE_TTL_MS) {
                    imageCache.set(name, entry.url);
                }
            });
        } catch (error) {
            // localStorage indisponible (navigation privée, quota) : on continue sans
            console.debug('Cache vignettes illisible:', error);
        }
    }

    let imageStoreTimer = null;
    function persistImageStore() {
        // Regroupé : 20 vignettes résolues ne doivent pas écrire 20 fois
        clearTimeout(imageStoreTimer);
        imageStoreTimer = setTimeout(() => {
            try {
                const now = Date.now();
                const data = {};
                imageCache.forEach((url, name) => {
                    if (typeof url === 'string' && url !== DEFAULT_GAME_ICON) {
                        data[name] = { url, ts: now };
                    }
                });
                localStorage.setItem(IMAGE_STORE_KEY, JSON.stringify(data));
            } catch (error) {
                console.debug('Cache vignettes non enregistré:', error);
            }
        }, 500);
    }

    // Jeux introuvables chez Steam et Wikipédia. Mémorisés brièvement : un jeu
    // peut sortir sur Steam, ou une faute de frappe être corrigée.
    const MISSING_STORE_KEY = 'lan-demain:thumbs-missing:v1';
    const MISSING_TTL_MS = 24 * 60 * 60 * 1000;
    let missingImages = {};

    function loadMissingStore() {
        try {
            const raw = localStorage.getItem(MISSING_STORE_KEY);
            const data = raw ? JSON.parse(raw) : {};
            const now = Date.now();
            Object.entries(data).forEach(([name, ts]) => {
                if ((now - ts) < MISSING_TTL_MS) missingImages[name] = ts;
            });
        } catch (error) {
            console.debug('Cache des absences illisible:', error);
        }
    }

    let missingStoreTimer = null;
    function rememberMissingImage(normalizedName) {
        missingImages[normalizedName] = Date.now();
        clearTimeout(missingStoreTimer);
        missingStoreTimer = setTimeout(() => {
            try {
                localStorage.setItem(MISSING_STORE_KEY, JSON.stringify(missingImages));
            } catch (error) {
                console.debug('Cache des absences non enregistré:', error);
            }
        }, 500);
    }

    loadImageStore();
    loadMissingStore();

    // Les absences récentes peuplent le cache mémoire avec le placeholder,
    // ce qui court-circuite les appels réseau au chargement suivant.
    Object.keys(missingImages).forEach(name => {
        if (!imageCache.has(name)) imageCache.set(name, DEFAULT_GAME_ICON);
    });

    // Version synchrone : permet d'afficher la bonne vignette dès la création
    // de la ligne, au lieu de partir du placeholder puis de le remplacer.
    function getCachedGameImage(gameName) {
        const cached = imageCache.get(gameName.toLowerCase().trim());
        return typeof cached === 'string' ? cached : null;
    }

    // Requêtes en vol, pour que trois listes affichant le même jeu au même
    // moment ne déclenchent pas trois appels identiques.
    const imageRequests = new Map();

    async function resolveGameImage(gameName, normalizedName) {
        try {
            const response = await fetch(`/api/get-game-image?name=${encodeURIComponent(normalizedName)}&v=${IMAGE_API_VERSION}`);
            if (response.ok) {
                const data = await response.json();
                if (data.imageUrl && data.imageUrl !== DEFAULT_GAME_ICON && await imageLoads(data.imageUrl)) {
                    imageCache.set(normalizedName, data.imageUrl);
                    persistImageStore();
                    return data.imageUrl;
                }
            }
        } catch (error) {
            console.error("API Error:", error);
        }

        // Absent de Steam : on tente l'illustration Wikipédia avant l'icône générique
        try {
            const wiki = await getWikiInfo(gameName);
            if (wiki && wiki.image && await imageLoads(wiki.image)) {
                imageCache.set(normalizedName, wiki.image);
                persistImageStore();
                return wiki.image;
            }
        } catch (error) {
            console.error("Wiki image error:", error);
        }

        // Ni Steam ni Wikipédia : on retient l'échec un jour, sinon ces jeux
        // relanceraient deux appels à chaque rechargement de la page.
        imageCache.set(normalizedName, DEFAULT_GAME_ICON);
        rememberMissingImage(normalizedName);
        return DEFAULT_GAME_ICON;
    }

    function getGameImage(gameName) {
        const normalizedName = gameName.toLowerCase().trim();

        if (imageCache.has(normalizedName)) {
            return Promise.resolve(imageCache.get(normalizedName));
        }
        if (imageRequests.has(normalizedName)) {
            return imageRequests.get(normalizedName);
        }

        const pending = resolveGameImage(gameName, normalizedName)
            .finally(() => imageRequests.delete(normalizedName));

        imageRequests.set(normalizedName, pending);
        return pending;
    }

    // Avatar de repli pour un joueur dont on n'a pas encore la photo Google :
    // ses initiales sur un fond sombre valent mieux qu'une image cassée.
    function initialsAvatar(name) {
        const initials = String(name || '?')
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map(word => word[0] || '')
            .join('')
            .toUpperCase() || '?';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <rect width="64" height="64" fill="#1c1c1c"/>
            <text x="32" y="41" font-family="Georgia, serif" font-size="26" fill="#8a7a45"
                  text-anchor="middle">${initials}</text></svg>`;
        return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    // Le trombinoscope réunit trois sources : qui est connecté (/status), qui a
    // voté (lan/votes) et les fiches durables (lan/users). Un joueur qui a voté
    // reste affiché même hors ligne : c'est lui qu'on cherche du regard.
    function buildRoster() {
        const roster = new Map();

        const put = (uid, name, avatar, online) => {
            const existing = roster.get(uid) || { uid, name: '', avatar: '', online: false };
            roster.set(uid, {
                uid,
                name: name || existing.name,
                avatar: avatar || existing.avatar,
                online: existing.online || online
            });
        };

        // statusIdentity aplatit les sessions du joueur en une seule fiche.
        // L'interface téléphone écrit « photo » là où le bureau écrit « avatar » :
        // on accepte les deux, sinon les joueurs sur mobile perdaient leur image.
        Object.entries(globalUsers || {}).forEach(([uid, node]) => {
            const identity = statusIdentity(node);
            if (identity) put(uid, identity.name, identity.avatar || identity.photo, true);
        });
        Object.entries(globalProfiles || {}).forEach(([uid, p]) => put(uid, p && p.name, p && p.avatar, false));
        Object.entries(globalVotes || {}).forEach(([uid, v]) => put(uid, v && v.name, null, false));

        // Connecté, votant, ou vu dans les sept derniers jours (isRostered).
        // Le dernier cas manquait : un joueur passé dans la journée sans voter
        // ne figurait nulle part, alors qu'il s'affichait dans les listes de
        // l'économie. Le filtre reste nécessaire, sinon d'anciens invités
        // traîneraient indéfiniment.
        const sources = { status: globalUsers, votes: globalVotes, profiles: globalProfiles };
        const kept = [...roster.values()].filter(p => isRostered(p.uid, sources));

        // Les connectés d'abord, puis par nom : la bande reste stable d'un
        // rendu à l'autre au lieu de suivre l'ordre des clés Firebase.
        return kept.sort((a, b) => {
            if (a.online !== b.online) return a.online ? -1 : 1;
            return String(a.name).localeCompare(String(b.name), 'fr');
        });
    }

    function writeMyPresence() {
        const user = auth.currentUser;
        if (!user || !myConnectionRef) return;
        myConnectionRef.set({ name: user.displayName, avatar: user.photoURL, device: 'bureau' });
        myConnectionRef.onDisconnect().remove();
    }

    // Un onglet resté sur une version antérieure efface /status/{uid} en entier
    // quand il se ferme, emportant les sessions des autres appareils du même
    // joueur. Plutôt que de disparaître de la bande alors qu'on est toujours
    // là, on se réinscrit dès qu'on constate l'effacement.
    function reassertPresence() {
        const user = auth.currentUser;
        if (!user || !firebaseConnected || !myConnectionRef) return;
        const node = globalUsers[user.uid];
        if (node && node[myConnectionKey]) return;
        // Forme à plat écrite par un ancien client : elle nous décrit déjà, la
        // réécrire mélangerait les deux formes pour rien.
        if (node && typeof node.name === 'string') return;
        writeMyPresence();
    }

    function renderActiveUsers() {
        const sidebar = document.getElementById('active-users-sidebar');
        const body = document.body;
        if (!sidebar) return;

        sidebar.innerHTML = '';
        ['role-user-select', 'role-user-select-lan', 'level-user-select'].forEach(id => {
            const sel = document.getElementById(id);
            if (!sel) return;
            const keep = sel.value;
            sel.innerHTML = '<option value="">Sélectionner un joueur...</option>';
            sel.dataset.keep = keep || '';
        });

        const roster = buildRoster();

        if (roster.length > 0) {
            sidebar.classList.add('visible');
            body.classList.add('sidebar-visible');
        } else {
            sidebar.classList.remove('visible');
            body.classList.remove('sidebar-visible');
        }

        roster.forEach(player => {
            const slot = document.createElement('div');
            slot.className = 'user-avatar-container ' + (player.online ? 'is-online' : 'is-offline');
            slot.dataset.name = `${player.name || 'Joueur'} — ${player.online ? 'connecté' : 'déconnecté'}`;

            const img = document.createElement('img');
            img.src = safeAvatarUrl(player.avatar, initialsAvatar(player.name));
            img.alt = player.name || 'Joueur';
            img.className = 'user-avatar-icon';
            // Une photo Google périmée renverrait une image cassée : on retombe
            // sur les initiales plutôt que sur l'icône de vignette absente.
            img.addEventListener('error', () => { img.src = initialsAvatar(player.name); });
            slot.appendChild(img);

            const dot = document.createElement('span');
            dot.className = 'presence-dot';
            slot.appendChild(dot);

            const identity = document.createElement('span');
            identity.className = 'user-roster-copy';

            const name = document.createElement('strong');
            name.className = 'user-roster-name';
            name.textContent = player.name || 'Joueur';

            const state = document.createElement('small');
            state.className = 'user-roster-state';
            state.textContent = player.online ? 'À la table' : 'Hors ligne';

            identity.append(name, state);
            slot.appendChild(identity);

            slot.addEventListener('click', () => {
                showPlayerVotesModal(player.uid, player.name, globalVotes);
            });

            sidebar.appendChild(slot);

            // Les trois sélecteurs de joueur : rôles (console et LAN active) et
            // niveau de départ. Le choix en cours survit au redessin, sinon il
            // saute dès que quelqu'un se connecte.
            ['role-user-select', 'role-user-select-lan', 'level-user-select'].forEach(selectId => {
                const sel = document.getElementById(selectId);
                if (!sel) return;
                const opt = document.createElement('option');
                opt.value = player.uid;
                opt.textContent = player.name || player.uid;
                sel.appendChild(opt);
            });
        });

        ['role-user-select', 'role-user-select-lan', 'level-user-select'].forEach(id => {
            const sel = document.getElementById(id);
            if (sel && sel.dataset.keep) sel.value = sel.dataset.keep;
        });
        describeLevelTarget();

        const online = roster.filter(player => player.online).length;
        const onlineCount = document.getElementById('desktop-online-count');
        if (onlineCount) onlineCount.textContent = String(online);
        renderDesktopShell();
    }

    // Table « nom normalisé -> casse d'affichage », construite une fois par
    // ouverture de la modale : calculateScores conserve déjà la bonne casse.
    function buildDisplayNameMap() {
        const map = new Map();
        (calculateScores(globalVotes) || []).forEach(g => {
            map.set(normalizeGameName(g.name), g.name);
        });
        return map;
    }


    function profileSerial(uid) {
        let hash = 0;
        String(uid || '').split('').forEach(char => { hash = ((hash * 31) + char.charCodeAt(0)) >>> 0; });
        return String((hash % 900) + 100);
    }

    function hexToRgb(hex) {
        const value = String(hex || '').replace('#', '');
        const full = value.length === 3 ? value.split('').map(char => char + char).join('') : value;
        const parsed = parseInt(full, 16);
        if (!Number.isFinite(parsed)) return '212, 175, 55';
        return `${(parsed >> 16) & 255}, ${(parsed >> 8) & 255}, ${parsed & 255}`;
    }

    function applyProfileTheme(title) {
        const dossier = document.querySelector('#player-votes-modal .prof-dossier');
        if (!dossier) return;
        const theme = title || {
            rarity: 'none', material: 'graphite', motif: 'grid', motion: 'calm',
            accent: '#d4af37', accent2: '#f1dd8a'
        };
        dossier.dataset.titleRarity = theme.rarity;
        dossier.dataset.titleMotif = theme.motif;
        dossier.dataset.titleMaterial = theme.material;
        dossier.dataset.titleMotion = theme.motion || 'calm';
        dossier.style.setProperty('--prof-accent', theme.accent);
        dossier.style.setProperty('--prof-accent-2', theme.accent2);
        dossier.style.setProperty('--prof-accent-rgb', hexToRgb(theme.accent));
        const family = document.getElementById('player-prof-card-family');
        if (family) family.textContent = title
            ? `${theme.material.toUpperCase()} · ${theme.rarity.toUpperCase()}`
            : 'LAN DEMAIN · SANS TITRE';
        if (profileDraft) {
            const nickname = document.getElementById('player-prof-nick');
            if (nickname) {
                nickname.textContent = title ? `« ${title.label} »` : '';
                nickname.style.display = title ? 'block' : 'none';
            }
        }
    }

    function achievementBadgeMarkup(row, compact) {
        const path = ACH_ICONS[row.ach.icon] || ACH_ICONS.trophy;
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"></path></svg>
            <span><strong>${escapeHtml(row.ach.label)}</strong>
            <small>${row.owned
        ? (compact ? escapeHtml(row.ach.hint) : 'Acquis')
        : `${escapeHtml(row.ach.hint)} · ${row.current} / ${row.goal}`}</small></span>`;
    }

    function renderProfileCustomizer(profile) {
        const titles = document.getElementById('player-prof-title-options');
        const features = document.getElementById('player-prof-feature-options');
        if (!titles || !features || !profileDraft) return;
        titles.innerHTML = '';
        const noTitle = document.createElement('button');
        noTitle.type = 'button';
        noTitle.className = 'prof-title-choice' + (!profileDraft.titleId ? ' is-selected' : '');
        noTitle.innerHTML = '<strong>Nom seul</strong><small>Carte graphite, sans titre équipé</small>';
        noTitle.addEventListener('click', () => {
            profileDraft.titleId = '';
            applyProfileTheme(null);
            renderProfileCustomizer(profile);
        });
        titles.appendChild(noTitle);
        profile.unlockedTitles.forEach(title => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'prof-title-choice' + (profileDraft.titleId === title.id ? ' is-selected' : '');
            button.style.setProperty('--choice-accent', title.accent);
            button.innerHTML = `<span class="prof-title-choice__swatch"></span><strong>« ${escapeHtml(title.label)} »</strong>
                <small>${escapeHtml(title.material)} · ${escapeHtml(title.rarity)}</small>`;
            button.addEventListener('click', () => {
                profileDraft.titleId = title.id;
                applyProfileTheme(title);
                renderProfileCustomizer(profile);
            });
            titles.appendChild(button);
        });
        features.innerHTML = '';
        profile.achievements.forEach(row => {
            const button = document.createElement('button');
            button.type = 'button';
            const selected = profileDraft.featuredIds.includes(row.ach.id);
            button.className = 'prof-feature-choice' + (selected ? ' is-selected' : '');
            button.innerHTML = achievementBadgeMarkup(row, false);
            button.addEventListener('click', () => {
                const index = profileDraft.featuredIds.indexOf(row.ach.id);
                if (index >= 0) profileDraft.featuredIds.splice(index, 1);
                else if (profileDraft.featuredIds.length < 3) profileDraft.featuredIds.push(row.ach.id);
                else showToast('Ta vitrine contient déjà trois trophées.', 'info');
                renderProfileCustomizer(profile);
            });
            features.appendChild(button);
        });
    }

    /* La fiche est une carte de collection à part entière. Son titre est choisi
       parmi les hauts faits permanents et devient sa direction artistique. */
    function renderPlayerProfileHead(uid, userName) {
        const profile = playerProfile(achData(), uid);
        applyProfileTheme(profile.equippedTitle);
        const dossier = document.querySelector('#player-votes-modal .prof-dossier');
        if (dossier) {
            const nameLength = Array.from(String(userName || 'Joueur').trim()).length;
            dossier.dataset.playerNameLength = nameLength > 27 ? 'long' : (nameLength > 18 ? 'medium' : 'short');
        }

        const face = document.getElementById('player-prof-face');
        if (face) {
            face.src = safeAvatarUrl(globalProfiles[uid] && globalProfiles[uid].avatar,
                initialsAvatar(userName));
            face.onerror = () => { face.src = initialsAvatar(userName); };
        }

        const nick = document.getElementById('player-prof-nick');
        if (nick) {
            nick.textContent = profile.nickname ? `« ${profile.nickname} »` : '';
            nick.style.display = profile.nickname ? 'block' : 'none';
        }

        const lvl = document.getElementById('player-prof-lvl');
        if (lvl) {
            lvl.textContent = `Niveau ${profile.level.level} · ${levelTitle(profile.level.level)}`;
        }

        const progressCopy = document.getElementById('player-prof-progress-copy');
        if (progressCopy) {
            progressCopy.textContent = `${profile.level.total} XP · encore ${profile.level.toNext}`
                + ` avant le niveau ${profile.level.level + 1}`;
        }

        const achievementCount = document.getElementById('player-prof-achievement-count');
        if (achievementCount) {
            achievementCount.textContent = `${profile.achievementCount} / ${profile.achievementTotal}`;
        }

        const segs = document.getElementById('player-prof-segs');
        if (segs) {
            segs.innerHTML = '';
            const lit = profile.level.into > 0
                ? Math.max(1, Math.round(profile.level.ratio * XP_SEGMENTS)) : 0;
            for (let i = 0; i < XP_SEGMENTS; i += 1) {
                const seg = document.createElement('span');
                seg.className = 'xp-banner__seg'
                    + (i < lit ? (i === lit - 1 ? ' is-edge' : ' is-on') : '');
                segs.appendChild(seg);
            }
        }

        // Quatre repères stables : la carte garde la même composition même
        // quand un compteur est encore à zéro.
        const stats = document.getElementById('player-prof-stats');
        if (stats) {
            stats.innerHTML = '';
            [
                ['Fortune', formatPoints(profile.balance)],
                ['Hauts faits', profile.achievementCount],
                ['Cartes', profile.counters.cards],
                ['LAN', profile.counters.lans]
            ].forEach(([label, value]) => {
                const cell = document.createElement('div');
                cell.className = 'prof-stat';
                cell.innerHTML = `<span class="prof-stat__v">${escapeHtml(String(value))}</span>
                    <span class="prof-stat__l">${escapeHtml(label)}</span>`;
                stats.appendChild(cell);
            });
        }

        const serial = document.getElementById('player-prof-card-number');
        if (serial) serial.textContent = `№ ${profileSerial(uid)}`;

        const featured = document.getElementById('player-prof-featured');
        if (featured) {
            featured.innerHTML = '';
            if (!profile.featuredAchievements.length) {
                featured.innerHTML = '<p class="prof-featured__empty">La vitrine attend son premier trophée.</p>';
            } else {
                profile.featuredAchievements.forEach((row, index) => {
                    const trophy = document.createElement('article');
                    trophy.className = 'prof-featured-trophy';
                    trophy.style.setProperty('--trophy-delay', `${index * 90}ms`);
                    trophy.innerHTML = achievementBadgeMarkup(row, true);
                    featured.appendChild(trophy);
                });
            }
        }

        const badges = document.getElementById('player-prof-badges');
        if (badges) {
            badges.innerHTML = '';
            achievementState(achData(), uid).forEach(row => {
                const badge = document.createElement('span');
                badge.className = 'prof-badge ' + (row.owned ? 'is-owned' : 'is-locked');
                badge.title = row.ach.hint;
                badge.innerHTML = achievementBadgeMarkup(row, false);
                badges.appendChild(badge);
            });
        }

        const customize = document.getElementById('player-prof-customize-btn');
        const mine = !!(auth.currentUser && auth.currentUser.uid === uid);
        if (customize) customize.hidden = !mine;
        if (mine && profileDraft) renderProfileCustomizer(profile);
    }

    function showPlayerVotesModal(uid, userName, votesData) {
        const modal = document.getElementById('player-votes-modal');
        const nameEl = document.getElementById('player-votes-name');
        const listEl = document.getElementById('player-votes-content');

        if (!modal || !nameEl || !listEl) return;

        nameEl.textContent = userName || 'Joueur';
        openProfileUid = uid;
        openProfileName = userName || 'Joueur';
        profileDraft = null;
        const customizer = document.getElementById('player-prof-customizer');
        if (customizer) customizer.hidden = true;
        renderPlayerProfileHead(uid, userName);
        listEl.innerHTML = '';

        const userVoteData = votesData[uid];
        if (!userVoteData || !userVoteData.votes) {
            listEl.innerHTML = '<p class="prof-votes-empty">Aucun vote enregistré.</p>';
        } else {
            const p = userVoteData.votes;
            const displayNames = buildDisplayNameMap();
            const displayGameName = (raw) => displayNames.get(normalizeGameName(raw)) || raw;

            const createSection = (title, gamesArray, tier) => {
                if (!gamesArray || gamesArray.length === 0) return;
                const sec = document.createElement('section');
                sec.className = `prof-vote-group prof-vote-group--${tier}`;
                const heading = document.createElement('h5');
                heading.textContent = title;
                sec.appendChild(heading);
                gamesArray.forEach(g => {
                    const row = document.createElement('div');
                    row.className = 'player-row prof-vote-row';
                    // Les votes stockent la saisie brute, souvent en minuscules :
                    // on réutilise la casse d'affichage calculée pour le classement
                    const label = displayGameName(g);
                    row.innerHTML = `<span>${escapeHtml(label)}</span>`;

                    // Reprendre un jeu vu chez un autre joueur, pendant le vote
                    if (globalSettings.isVotingOpen && document.getElementById('vote-form')) {
                        const add = document.createElement('button');
                        add.type = 'button';
                        add.className = 'rank-row__add';
                        add.textContent = '+';
                        add.title = `Ajouter « ${label} » à mon vote`;
                        add.setAttribute('aria-label', `Ajouter ${label} à mon vote`);
                        add.addEventListener('click', () => addGameToVote(label));
                        row.appendChild(add);
                    }

                    sec.appendChild(row);
                });
                listEl.appendChild(sec);
            };

            createSection('Priorité 1 · 5 pts', p.p1, 'gold');
            createSection('Priorité 2 · 3 pts', p.p2, 'silver');
            createSection('Priorité 3 · 2 pts', p.p3, 'bronze');
            createSection('Autres · 1 pt', p.p_other, 'other');
        }

        modal.style.display = 'flex';
    }

    function initializeApp(user) {
        // Initial check based on config, but roles from DB will overwrite
        let isAdmin = user.uid === ADMIN_UID;
        window.currentUserIsAdmin = isAdmin;
        window.currentUserIsMixologist = false;

        // Listen for user roles
        watchValue(db.ref('lan/roles'), snapshot => {
            const roles = snapshot.val() || {};
            globalRoles = roles;
            const myRole = roles[user.uid];

            if (myRole === 'admin') {
                window.currentUserIsAdmin = true;
            } else if (user.uid === ADMIN_UID) {
                // Keep hardcoded admin even if not in DB, to prevent lockout
                window.currentUserIsAdmin = true;
            } else {
                window.currentUserIsAdmin = false;
            }

            window.currentUserIsMixologist = (myRole === 'mixologist');
            // Le maître du jeu tient la boutique. L'admin l'est d'office : une
            // soirée ne doit pas se bloquer parce qu'il est parti dormir.
            window.currentUserIsGamemaster = isGamemaster(myRole, user.uid, ADMIN_UID);

            // Update UI based on roles
            const lanAdminNav = document.getElementById('lan-nav-admin');
            if (lanAdminNav) lanAdminNav.style.display = window.currentUserIsAdmin ? 'block' : 'none';
            updateVotingUIState();
            // Le poste « frapper le set » n'apparaît qu'au maître du jeu : le
            // rôle arrive après le premier rendu, il faut redessiner.
            renderBoutique();
            renderCollection();
            renderDesktopShell();
            if (openProfileUid && document.getElementById('player-votes-modal')?.style.display === 'flex') {
                renderPlayerProfileHead(openProfileUid, openProfileName || playerLabel(openProfileUid));
            }
        });

        // Une clé par session ouverte : le même compte tourne souvent sur le PC
        // et sur le téléphone, et fermer l'un ne doit pas déclarer l'autre parti.
        myConnectionRef = db.ref('/status/' + user.uid).push();
        myConnectionKey = myConnectionRef.key;
        const connectedRef = db.ref('.info/connected');

        watchValue(connectedRef, (snap) => {
            firebaseConnected = snap.val() === true;
            if (firebaseConnected) {
                writeMyPresence();
                // Copie qui survit à la déconnexion : /status est effacé en
                // partant, la fiche reste pour afficher la photo d'un absent.
                db.ref('lan/users/' + user.uid).update({
                    name: user.displayName || '',
                    avatar: user.photoURL || '',
                    lastSeen: Date.now()
                }).catch(() => { /* profil non critique : le vote passe avant */ });
            }
        });

        watchConnection(connectedRef, () => firebaseConnected);

        votesRef = db.ref('lan/votes');
        settingsRef = db.ref('lan/settings');
        eventsRef = db.ref('lan/events');
        cocktailsRef = db.ref('lan/cocktails');
        notificationsRef = db.ref('lan/notifications/' + user.uid);

        watchValue(db.ref('/status'), snapshot => {
            globalUsers = snapshot.val() || {};
            reassertPresence();
            renderActiveUsers();
        });

        watchValue(db.ref('lan/users'), snapshot => {
            globalProfiles = snapshot.val() || {};
            renderActiveUsers();
            if (openProfileUid && document.getElementById('player-votes-modal')?.style.display === 'flex') {
                renderPlayerProfileHead(openProfileUid, openProfileName || playerLabel(openProfileUid));
            }
        });

        watchValue(eventsRef, (snapshot) => {
            const eventsData = snapshot.val() || {};
            window._latestEventsData = eventsData;
            renderEvents(eventsData);
            renderAgenda();
            renderWaitingClosed();
            renderBoard();
            checkEventReminders(eventsData, user);
        });

        // Une minute suffit : rappels, compte à rebours et repère « maintenant »
        // du programme se rafraîchissent ensemble.
        if (agendaMinuteTimer) clearInterval(agendaMinuteTimer);
        agendaMinuteTimer = setInterval(() => {
            if (auth.currentUser) {
                renderWhenWhere();
                renderAgenda();
                renderWaitingClosed();
                renderBoard();
            }
            if (window._latestEventsData && auth.currentUser) {
                checkEventReminders(window._latestEventsData, auth.currentUser);
            }
        }, 60000);

        watchValue(cocktailsRef, (snapshot) => {
            const cocktailsData = snapshot.val() || {};
            window._latestCocktailsData = cocktailsData;
            renderCocktails(cocktailsData, user);
            renderCocktailSummary(cocktailsData);
            renderBoard();
        });

        watchValue(db.ref('lan/economy'), (snapshot) => {
            globalEconomy = snapshot.val() || {};
            renderBoutique();
            renderBoard();
            // Une demande de booster validée devient un paquet scellé : le
            // rejeu des cartes en dépend, donc on l'invalide aussi.
            tcgViewCache = null;
            sealBoughtPacks();
            renderCollection();
            renderDesktopShell();
        });

        watchValue(db.ref('lan/challenges'), (snapshot) => {
            globalQuests.challenges = snapshot.val() || {};
            renderDefis();
            renderDesktopShell();
        });
        watchValue(db.ref('lan/claims'), (snapshot) => {
            globalQuests.claims = snapshot.val() || {};
            renderDefis();
            renderBoard();
            renderDesktopShell();
        });
        watchValue(db.ref('lan/suggestions'), (snapshot) => {
            globalQuests.suggestions = snapshot.val() || {};
            renderDefis();
            renderDesktopShell();
        });

        watchValue(db.ref('lan/xp'), (snapshot) => {
            globalXp = snapshot.val() || {};
            renderBoutique();
            grantPendingAchievements();
            renderDesktopShell();
        });

        /* L'historique sert à compter les LAN de chacun : « Habitué », c'est
           trois soirées, et une soirée est une entrée d'historique. */
        watchValue(db.ref('lan/history'), (snapshot) => {
            globalHistory = snapshot.val() || {};
            renderDesktopShell();
        });
        startTickEngine();

        watchValue(db.ref('lan/tcg'), (snapshot) => {
            globalTcg = snapshot.val() || {};
            tcgViewCache = null;
            sealBoughtPacks();
            renderCollection();
            renderDesktopShell();
        });

        watchValue(notificationsRef, (snapshot) => {
            renderNotifications(snapshot.val() || {}, user);
        });

        // Bibliothèques Steam, indexées par compte Steam. Le catalogue Game Pass
        // n'est téléchargé que si au moins une personne est marquée abonnée.
        watchValue(db.ref('lan/steamLibraries'), (snapshot) => {
            groupLibraries = snapshot.val() || {};
            const needsGamepass = Object.values(groupLibraries).some(l => l.gamepass);
            if (needsGamepass && !gamepassCatalog) {
                loadGamepassCatalog().then(renderGroupLibrary);
            } else {
                renderGroupLibrary();
            }
            renderWaitingClosed();
        });

        // Ce que chacun a déjà installé, pour la checklist d'avant-soirée.
        watchValue(db.ref('lan/installed'), (snapshot) => {
            globalInstalled = snapshot.val() || {};
            renderWaitingClosed();
        });

        // Sondages
        watchValue(db.ref('lan/polls'), (snapshot) => {
            globalPolls = snapshot.val() || {};
            announceNewPolls();
            handlePollClosures();
            renderPolls();
            refreshRecapIfVisible();
        });

        // Commandes groupées
        watchValue(db.ref('lan/foodRuns'), (snapshot) => {
            globalFoodRuns = snapshot.val() || {};
            renderFoodRuns();
            renderBoard();
            refreshRecapIfVisible();
        });
        buildPollOptionInputs(2);

        watchValue(settingsRef, (snapshot) => {
            const newSettings = snapshot.val() || { isVotingOpen: true, topGamesCount: 10, isLanActive: false };

            if (appInitialized && globalSettings.isVotingOpen === true && newSettings.isVotingOpen === false) {
                showToast("Les votes sont terminés ! Voici les résultats...", "success");
                showFinalResults();
            }

            globalSettings = newSettings;
            updateVotingUIState();
            renderDesktopShell();
            // La date de la LAN sert de jour par défaut au programme : les deux
            // se rafraîchissent ensemble.
            renderWhenWhere();
            renderAgenda();
            fillScheduleInputs();

            // On utilise window.currentUserIsAdmin (mis à jour par les rôles en DB) et non
            // une variable figée à la connexion, sinon un admin promu en cours de LAN a une UI incohérente
            if (window.currentUserIsAdmin) {
                // Les trois boutons doivent suivre l'état : celui de la LAN active
                // était absent de ce sélecteur et restait figé sur « Clore le Vote »,
                // si bien qu'il rouvrait les votes au lieu de les clore.
                const toggleBtns = document.querySelectorAll('#toggle-voting-btn-open, #toggle-voting-btn-dashboard, #toggle-voting-btn-dashboard-lan');
                toggleBtns.forEach(btn => btn && (btn.textContent = globalSettings.isVotingOpen ? "Clôturer le Vote" : "Ouvrir le Vote"));
                const countInputs = document.querySelectorAll('#dashboard-top-games-count');
                countInputs.forEach(input => input && (input.value = globalSettings.topGamesCount || 10));

                // Show/hide the Ouvrir La LAN button
                const openLanBtn = document.getElementById('btn-open-lan-dashboard');
                if (openLanBtn) {
                    openLanBtn.style.display = (!globalSettings.isVotingOpen && !globalSettings.isLanActive) ? 'block' : 'none';
                }
                // Legacy final-results-modal button
                const oldOpenLanBtn = document.getElementById('start-active-lan-btn');
                if (oldOpenLanBtn) {
                    oldOpenLanBtn.style.display = (!globalSettings.isLanActive && !globalSettings.isVotingOpen) ? 'block' : 'none';
                }
            }
        });

        watchValue(votesRef, (snapshot) => {
            globalVotes = snapshot.val() || {};
            renderDashboard(globalVotes, user);
            // Un nouveau votant doit rejoindre le trombinoscope même hors ligne.
            renderActiveUsers();
            renderDesktopShell();

            const selectedUserId = voterSelectMenu.value || user.uid;
            if (!isEditing || selectedUserId !== user.uid) {
                loadVoteIntoForm(selectedUserId, globalVotes, user);
            }
            appInitialized = true;
        });

        updateVotingUIState();
    }

    /* L'admin travaille hors soirée : garnir la carte de la boutique, écrire
       des défis, composer le set. Tous les écrans de la LAN active lui sont
       donc ouverts en permanence — ce drapeau retient lequel il regarde, et la
       vue de LAN active est réaffichée telle quelle, ouverte dessus.
       Auparavant seule la Collection y avait droit, par un bouton caché. */
    let desktopPreviewSubview = '';

    function updateVotingUIState() {
        const viewNoLan = document.getElementById('view-no-lan');
        const viewVotingOpen = document.getElementById('view-voting-open');
        const viewWaitingClosed = document.getElementById('view-waiting-closed');
        const viewAdminDashboard = document.getElementById('view-admin-dashboard');
        const viewLanActive = document.getElementById('view-lan-active');
        const leftSidebar = document.getElementById('left-sidebar');
        const adminPanelOpen = document.getElementById('admin-panel-open');
        const form = document.getElementById('vote-form');

        const viewLanFinished = document.getElementById('view-lan-finished');

        if (viewNoLan) viewNoLan.style.display = 'none';
        if (viewVotingOpen) viewVotingOpen.style.display = 'none';
        if (viewWaitingClosed) viewWaitingClosed.style.display = 'none';
        if (viewAdminDashboard) viewAdminDashboard.style.display = 'none';
        if (viewLanActive) viewLanActive.style.display = 'none';
        if (viewLanFinished) viewLanFinished.style.display = 'none';
        if (leftSidebar) leftSidebar.style.display = 'none';
        if (adminPanelOpen) adminPanelOpen.style.display = 'none';

        const finalResultsModal = document.getElementById('final-results-modal');
        if (finalResultsModal) finalResultsModal.style.display = 'none';

        if (!window.currentUserIsAdmin) desktopAdminOverride = false;
        const phase = desktopPhase();

        if (!window.currentUserIsAdmin) desktopPreviewSubview = '';

        /* L'admin a ouvert un écran de la soirée alors qu'elle n'a pas
           commencé. On lui montre la vue de LAN active, ouverte sur cet
           onglet, et rien d'autre : c'est ainsi qu'on prépare une carte, une
           liste de défis ou un set avant le jour J. On clique l'aiguillage
           hérité plutôt que d'appeler activateDesktopSubview(), qui
           rappellerait cette fonction. */
        if (desktopPreviewSubview && window.currentUserIsAdmin && phase !== 'active') {
            if (viewLanActive) viewLanActive.style.display = 'block';
            const btnNotifPreview = document.getElementById('btn-notifications');
            if (btnNotifPreview) btnNotifPreview.style.display = 'grid';
            document.querySelector(`.lan-nav-list .nav-item[data-target="${desktopPreviewSubview}"]`)?.click();
            renderDesktopShell();
            return;
        }

        // La cloche existe dans toutes les phases. Une seule ligne, posée avant
        // le premier retour, plutôt qu'une par branche.
        const btnNotifShell = document.getElementById('btn-notifications');
        if (btnNotifShell) btnNotifShell.style.display = 'grid';

        /* Le panneau admin est une destination, pas une phase : il doit passer
           avant « terminée ». Testé après, le récapitulatif reprenait la main
           à chaque clic et le panneau restait injoignable une fois la LAN
           close. Pendant la soirée, l'admin a son propre sous-écran. */
        if (desktopAdminOverride && window.currentUserIsAdmin && phase !== 'active') {
            if (form) form.style.display = 'none';
            if (viewAdminDashboard) viewAdminDashboard.style.display = 'block';
            const openLanBtn = document.getElementById('btn-open-lan-dashboard');
            if (openLanBtn) openLanBtn.style.display = (!globalSettings.isLanActive && phase === 'locked') ? 'block' : 'none';
            renderDesktopShell();
            return;
        }

        // La soirée terminée prime sur l'attente d'avant-LAN : c'est un état
        // volontaire de l'admin, pas un entre-deux.
        if (phase === 'finished') {
            if (viewLanFinished) viewLanFinished.style.display = 'block';
            renderLanRecap();
            return;
        }

        if (phase === 'active') {
            desktopAdminOverride = false;
            if (viewLanActive) viewLanActive.style.display = 'block';
            // Show admin/mixologist buttons
            if (window.currentUserIsAdmin || window.currentUserIsMixologist) {
                const addMasterBtn = document.getElementById('btn-add-master-kocktail');
                if (addMasterBtn) addMasterBtn.style.display = 'inline-block';
            }
            return;
        }

        if (phase === 'idle') {
            desktopAdminOverride = false;
            if (form) form.style.display = 'none';
            if (viewNoLan) viewNoLan.style.display = 'flex';
            renderDesktopIdle();
        } else if (phase === 'voting') {
            if (desktopVotingDestination === 'events') {
                if (viewLanActive) viewLanActive.style.display = 'block';
                if (form) form.style.display = 'none';
                activateDesktopSubview('lan-calendar');
                return;
            }
            if (viewVotingOpen) viewVotingOpen.style.display = 'block';
            if (form) form.style.display = 'flex';
            if (window.currentUserIsAdmin && adminPanelOpen) {
                if (leftSidebar) leftSidebar.style.display = 'block';
                adminPanelOpen.style.display = 'grid';
            }
        } else {
            if (form) form.style.display = 'none';
            if (viewWaitingClosed) viewWaitingClosed.style.display = 'flex';
            renderWaitingClosed();
        }
        renderDesktopShell();
    }

    const handleToggleVoting = () => {
        const newIsOpen = !globalSettings.isVotingOpen;
        const countInput = document.getElementById('dashboard-top-games-count');
        const newCount = countInput ? (parseInt(countInput.value) || globalSettings.topGamesCount || 10) : 10;

        // IMPORTANT: Use .update() not .set() to preserve isLanActive and other fields
        db.ref('lan/settings').update({
            isVotingOpen: newIsOpen,
            topGamesCount: newCount
        }).then(() => {
            if (!newIsOpen) {
                // Archive votes when closing
                archiveVotesOnClose();
            }
        }).catch(error => {
            showToast("Erreur de permission. Vérifiez les règles Firebase.", "error");
            console.error("Firebase Rule Error:", error);
        });
    };

    document.getElementById('toggle-voting-btn-open')?.addEventListener('click', handleToggleVoting);
    document.getElementById('toggle-voting-btn-dashboard')?.addEventListener('click', handleToggleVoting);

    document.getElementById('start-active-lan-btn')?.addEventListener('click', () => {
        askConfirm("Démarrer la LAN en mode actif ? Cela fermera le mode attente pour tout le monde.",
            { title: '🔥 Démarrer la LAN' }).then(ok => {
                if (!ok) return;
                db.ref('lan/settings').update({ isLanActive: true })
                    .then(() => {
                        const finalModal = document.getElementById('final-results-modal');
                        if (finalModal) finalModal.style.display = 'none';
                        showToast("La LAN est officiellement ouverte !", "success");
                    });
            });
    });

    document.getElementById('save-config-btn')?.addEventListener('click', () => {
        const countEl = document.getElementById('dashboard-top-games-count');
        const nameEl = document.getElementById('dashboard-lan-name');
        const newCount = countEl ? (parseInt(countEl.value) || 10) : 10;
        const newName = nameEl ? (nameEl.value.trim() || 'LAN Demain') : 'LAN Demain';
        // Use .update() to preserve isLanActive and other settings fields
        db.ref('lan/settings').update({
            topGamesCount: newCount,
            lanName: newName
        }).then(() => showToast("Configuration sauvegardée", "success"))
            .catch(e => showToast("Erreur: " + e.message, "error"));
    });

    document.getElementById('close-results-btn')?.addEventListener('click', () => {
        const frModal = document.getElementById('final-results-modal');
        if (frModal) frModal.style.display = 'none';
    });

    document.getElementById('reset-all-votes-btn-dashboard')?.addEventListener('click', () => {
        const confirmation = prompt("Cette action est irréversible et supprimera TOUS les votes. Pour confirmer, tapez 'RESET'.");
        if (confirmation === 'RESET') {
            db.ref('lan/votes').remove()
                .then(() => showToast("Tous les votes ont été réinitialisés.", "success"))
                .catch((err) => showToast("Erreur lors de la réinitialisation: " + err.message, "error"));
        } else if (confirmation !== null) {
            showToast("Action annulée.");
        }
    });

    if (voteForm) {
        // La liste des suggestions se recalcule après la frappe, pas pendant :
        // redessiner à chaque touche ferait clignoter les vignettes.
        let suggestionsTimer = null;
        const refreshSuggestionsSoon = () => {
            clearTimeout(suggestionsTimer);
            suggestionsTimer = setTimeout(() => renderVoteSuggestions(), 400);
        };

        voteForm.addEventListener('input', () => {
            if (voterSelectMenu.value === '' || (auth.currentUser && voterSelectMenu.value === auth.currentUser.uid)) {
                isEditing = true;
            }
            refreshSuggestionsSoon();
        });

        voteForm.addEventListener('click', (e) => {
            const addButton = e.target.closest('.add-game-btn');
            if (addButton) {
                const list = addButton.previousElementSibling;
                createInput('', false, list);
            }
            if (e.target.classList.contains('remove-game-btn')) {
                e.target.closest('.game-input-wrapper').remove();
                renderVoteSuggestions();
            }
            const searchButton = e.target.closest('.steam-search-btn');
            if (searchButton) {
                handleSteamSearch(searchButton);
            }
        });

        voteForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const user = auth.currentUser;
            if (!user) return;

            clearVoteError();

            // Passe de vérification Steam avant tout : deux orthographes du même
            // jeu doivent devenir un seul nom, sinon le doublon passe inaperçu.
            const submitBtn = document.getElementById('submit-vote-btn');
            const originalLabel = submitBtn?.textContent;
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Vérification des noms…';
            }

            let corrections = [];
            try {
                corrections = await canonicalizeVoteInputs();
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalLabel;
                }
            }

            if (corrections.length > 0) {
                const list = corrections.map(c => `« ${c.from} » → « ${c.to} »`).join(', ');
                showToast(`Noms corrigés : ${list}`, 'success');
            }

            const userIdToSave = voterSelectMenu.value || user.uid;
            const userNameToSave = (globalVotes[userIdToSave]) ? globalVotes[userIdToSave].name : user.displayName;
            const playerVotes = { p1: [], p2: [], p3: [], p_other: [] };
            const allNewGames = new Set();

            document.querySelectorAll('.priority-group').forEach(group => {
                const priority = group.dataset.priority;
                group.querySelectorAll('.game-input-list input').forEach(input => {
                    // On stocke le nom avec sa casse d'origine ; la normalisation ne sert qu'aux comparaisons
                    const rawGame = input.value.trim().replace(/\s+/g, ' ');
                    const game = normalizeGameName(rawGame);
                    if (game) {
                        playerVotes[priority].push(rawGame);
                        allNewGames.add(game);
                    }
                });
            });

            // Un même jeu ne peut pas occuper deux priorités : il cumulerait
            // les points et fausserait le classement.
            const duplicates = findDuplicateVotes();
            if (duplicates.length > 0) {
                const list = duplicates.map(d => `« ${d} »`).join(', ');
                showVoteError(`${list} apparaît plusieurs fois dans votre vote. Gardez une seule priorité par jeu.`);
                highlightDuplicateInputs();
                return;
            }

            const suggestions = checkTypos(Array.from(allNewGames), globalVotes);
            if (suggestions.length > 0) {
                showCorrectionModal(suggestions, { userIdToSave, userNameToSave, playerVotes });
            } else {
                saveVote(userIdToSave, userNameToSave, playerVotes, user);
            }
        });
    }

    if (voterSelectMenu) {
        voterSelectMenu.addEventListener('change', (e) => {
            isEditing = false;
            const user = auth.currentUser;
            if (user) {
                loadVoteIntoForm(e.target.value || user.uid, globalVotes, user);
            }
        });
    }

    async function handleSteamSearch(searchButton) {
        const inputField = searchButton.closest('.game-input-wrapper').querySelector('input');
        const searchTerm = inputField.value.trim();
        if (searchTerm === '') return;

        searchButton.innerHTML = '⏳';
        searchButton.disabled = true;

        try {
            // fuzzy=1 : « Vérifier » sert justement à retrouver le nom officiel
            // à partir d'une abréviation, une correspondance exacte serait inutile
            const response = await fetch(`/api/get-game-image?name=${encodeURIComponent(searchTerm)}&fuzzy=1`);
            if (response.ok) {
                const data = await response.json();
                inputField.value = data.name;
                // Écriture par script : aucun événement input n'est émis, donc
                // les suggestions ne se recalculeraient pas toutes seules.
                renderVoteSuggestions();
                showToast(`Nom corrigé : « ${data.name} »`, 'success');
            } else {
                showToast('Jeu non trouvé sur Steam.', 'error');
            }
        } catch (error) {
            console.error("Erreur Steam:", error);
            showToast("Erreur de l'API Steam.", 'error');
        } finally {
            searchButton.textContent = 'Vérifier';
            searchButton.disabled = false;
        }
    }

    function saveVote(userId, userName, playerVotes, user) {
        db.ref(`lan/votes/${userId}`).set({ name: userName, votes: playerVotes })
            .then(() => {
                if (userId === user.uid) {
                    isEditing = false;
                }
                if (correctionModal && !correctionModal.style.display.includes('flex')) {
                    showToast(`Vote pour ${userName} enregistré !`, 'success');
                }
            })
            .catch(error => {
                console.error("Erreur:", error);
                showToast(`Erreur : ${error.message}`, 'error');
            });
    }

    function showCorrectionModal(suggestions, voteData) {
        const listElement = document.getElementById('correction-suggestions-list');
        listElement.innerHTML = '';
        suggestions.forEach(sugg => {
            const li = document.createElement('li');
            li.innerHTML = `Remplacer votre saisie <em>${escapeHtml(sugg.original)}</em> par le jeu déjà existant <strong>${escapeHtml(sugg.suggestion)}</strong> ?`;
            listElement.appendChild(li);
        });

        const newAcceptBtn = document.getElementById('modal-accept').cloneNode(true);
        document.getElementById('modal-accept').replaceWith(newAcceptBtn);
        const newIgnoreBtn = document.getElementById('modal-ignore').cloneNode(true);
        document.getElementById('modal-ignore').replaceWith(newIgnoreBtn);
        const newCancelBtn = document.getElementById('modal-cancel').cloneNode(true);
        document.getElementById('modal-cancel').replaceWith(newCancelBtn);

        const handler = () => { correctionModal.style.display = 'none'; };
        const acceptHandler = () => {
            const correctedVotes = JSON.parse(JSON.stringify(voteData.playerVotes));
            suggestions.forEach(sugg => {
                for (const priority in correctedVotes) {
                    correctedVotes[priority] = correctedVotes[priority].map(game => normalizeGameName(game) === sugg.original ? sugg.suggestion : game);
                }
            });
            saveVote(voteData.userIdToSave, voteData.userNameToSave, correctedVotes, auth.currentUser);
            handler();
        };
        const ignoreHandler = () => {
            saveVote(voteData.userIdToSave, voteData.userNameToSave, voteData.playerVotes, auth.currentUser);
            handler();
        };

        newAcceptBtn.addEventListener('click', acceptHandler);
        newIgnoreBtn.addEventListener('click', ignoreHandler);
        newCancelBtn.addEventListener('click', handler);

        correctionModal.style.display = 'flex';
    }


    function createInput(value, isFirst, list) {
        const wrapper = document.createElement('div');
        wrapper.className = 'game-input-wrapper';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.placeholder = 'Jeu...';
        if (list.closest('.priority-group')?.dataset.priority === 'p1') {
            input.placeholder = 'Le jeu que vous voulez absolument...';
        }
        wrapper.appendChild(input);

        const searchButton = document.createElement('button');
        searchButton.type = 'button';
        searchButton.className = 'steam-search-btn';
        searchButton.title = 'Vérifier le nom sur Steam';
        searchButton.textContent = 'Vérifier';
        wrapper.appendChild(searchButton);

        if (list.closest('.priority-group')?.dataset.priority !== 'p1') {
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'remove-game-btn';
            removeButton.textContent = '-';
            if (isFirst) {
                removeButton.style.visibility = 'hidden';
            }
            wrapper.appendChild(removeButton);
        }
        list.appendChild(wrapper);
    }

    function loadVoteIntoForm(userId, allVotes, currentUser) {
        const voteData = allVotes[userId];
        const playerVotes = voteData ? voteData.votes : {};
        const submitBtn = document.getElementById('submit-vote-btn');

        if (submitBtn) {
            if (userId === currentUser.uid && voteData && Object.values(playerVotes).some(p => p.length > 0)) {
                submitBtn.textContent = 'Mettre à jour mon Vote';
            } else {
                submitBtn.textContent = 'Soumettre mon Vote';
            }
        }

        document.querySelectorAll('.priority-group').forEach(group => {
            const priority = group.dataset.priority;
            const games = playerVotes[priority] || [];
            const list = group.querySelector('.game-input-list');
            if (list) {
                list.innerHTML = '';
                if (games.length > 0) {
                    games.forEach((game, index) => createInput(game, index === 0, list));
                } else {
                    createInput('', true, list);
                }
            }
        });

        renderVoteSuggestions();
    }

    function renderKPIs(gamesData, votes) {
        const winnerName = gamesData.length > 0 ? gamesData[0].name : '--';
        const winnerValueEl = document.getElementById('kpi-winner-value');
        if (winnerValueEl) winnerValueEl.textContent = winnerName;
        const winnerImage = document.getElementById('winner-image');

        if (winnerImage) {
            winnerImage.classList.remove('loaded');
            winnerImage.src = '';
            if (winnerName !== '--') {
                getGameImage(winnerName).then(imageUrl => {
                    winnerImage.src = imageUrl;
                    if (imageUrl.startsWith('https')) {
                        winnerImage.classList.add('loaded');
                    }
                });
            }
        }

        const votersValueEl = document.getElementById('kpi-voters-value');
        if (votersValueEl) animateCounter(votersValueEl, Object.keys(votes).length);

        const gamesValueEl = document.getElementById('kpi-games-value');
        if (gamesValueEl) animateCounter(gamesValueEl, gamesData.length);
    }

    function renderTable(gamesData) {
        const tableBody = document.getElementById('results-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '';
        if (gamesData.length === 0) {
            tableBody.innerHTML = `<tr class="results-empty"><td colspan="2">
                <strong>Le classement attend son premier vote.</strong>
                <small>La tendance apparaîtra ici en direct.</small>
            </td></tr>`;
            return;
        }
        gamesData.forEach((game, index) => {
            const row = document.createElement('tr');
            const rank = index + 1;
            if (rank === 1) row.classList.add('gold');
            else if (rank === 2) row.classList.add('silver');
            else if (rank === 3) row.classList.add('bronze');

            const gameCell = document.createElement('td');
            const scoreCell = document.createElement('td');

            const gameIcon = document.createElement('img');
            gameIcon.src = DEFAULT_GAME_ICON;
            gameIcon.alt = 'Icone';
            gameIcon.className = 'game-icon';

            getGameImage(game.name).then(imageUrl => {
                gameIcon.src = imageUrl;
            });

            gameCell.appendChild(gameIcon);
            gameCell.append(`${rank}. ${game.name}`);
            scoreCell.textContent = game.score;

            row.appendChild(gameCell);
            row.appendChild(scoreCell);
            tableBody.appendChild(row);
        });
    }

    function renderChart(gamesData) {
        const chartContainer = document.getElementById('chart-container');
        if (!chartContainer) return;

        chartContainer.innerHTML = '';
        const topGames = gamesData.slice(0, 8);
        if (topGames.length === 0) return;

        const maxScore = topGames.length > 0 ? topGames[0].score : 0;

        topGames.forEach((game, index) => {
            const barHeight = maxScore > 0 ? Math.max((game.score / maxScore) * 100, 15) : 0;

            const barGroup = document.createElement('div');
            barGroup.className = 'chart-bar-group';

            const bar = document.createElement('div');
            bar.className = 'chart-bar';
            bar.style.height = `${barHeight}%`;

            const barLabel = document.createElement('div');
            barLabel.className = 'bar-label';
            const crown = index === 0 ? '👑' : '';
            barLabel.textContent = `${game.score} ${crown}`;

            const gameNameLabel = document.createElement('div');
            gameNameLabel.className = 'chart-game-name';
            gameNameLabel.textContent = game.name;

            if (index === 0) barGroup.classList.add('gold');
            else if (index === 1) barGroup.classList.add('silver');
            else if (index === 2) barGroup.classList.add('bronze');

            bar.appendChild(barLabel);
            barGroup.appendChild(bar);
            barGroup.appendChild(gameNameLabel);
            chartContainer.appendChild(barGroup);
        });
    }

    function populateVoterMenu(votes, currentUser) {
        if (!voterSelectMenu) return;
        const currentSelection = voterSelectMenu.value;
        voterSelectMenu.innerHTML = '<option value="">Mon bulletin</option>';
        const sortedVoters = Object.entries(votes).sort((a, b) => a[1].name.localeCompare(b[1].name));
        sortedVoters.forEach(([uid, voteData]) => {
            if (uid === currentUser.uid) return;
            const option = document.createElement('option');
            option.value = uid;
            option.textContent = voteData.name;
            voterSelectMenu.appendChild(option);
        });
        voterSelectMenu.value = currentSelection;
    }

    function renderDashboard(votes, user) {
        const sortedGames = calculateScores(votes);
        populateVoterMenu(votes, user);
        renderKPIs(sortedGames, votes);
        renderTable(sortedGames);
        renderChart(sortedGames);
        renderClosedResults(sortedGames);
        renderWaitingClosed();
        renderActiveLanGames(sortedGames);
        renderActiveLanAllGames(sortedGames);
        renderVoteSuggestions(sortedGames);
    }

    // Jeux déjà proposés par d'autres et absents du bulletin en cours d'édition.
    // Les retaper à la main, c'est risquer une deuxième orthographe du même jeu,
    // donc un score coupé en deux : un clic vaut mieux qu'une saisie.
    function renderVoteSuggestions(sortedGames) {
        const panel = document.getElementById('vote-suggestions');
        const box = document.getElementById('vote-suggestion-chips');
        if (!panel || !box) return;

        const games = sortedGames || calculateScores(globalVotes);

        // Ce qui est déjà dans le formulaire, y compris ce qui vient d'être tapé
        // sans être encore enregistré.
        const alreadyPicked = new Set();
        document.querySelectorAll('#vote-form .game-input-list input').forEach(input => {
            const normalized = normalizeGameName(input.value);
            if (normalized) alreadyPicked.add(normalized);
        });

        const missing = games.filter(game => !alreadyPicked.has(normalizeGameName(game.name)));

        box.innerHTML = '';

        if (missing.length === 0) {
            // Le message va dans la liste, pas dans le panneau : sinon la liste
            // vide, qui s'étire, le repousserait tout en bas du cadre.
            const message = document.createElement('p');
            message.className = 'suggestion-empty';
            message.textContent = games.length === 0
                ? 'Personne n\'a encore proposé de jeu. Ouvrez le bal.'
                : 'Vous avez déjà tous les jeux proposés dans votre bulletin.';
            box.appendChild(message);
            return;
        }

        missing.forEach(game => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'suggestion-chip';
            chip.title = `Ajouter « ${game.name} » à vos Autres`;

            const icon = document.createElement('img');
            icon.src = DEFAULT_GAME_ICON;
            icon.alt = '';
            icon.className = 'suggestion-chip__icon';
            getGameImage(game.name).then(url => { icon.src = url; });
            chip.appendChild(icon);

            chip.append(game.name);

            const score = document.createElement('span');
            score.className = 'suggestion-chip__score';
            score.textContent = `${game.score} pt${game.score > 1 ? 's' : ''}`;
            chip.appendChild(score);

            chip.addEventListener('click', () => addSuggestionToVote(game.name));
            box.appendChild(chip);
        });
    }

    function addSuggestionToVote(gameName) {
        const list = document.querySelector('#vote-form .priority-group[data-priority="p_other"] .game-input-list');
        if (!list) return;

        // Un champ vide traîne souvent en fin de liste : on le remplit plutôt
        // que d'en empiler un nouveau juste en dessous.
        const blank = [...list.querySelectorAll('input')].find(input => !input.value.trim());
        if (blank) {
            blank.value = gameName;
        } else {
            createInput(gameName, list.querySelectorAll('input').length === 0, list);
        }

        isEditing = true;
        renderVoteSuggestions();
        showToast(`« ${gameName} » ajouté à vos Autres. Pensez à soumettre.`);
    }

    // Archive votes snapshot to lan/history when admin closes voting
    function archiveVotesOnClose() {
        const sortedGames = calculateScores(globalVotes);
        if (sortedGames.length === 0) return; // rien à archiver
        const count = globalSettings.topGamesCount || 10;
        const topGames = sortedGames.slice(0, count);
        const lanName = globalSettings.lanName || 'LAN Demain';
        const historyEntry = {
            name: lanName,
            date: new Date().toLocaleDateString('fr-FR'),
            timestamp: firebase.database.ServerValue.TIMESTAMP,
            topGames: topGames,
            votes: globalVotes  // Archive the full vote snapshot for player-votes feature
        };
        // Anti-doublon : si la dernière archive concerne la même LAN et date de moins de 6h
        // (ex: vote fermé/rouvert/refermé), on la remplace au lieu d'en empiler une nouvelle
        const SIX_HOURS = 6 * 60 * 60 * 1000;
        db.ref('lan/history').orderByChild('timestamp').limitToLast(1).once('value')
            .then(snap => {
                const data = snap.val() || {};
                const lastEntry = Object.entries(data)[0];
                const isRecentSameLan = lastEntry
                    && lastEntry[1].name === lanName
                    && (Date.now() - (lastEntry[1].timestamp || 0)) < SIX_HOURS;
                const targetRef = isRecentSameLan
                    ? db.ref('lan/history/' + lastEntry[0])
                    : db.ref('lan/history').push();
                return targetRef.set(historyEntry);
            })
            .then(() => showToast('Résultats archivés dans l\'historique !', 'success'))
            .catch(err => console.error('Archive error:', err));
    }

    // --- SONDAGES ------------------------------------------------------------

    let globalPolls = {};
    const POLL_MAX_OPTIONS = 6;
    // Sondages déjà annoncés, pour ne pas re-notifier à chaque rafraîchissement
    const announcedPolls = new Set();

    // L'état « fermé » se déduit de closesAt : personne n'a besoin d'écrire en
    // base à l'expiration, ce qui éviterait de toute façon une course entre clients.
    function isPollClosed(poll) {
        if (poll.closed) return true;
        return !!poll.closesAt && Date.now() >= poll.closesAt;
    }

    function pollTimeLeft(poll) {
        if (poll.closed) return 'clos';
        if (!poll.closesAt) return 'sans limite';
        const ms = poll.closesAt - Date.now();
        if (ms <= 0) return 'terminé';
        const mins = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        return mins > 0 ? `${mins} min ${secs}s` : `${secs}s`;
    }

    // Un sondage peut viser tout le monde (audience absente) ou une liste de
    // joueurs. Le créateur et les admins le voient toujours, pour pouvoir le gérer.
    function isPollForMe(poll) {
        const user = auth.currentUser;
        if (!user) return false;
        if (!poll.audience) return true;
        if (poll.createdBy === user.uid || window.currentUserIsAdmin) return true;
        return !!poll.audience[user.uid];
    }

    // Joueurs connus : présents en ligne, ou ayant voté
    function knownPlayers() {
        const players = new Map();
        Object.entries(globalUsers || {}).forEach(([uid, u]) => players.set(uid, u.name || 'Joueur'));
        Object.entries(globalVotes || {}).forEach(([uid, v]) => {
            if (!players.has(uid)) players.set(uid, v.name || 'Joueur');
        });
        return [...players.entries()].map(([uid, name]) => ({ uid, name }));
    }

    function renderAudiencePicker() {
        const box = document.getElementById('poll-audience-list');
        if (!box) return;
        const me = auth.currentUser;
        const previous = new Set(
            [...box.querySelectorAll('input:checked')].map(i => i.value)
        );

        box.innerHTML = '';
        knownPlayers()
            .filter(p => !me || p.uid !== me.uid)
            .forEach(p => {
                const label = document.createElement('label');
                label.className = 'poll-audience__choice';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = p.uid;
                cb.checked = previous.has(p.uid);
                label.append(cb, document.createTextNode(' ' + p.name));
                box.appendChild(label);
            });

        if (box.children.length === 0) {
            box.innerHTML = '<span class="tag-menu__empty">Aucun autre joueur connecté.</span>';
        }
        syncCheckedLabels(box);
    }

    // Reflète l'état coché sur le label parent. Une classe, plutôt que
    // :has(input:checked), dont l'invalidation ne suivait pas les changements.
    function syncCheckedLabels(root = document) {
        root.querySelectorAll('.poll-audience__choice, .lib-sub-toggle').forEach(label => {
            const input = label.querySelector('input');
            label.classList.toggle('is-selected', !!(input && input.checked));
        });
    }

    document.addEventListener('change', (e) => {
        if (!e.target.matches('.poll-audience__choice input, .lib-sub-toggle input')) return;
        syncCheckedLabels();

        // Les radios "pour qui" pilotent aussi l'affichage de la liste
        if (e.target.name === 'poll-audience') {
            const box = document.getElementById('poll-audience-list');
            if (!box) return;
            const some = e.target.value === 'some' && e.target.checked;
            box.style.display = some ? 'flex' : 'none';
            if (some) renderAudiencePicker();
        }
    });

    syncCheckedLabels();

    function buildPollOptionInputs(count = 2) {
        const box = document.getElementById('poll-options');
        if (!box) return;
        box.innerHTML = '';
        for (let i = 0; i < count; i++) addPollOptionInput();
    }

    function addPollOptionInput(value = '') {
        const box = document.getElementById('poll-options');
        if (!box) return;
        if (box.children.length >= POLL_MAX_OPTIONS) {
            showToast(`${POLL_MAX_OPTIONS} options maximum.`, 'error');
            return;
        }

        const row = document.createElement('div');
        row.className = 'field-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'luxury-input poll-option-input';
        input.placeholder = `Option ${box.children.length + 1}`;
        input.maxLength = 80;
        input.value = value;
        row.appendChild(input);

        // Les deux premières options sont obligatoires : pas de bouton retirer
        if (box.children.length >= 2) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'danger-link-btn';
            del.textContent = '✕';
            del.addEventListener('click', () => row.remove());
            row.appendChild(del);
        }

        box.appendChild(row);
    }

    document.getElementById('poll-add-option')?.addEventListener('click', () => addPollOptionInput());

    document.getElementById('poll-create')?.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user) return;

        const question = document.getElementById('poll-question').value.trim();
        const options = [...document.querySelectorAll('.poll-option-input')]
            .map(i => i.value.trim())
            .filter(Boolean);

        if (!question) { showToast('Posez une question.', 'error'); return; }
        if (options.length < 2) { showToast('Il faut au moins deux options.', 'error'); return; }

        const minutes = parseInt(document.getElementById('poll-duration').value, 10);
        const optionMap = {};
        options.forEach((label, i) => { optionMap['o' + i] = { label, order: i }; });

        // Audience ciblée : on inclut toujours le créateur, sinon il ne verrait
        // pas son propre sondage
        const scope = document.querySelector('input[name="poll-audience"]:checked')?.value || 'all';
        let audience = null;
        if (scope === 'some') {
            const picked = [...document.querySelectorAll('#poll-audience-list input:checked')].map(i => i.value);
            if (picked.length === 0) { showToast('Choisissez au moins un joueur.', 'error'); return; }
            audience = {};
            picked.forEach(uid => { audience[uid] = true; });
            audience[user.uid] = true;
        }

        try {
            await db.ref('lan/polls').push().set({
                question,
                options: optionMap,
                audience,
                createdBy: user.uid,
                createdByName: user.displayName || 'Un joueur',
                createdAt: firebase.database.ServerValue.TIMESTAMP,
                // closesAt est calculé côté client : à quelques secondes près,
                // c'est sans importance pour un sondage entre amis
                closesAt: minutes > 0 ? Date.now() + minutes * 60000 : null,
                closed: false
            });

            document.getElementById('poll-question').value = '';
            buildPollOptionInputs(2);
            showToast('Sondage lancé !', 'success');
        } catch (error) {
            console.error('Poll create error:', error);
            showToast('Impossible de lancer le sondage : ' + error.message, 'error');
        }
    });

    async function votePoll(pollId, optionId) {
        const user = auth.currentUser;
        if (!user) return;
        try {
            await db.ref(`lan/polls/${pollId}/votes/${user.uid}`).set(optionId);
        } catch (error) {
            showToast('Vote refusé : ' + error.message, 'error');
        }
    }

    function buildPollCard(poll, pollId) {
        const closed = isPollClosed(poll);
        const user = auth.currentUser;
        const votes = poll.votes || {};
        const myVote = user ? votes[user.uid] : null;
        const totalVotes = Object.keys(votes).length;

        const card = document.createElement('div');
        card.className = closed ? 'poll-card poll-card--closed' : 'poll-card';

        const header = document.createElement('div');
        header.className = 'poll-card__header';
        const q = document.createElement('h4');
        q.className = 'poll-card__question';
        q.textContent = poll.question;
        const meta = document.createElement('span');
        meta.className = 'poll-card__meta';
        meta.textContent = closed
            ? `par ${poll.createdByName} · terminé`
            : `par ${poll.createdByName} · ${pollTimeLeft(poll)}`;
        header.append(q, meta);
        card.appendChild(header);

        const options = Object.entries(poll.options || {})
            .map(([id, o]) => ({ id, ...o }))
            .sort((a, b) => (a.order || 0) - (b.order || 0));

        // Qui a voté quoi : les votes sont publics, c'est la moitié du plaisir
        const votersByOption = {};
        Object.entries(votes).forEach(([uid, optId]) => {
            (votersByOption[optId] = votersByOption[optId] || []).push(uid);
        });

        const maxCount = Math.max(1, ...options.map(o => (votersByOption[o.id] || []).length));

        options.forEach(opt => {
            const voters = votersByOption[opt.id] || [];
            const count = voters.length;
            const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;

            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'poll-option';
            if (myVote === opt.id) row.classList.add('poll-option--mine');
            if (closed && count === maxCount && count > 0) row.classList.add('poll-option--winner');
            row.disabled = closed;

            const fill = document.createElement('span');
            fill.className = 'poll-option__fill';
            fill.style.width = `${pct}%`;

            const label = document.createElement('span');
            label.className = 'poll-option__label';
            label.textContent = opt.label;

            const score = document.createElement('span');
            score.className = 'poll-option__score';
            score.textContent = count ? `${count} · ${pct}%` : '—';
            if (!count) score.classList.add('poll-option__score--empty');

            row.append(fill, label, score);

            if (voters.length) {
                const who = document.createElement('span');
                who.className = 'poll-option__voters';
                who.textContent = voters
                    .map(uid => (globalUsers[uid] && globalUsers[uid].name) || (globalVotes[uid] && globalVotes[uid].name) || '?')
                    .join(', ');
                row.appendChild(who);
            }

            if (!closed) row.addEventListener('click', () => votePoll(pollId, opt.id));
            card.appendChild(row);
        });

        const footer = document.createElement('div');
        footer.className = 'poll-card__footer';
        const tally = document.createElement('span');
        tally.className = 'poll-card__meta';
        tally.textContent = `${totalVotes} vote(s)`;
        footer.appendChild(tally);

        // Le créateur et les admins peuvent clore ou supprimer
        const canManage = user && (poll.createdBy === user.uid || window.currentUserIsAdmin);
        if (canManage) {
            if (!closed) {
                const close = document.createElement('button');
                close.className = 'gold-link-btn';
                close.textContent = 'Clore';
                close.addEventListener('click', () => db.ref(`lan/polls/${pollId}/closed`).set(true));
                footer.appendChild(close);
            }
            const del = document.createElement('button');
            del.className = 'danger-link-btn';
            del.textContent = 'Supprimer';
            del.addEventListener('click', () => {
                askConfirm(`Supprimer le sondage « ${poll.question} » ?`, { danger: true }).then(ok => {
                    if (ok) db.ref(`lan/polls/${pollId}`).remove();
                });
            });
            footer.appendChild(del);
        }

        card.appendChild(footer);
        return card;
    }

    function renderPolls() {
        const activeBox = document.getElementById('polls-active');
        const closedBox = document.getElementById('polls-closed');
        const badge = document.getElementById('poll-nav-badge');
        if (!activeBox || !closedBox) return;

        const entries = Object.entries(globalPolls)
            .map(([id, p]) => ({ id, ...p }))
            .filter(isPollForMe)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        const active = entries.filter(p => !isPollClosed(p));
        const closed = entries.filter(p => isPollClosed(p));

        activeBox.innerHTML = '';
        closedBox.innerHTML = '';

        if (active.length === 0) {
            activeBox.innerHTML = '<p style="font-style:italic; color:var(--secondary-text);">Aucun sondage en cours.</p>';
        } else {
            active.forEach(p => activeBox.appendChild(buildPollCard(p, p.id)));
        }

        if (closed.length === 0) {
            closedBox.innerHTML = '<p style="font-style:italic; color:var(--secondary-text);">Rien pour l\'instant.</p>';
        } else {
            closed.slice(0, 20).forEach(p => closedBox.appendChild(buildPollCard(p, p.id)));
        }

        if (badge) {
            badge.textContent = active.length;
            badge.style.display = active.length ? 'inline-flex' : 'none';
        }

        // Les sondages en cours sont aussi utiles pendant la phase de vote :
        // c'est souvent là qu'on décide de la commande.
        const votingMount = document.getElementById('polls-voting-mount');
        if (votingMount) {
            votingMount.innerHTML = '';
            if (active.length === 0) {
                votingMount.style.display = 'none';
            } else {
                votingMount.style.display = '';
                active.forEach(p => votingMount.appendChild(buildPollCard(p, p.id)));
            }
        }

        // Et sur le tableau de bord, où l'on veut voir ce qui se décide
        const dashPanel = document.getElementById('dashboard-polls-panel');
        const dashBox = document.getElementById('dashboard-polls');
        if (dashPanel && dashBox) {
            dashBox.innerHTML = '';
            dashPanel.style.display = active.length ? 'block' : 'none';
            active.forEach(p => dashBox.appendChild(buildPollCard(p, p.id)));
        }
    }

    // Résumé du bar sur le tableau de bord : ce qui attend d'être servi, et
    // les dernières créations proposées.
    function renderCocktailSummary(cocktailsData) {
        const box = document.getElementById('dashboard-cocktails');
        if (!box) return;

        const orders = Object.values(cocktailsData.orders || {});
        const oneshots = Object.entries(cocktailsData.oneshot || {}).map(([id, c]) => ({ id, ...c }));
        const master = Object.keys(cocktailsData.masterList || {}).length;

        box.innerHTML = '';

        const line = (label, value) => {
            const row = document.createElement('div');
            row.className = 'player-row';
            const l = document.createElement('span');
            l.className = 'player-row__name';
            l.textContent = label;
            const v = document.createElement('span');
            v.className = 'player-row__score';
            v.textContent = value;
            row.append(l, v);
            return row;
        };

        box.appendChild(line('Commandes en attente', String(orders.length)));
        box.appendChild(line('Créations proposées', String(oneshots.length)));
        box.appendChild(line('Carte officielle', String(master)));

        if (orders.length) {
            const next = orders.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0];
            const hint = document.createElement('p');
            hint.className = 'panel-section__hint';
            hint.style.marginTop = '10px';
            hint.textContent = `Prochaine : ${next.cocktailName} pour ${next.userName}`;
            box.appendChild(hint);
        }
    }

    // Sondages déjà vus comme clos, pour n'afficher le résultat qu'une fois
    const resolvedPolls = new Set();

    function showPollResult(poll) {
        const modal = document.getElementById('poll-result-modal');
        const body = document.getElementById('poll-result-body');
        if (!modal || !body) return;

        document.getElementById('poll-result-question').textContent = poll.question;

        const votes = poll.votes || {};
        const total = Object.keys(votes).length;
        const counts = {};
        Object.values(votes).forEach(optId => { counts[optId] = (counts[optId] || 0) + 1; });

        const options = Object.entries(poll.options || {})
            .map(([id, o]) => ({ id, ...o, count: counts[id] || 0 }))
            .sort((a, b) => b.count - a.count);

        const best = options.length ? options[0].count : 0;

        body.innerHTML = '';
        options.forEach(opt => {
            const row = document.createElement('div');
            row.className = 'player-row';
            const name = document.createElement('span');
            name.className = 'player-row__name';
            // Égalité possible : on marque tous les premiers ex aequo
            name.textContent = (opt.count === best && best > 0 ? '🏆 ' : '') + opt.label;
            const score = document.createElement('span');
            score.className = 'player-row__score';
            score.textContent = total ? `${opt.count} (${Math.round(opt.count / total * 100)}%)` : '0';
            row.append(name, score);
            body.appendChild(row);
        });

        modal.style.display = 'flex';
    }

    document.getElementById('poll-result-close')?.addEventListener('click', () => {
        const modal = document.getElementById('poll-result-modal');
        if (modal) modal.style.display = 'none';
    });

    document.getElementById('poll-result-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'poll-result-modal') e.currentTarget.style.display = 'none';
    });

    // Affiche le résultat à la clôture. Les notifications ne sont envoyées que
    // par le client du créateur : sinon chaque participant en enverrait un jeu
    // complet et tout le monde recevrait autant de copies qu'il y a de joueurs.
    function handlePollClosures() {
        const user = auth.currentUser;
        if (!user) return;

        Object.entries(globalPolls).forEach(([id, poll]) => {
            if (!isPollClosed(poll)) { resolvedPolls.delete(id); return; }
            if (resolvedPolls.has(id)) return;
            resolvedPolls.add(id);

            // Au chargement, on ne rejoue pas les sondages clos depuis longtemps
            const closedRecently = !poll.closesAt || (Date.now() - poll.closesAt) < 120000;
            if (!closedRecently) return;
            if (!isPollForMe(poll)) return;

            showPollResult(poll);

            if (poll.createdBy === user.uid) {
                const targets = poll.audience
                    ? Object.keys(poll.audience)
                    : knownPlayers().map(p => p.uid);
                const winner = pollWinnerLabel(poll);
                targets
                    .filter(uid => uid !== user.uid)
                    .forEach(uid => sendNotification(uid,
                        `📊 Sondage terminé : « ${poll.question} » → ${winner}`, 'info'));
            }
        });
    }

    function pollWinnerLabel(poll) {
        const votes = poll.votes || {};
        const counts = {};
        Object.values(votes).forEach(optId => { counts[optId] = (counts[optId] || 0) + 1; });
        const options = Object.entries(poll.options || {})
            .map(([id, o]) => ({ id, label: o.label, count: counts[id] || 0 }))
            .sort((a, b) => b.count - a.count);
        if (!options.length || options[0].count === 0) return 'aucun vote';
        const best = options[0].count;
        const winners = options.filter(o => o.count === best).map(o => o.label);
        return winners.length > 1 ? `égalité (${winners.join(', ')})` : winners[0];
    }

    // Un sondage n'a d'intérêt que si on le voit arriver
    function announceNewPolls() {
        const user = auth.currentUser;
        if (!user) return;

        Object.entries(globalPolls).forEach(([id, poll]) => {
            if (announcedPolls.has(id)) return;
            announcedPolls.add(id);

            // On n'annonce ni les anciens sondages au chargement, ni les siens
            const isFresh = poll.createdAt && (Date.now() - poll.createdAt) < 60000;
            if (!isFresh || isPollClosed(poll) || poll.createdBy === user.uid) return;
            if (!isPollForMe(poll)) return;

            showToast(`📊 ${poll.createdByName} lance un sondage : « ${poll.question} »`, 'success');
        });
    }

    // Le compte à rebours doit avancer même sans nouvel événement Firebase.
    // On ne redessine que si un sondage est réellement affiché quelque part.
    setInterval(() => {
        if (!Object.keys(globalPolls).length) return;

        // L'expiration ne déclenche aucun événement Firebase : c'est ici qu'on
        // détecte qu'un sondage vient d'arriver à échéance.
        handlePollClosures();

        const pollsView = document.getElementById('lan-polls');
        const votingMount = document.getElementById('polls-voting-mount');
        const dashPolls = document.getElementById('dashboard-polls-panel');
        const visible = [pollsView, votingMount, dashPolls]
            .some(el => el && el.style.display !== 'none' && el.offsetParent !== null);
        if (visible) renderPolls();
    }, 1000);

    // Le compte à rebours des commandes se met à jour sans reconstruire les
    // cartes : elles contiennent des champs de saisie, et les redessiner
    // effaçait ce qu'on était en train de taper.
    setInterval(() => {
        if (!Object.keys(globalFoodRuns).length) return;
        const view = document.getElementById('lan-food');
        if (!view || view.style.display === 'none' || view.offsetParent === null) return;

        let needsRebuild = false;
        document.querySelectorAll('#food-runs .poll-card[data-run-id]').forEach(card => {
            const run = globalFoodRuns[card.dataset.runId];
            if (!run) return;
            const closed = isRunClosed(run);

            // Passage à l'état clos : là, il faut vraiment redessiner
            if (closed !== (card.dataset.closed === '1')) { needsRebuild = true; return; }

            const meta = card.querySelector('.poll-card__meta');
            if (meta && !closed) {
                meta.textContent = `par ${run.createdByName} · ${pollTimeLeft(run)}`;
            }
        });

        if (needsRebuild) renderFoodRuns();
    }, 1000);

    // --- COMMANDES GROUPEES (BOUFFE) -----------------------------------------

    let globalFoodRuns = {};

    // Même logique que les sondages : l'échéance se déduit, elle ne s'écrit pas
    function isRunClosed(run) {
        if (run.closed) return true;
        return !!run.closesAt && Date.now() >= run.closesAt;
    }

    function formatEuro(n) {
        return `${n.toFixed(2).replace('.', ',')} €`;
    }

    document.getElementById('food-create')?.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user) return;

        const place = document.getElementById('food-place').value.trim();
        if (!place) { showToast('Indiquez où on commande.', 'error'); return; }

        const minutes = parseInt(document.getElementById('food-duration').value, 10);

        try {
            await db.ref('lan/foodRuns').push().set({
                place,
                createdBy: user.uid,
                createdByName: user.displayName || 'Un joueur',
                createdAt: firebase.database.ServerValue.TIMESTAMP,
                closesAt: minutes > 0 ? Date.now() + minutes * 60000 : null,
                closed: false
            });
            document.getElementById('food-place').value = '';
            showToast('Commande ouverte !', 'success');

            // Tout le monde doit savoir qu'on commande, sinon on oublie des gens
            knownPlayers()
                .filter(p => p.uid !== user.uid)
                .forEach(p => sendNotification(p.uid,
                    `🍕 ${user.displayName || 'Quelqu\'un'} lance une commande : ${place}`, 'alert'));
        } catch (error) {
            console.error('Food run error:', error);
            showToast('Impossible d\'ouvrir la commande : ' + error.message, 'error');
        }
    });

    async function addFoodItem(runId, label, price) {
        const user = auth.currentUser;
        if (!user) return;
        await db.ref(`lan/foodRuns/${runId}/items`).push().set({
            userId: user.uid,
            userName: user.displayName || 'Joueur',
            label,
            price
        });
    }

    function buildFoodRunCard(run, runId) {
        const closed = isRunClosed(run);
        const user = auth.currentUser;
        const items = Object.entries(run.items || {}).map(([id, it]) => ({ id, ...it }));

        const card = document.createElement('div');
        card.className = closed ? 'poll-card poll-card--closed' : 'poll-card';
        // Repères pour la mise à jour ciblée du compte à rebours
        card.dataset.runId = runId;
        card.dataset.closed = closed ? '1' : '0';

        const header = document.createElement('div');
        header.className = 'poll-card__header';
        const title = document.createElement('h4');
        title.className = 'poll-card__question';
        title.textContent = `🍕 ${run.place}`;
        const meta = document.createElement('span');
        meta.className = 'poll-card__meta';
        meta.textContent = closed
            ? `par ${run.createdByName} · fermée`
            : `par ${run.createdByName} · ${pollTimeLeft(run)}`;
        header.append(title, meta);
        card.appendChild(header);

        // Regroupé par personne : c'est ce qu'on veut pour savoir qui doit quoi
        const byPerson = new Map();
        items.forEach(it => {
            if (!byPerson.has(it.userId)) byPerson.set(it.userId, { name: it.userName, items: [], total: 0 });
            const entry = byPerson.get(it.userId);
            entry.items.push(it);
            entry.total += Number(it.price) || 0;
        });

        if (byPerson.size === 0) {
            const empty = document.createElement('p');
            empty.className = 'panel-section__hint';
            empty.textContent = 'Personne n\'a encore rien commandé.';
            card.appendChild(empty);
        }

        byPerson.forEach((entry, uid) => {
            const block = document.createElement('div');
            block.className = 'food-person';

            const head = document.createElement('div');
            head.className = 'food-person__head';
            const who = document.createElement('span');
            who.className = 'food-person__name';
            who.textContent = entry.name;
            const tot = document.createElement('span');
            tot.className = 'food-person__total';
            tot.textContent = formatEuro(entry.total);
            head.append(who, tot);
            block.appendChild(head);

            entry.items.forEach(it => {
                const row = document.createElement('div');
                row.className = 'player-row';
                const label = document.createElement('span');
                label.className = 'player-row__name';
                label.textContent = it.label;
                const price = document.createElement('span');
                price.className = 'player-row__score';
                price.textContent = formatEuro(Number(it.price) || 0);
                row.append(label, price);

                // On ne retire que ses propres lignes (ou celles de sa commande)
                const canRemove = !closed && user &&
                    (it.userId === user.uid || run.createdBy === user.uid || window.currentUserIsAdmin);
                if (canRemove) {
                    const del = document.createElement('button');
                    del.className = 'danger-link-btn';
                    del.textContent = '✕';
                    del.style.marginLeft = 'var(--space-3)';
                    del.addEventListener('click', () => db.ref(`lan/foodRuns/${runId}/items/${it.id}`).remove());
                    row.appendChild(del);
                }
                block.appendChild(row);
            });

            card.appendChild(block);
        });

        const grandTotal = items.reduce((sum, it) => sum + (Number(it.price) || 0), 0);

        if (!closed) {
            const form = document.createElement('div');
            form.className = 'field-row food-add';

            const label = document.createElement('input');
            label.type = 'text';
            label.className = 'luxury-input js-food-label';
            label.placeholder = 'Ce que je prends';
            label.maxLength = 80;

            const price = document.createElement('input');
            price.type = 'number';
            price.className = 'luxury-input food-add__price js-food-price';
            price.placeholder = '€';
            price.step = '0.5';
            price.min = '0';

            const add = document.createElement('button');
            add.className = 'gold-btn btn-inline';
            add.textContent = 'Ajouter';

            const submit = async () => {
                const text = label.value.trim();
                if (!text) { showToast('Indiquez ce que vous prenez.', 'error'); return; }
                try {
                    await addFoodItem(runId, text, Number(price.value) || 0);
                    label.value = '';
                    price.value = '';
                    label.focus();
                } catch (error) {
                    showToast('Ajout refusé : ' + error.message, 'error');
                }
            };

            add.addEventListener('click', submit);
            label.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
            price.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

            form.append(label, price, add);
            card.appendChild(form);
        }

        const footer = document.createElement('div');
        footer.className = 'poll-card__footer';
        const total = document.createElement('span');
        total.className = 'food-total';
        total.textContent = `Total : ${formatEuro(grandTotal)} · ${items.length} article(s)`;
        footer.appendChild(total);

        const canManage = user && (run.createdBy === user.uid || window.currentUserIsAdmin);
        if (canManage) {
            if (!closed) {
                const close = document.createElement('button');
                close.className = 'gold-link-btn';
                close.textContent = 'Clore';
                close.addEventListener('click', () => db.ref(`lan/foodRuns/${runId}/closed`).set(true));
                footer.appendChild(close);
            }
            const del = document.createElement('button');
            del.className = 'danger-link-btn';
            del.textContent = 'Supprimer';
            del.addEventListener('click', () => {
                askConfirm(`Supprimer la commande « ${run.place} » ?`, { danger: true }).then(ok => {
                    if (ok) db.ref(`lan/foodRuns/${runId}`).remove();
                });
            });
            footer.appendChild(del);
        }

        card.appendChild(footer);
        return card;
    }

    function renderFoodRuns() {
        const box = document.getElementById('food-runs');
        const badge = document.getElementById('food-nav-badge');
        if (!box) return;

        const runs = Object.entries(globalFoodRuns)
            .map(([id, r]) => ({ id, ...r }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        const open = runs.filter(r => !isRunClosed(r));

        // Quand quelqu'un d'autre ajoute une ligne, la carte est reconstruite :
        // on rend d'abord ce qui était en cours de saisie, puis on le restaure.
        const drafts = {};
        let focusedRun = null;
        let focusedField = null;
        box.querySelectorAll('.poll-card[data-run-id]').forEach(card => {
            const id = card.dataset.runId;
            const label = card.querySelector('.js-food-label');
            const price = card.querySelector('.js-food-price');
            if (!label && !price) return;
            drafts[id] = { label: label ? label.value : '', price: price ? price.value : '' };
            if (document.activeElement === label) { focusedRun = id; focusedField = 'label'; }
            if (document.activeElement === price) { focusedRun = id; focusedField = 'price'; }
        });

        box.innerHTML = '';
        if (runs.length === 0) {
            box.innerHTML = '<p style="font-style:italic; color:var(--secondary-text);">Aucune commande pour l\'instant.</p>';
        } else {
            runs.slice(0, 10).forEach(r => box.appendChild(buildFoodRunCard(r, r.id)));
        }

        Object.entries(drafts).forEach(([id, draft]) => {
            const card = box.querySelector(`.poll-card[data-run-id="${id}"]`);
            if (!card) return;
            const label = card.querySelector('.js-food-label');
            const price = card.querySelector('.js-food-price');
            if (label) label.value = draft.label;
            if (price) price.value = draft.price;
            if (id === focusedRun) {
                const field = focusedField === 'price' ? price : label;
                if (field) {
                    field.focus();
                    // selectionStart n'existe pas sur un <input type="number">
                    try { field.selectionStart = field.selectionEnd = field.value.length; } catch (e) { /* ignoré */ }
                }
            }
        });

        if (badge) {
            badge.textContent = open.length;
            badge.style.display = open.length ? 'inline-flex' : 'none';
        }
    }

    // --- FIN DE LA LAN (bilan) -----------------------------------------------

    // Clôturer n'efface rien : on bascule seulement dans un état "terminée",
    // pour pouvoir relire la soirée avant de décider d'en lancer une autre.
    document.getElementById('btn-finish-lan')?.addEventListener('click', async () => {
        const ok = await askConfirm(
            "Terminer la soirée et afficher le bilan à tout le monde ? Aucune donnée n'est effacée.",
            { title: '🏁 Clôturer la LAN', confirmLabel: 'Clôturer' }
        );
        if (!ok) return;

        try {
            await db.ref('lan/settings').update({
                isLanActive: false,
                lanFinished: true,
                lanClosedAt: firebase.database.ServerValue.TIMESTAMP
            });
            showToast('La LAN est terminée. Bilan affiché pour tout le monde.', 'success');

            knownPlayers()
                .filter(p => p.uid !== auth.currentUser?.uid)
                .forEach(p => sendNotification(p.uid, '🏁 La LAN est terminée, le bilan est affiché !', 'alert'));
        } catch (error) {
            showToast('Impossible de clôturer : ' + error.message, 'error');
        }
    });

    document.getElementById('recap-reopen-lan')?.addEventListener('click', async () => {
        const ok = await askConfirm("Rouvrir cette LAN ? Tout le monde repasse en mode soirée.",
            { title: 'Rouvrir la LAN', confirmLabel: 'Rouvrir' });
        if (!ok) return;
        await db.ref('lan/settings').update({ isLanActive: true, lanFinished: false });
        showToast('LAN rouverte.', 'success');
    });

    document.getElementById('recap-new-lan')?.addEventListener('click', async () => {
        const input = document.getElementById('recap-new-lan-name');
        const newName = (input?.value || '').trim();

        const ok = await askConfirm(
            "Archiver cette soirée et repartir de zéro ? Les votes, événements, kocktails, sondages, commandes et bibliothèques seront effacés.",
            { title: '🎉 Nouvelle LAN', danger: true, confirmLabel: 'Démarrer' }
        );
        if (!ok) return;

        try {
            desktopAdminOverride = false;
            const archived = await startNewLan(newName);
            await db.ref('lan/settings').update({ lanFinished: false });
            if (input) input.value = '';
            showToast(archived > 0
                ? `Nouvelle LAN lancée ! ${archived} jeux archivés.`
                : 'Nouvelle LAN lancée !', 'success');
        } catch (error) {
            showToast('Impossible de démarrer : ' + error.message, 'error');
        }
    });

    // Les données du bilan arrivent par listeners séparés : on rafraîchit
    // tant que l'écran est affiché.
    function refreshRecapIfVisible() {
        const view = document.getElementById('view-lan-finished');
        if (view && view.style.display !== 'none') renderLanRecap();
    }

    function statLine(label, value) {
        const row = document.createElement('div');
        row.className = 'player-row';
        const l = document.createElement('span');
        l.className = 'player-row__name';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'player-row__score';
        v.textContent = value;
        row.append(l, v);
        return row;
    }

    // Le bilan est calculé à la volée : rien n'ayant été effacé à la clôture,
    // toutes les données de la soirée sont encore en base.
    function renderLanRecap() {
        const view = document.getElementById('view-lan-finished');
        if (!view) return;

        const lanName = globalSettings.lanName || 'LAN Demain';
        document.getElementById('recap-title').textContent = lanName;
        const sealDate = document.getElementById('recap-seal-date');
        if (sealDate) {
            sealDate.textContent = globalSettings.lanClosedAt
                ? new Date(globalSettings.lanClosedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
                : 'ARCHIVÉE';
        }

        const sorted = calculateScores(globalVotes);
        const voterCount = Object.keys(globalVotes || {}).length;

        const subtitle = document.getElementById('recap-subtitle');
        subtitle.textContent = sorted.length
            ? `${voterCount} joueur(s), ${sorted.length} jeux proposés. Le grand gagnant : ${sorted[0].name}.`
            : `${voterCount} joueur(s). Aucun vote enregistré.`;

        const podium = document.getElementById('recap-podium');
        podium.innerHTML = '';
        if (sorted.length === 0) {
            podium.innerHTML = '<p style="font-style:italic; color:var(--secondary-text);">Aucun vote pour cette soirée.</p>';
        } else {
            sorted.slice(0, 5).forEach((game, i) => podium.appendChild(buildRankRow(game, i + 1)));
        }

        const cocktails = window._latestCocktailsData || {};
        const events = window._latestEventsData || {};
        const foodItems = Object.values(globalFoodRuns)
            .flatMap(run => Object.values(run.items || {}));
        const foodTotal = foodItems.reduce((sum, it) => sum + (Number(it.price) || 0), 0);

        const stats = document.getElementById('recap-stats');
        stats.innerHTML = '';
        stats.appendChild(statLine('Votants', String(voterCount)));
        stats.appendChild(statLine('Jeux proposés', String(sorted.length)));
        stats.appendChild(statLine('Événements organisés', String(Object.keys(events).length)));
        stats.appendChild(statLine('Créations kocktails', String(Object.keys(cocktails.oneshot || {}).length)));
        stats.appendChild(statLine('Sondages lancés', String(Object.keys(globalPolls).length)));
        stats.appendChild(statLine('Commandes groupées', String(Object.keys(globalFoodRuns).length)));
        if (foodItems.length) {
            stats.appendChild(statLine('Total bouffe', `${foodTotal.toFixed(2).replace('.', ',')} €`));
        }
        if (globalSettings.lanClosedAt) {
            stats.appendChild(statLine('Terminée', new Date(globalSettings.lanClosedAt).toLocaleString('fr-FR')));
        }

        const adminBox = document.getElementById('recap-admin');
        if (adminBox) adminBox.style.display = window.currentUserIsAdmin ? 'grid' : 'none';
    }

    // --- NOUVELLE LAN --------------------------------------------------------

    // Archive le classement en cours puis remet le cycle à zéro : votes effacés,
    // votes rouverts, LAN active désactivée. On ne touche ni aux événements, ni
    // aux kocktails, ni aux bibliothèques Steam : ils survivent d'une LAN à l'autre.
    /* Le palmarès des collections, tel qu'on veut le relire dans un an : le nom
       du set, et pour chaque joueur ce qu'il en avait. On n'archive ni les
       paquets ni les illustrations — les uns se rejouent, les autres pèsent des
       mégaoctets et restent de toute façon dans `lan/cardArt`. */
    function tcgStandingsForArchive() {
        const set = tcgCurrentSet(globalTcg);
        if (!set) return null;
        const cards = tcgCards(globalTcg);
        const board = tcgLeaderboard(set.cards || {}, cards, economyPlayers())
            .map(row => ({
                name: playerLabel(row.uid),
                owned: row.owned,
                total: row.total,
                foils: row.foils
            }));
        if (!board.length) return null;
        return { setName: set.name || '', standings: board };
    }


    /* La clôture est le seul moment où l'expérience bouge en bloc : chacun
       touche sa soirée, et les titres comparatifs sont enfin décernables —
       jusque-là ils auraient changé de main à chaque achat.

       `lan/xp` n'est PAS effacé par la suite : c'est tout l'intérêt. Les points
       mesurent une soirée, l'expérience mesure les soirées. */
    async function awardLanExperience(lanId) {
        const data = {
            economy: globalEconomy,
            tcg: globalTcg,
            cards: tcgCards(globalTcg),
            xp: globalXp,
            history: globalHistory,
            votes: globalVotes,
            settings: globalSettings,
            quests: globalQuests,
            profiles: globalProfiles
        };

        const players = economyPlayers();
        const writes = [];
        const titles = [];

        /* Être venu suffit : c'est la récompense de l'assiduité, celle que ni
           la fortune ni la collection ne mesurent. On la donne à ceux qui ont
           voté — la seule trace fiable d'une présence à la soirée. */
        Object.keys(globalVotes || {}).forEach(uid => {
            const awardId = attendanceAwardId(uid, lanId);
            if (hasXpAward(globalXp, awardId)) return;
            writes.push(db.ref('lan/xp/awards/' + awardId).set({
                uid: uid,
                delta: XP.LAN_ATTENDANCE,
                type: 'attendance',
                reason: previousLanLabel(),
                refId: lanId,
                by: (auth.currentUser && auth.currentUser.uid) || null,
                ts: firebase.database.ServerValue.TIMESTAMP
            }));
        });

        lanTitles(data, players).forEach(entry => {
            const awardId = entry.uid + '__title__' + lanId + '__' + entry.title.id;
            titles.push({ id: entry.title.id, label: entry.title.label, name: playerLabel(entry.uid), value: entry.value });
            if (hasXpAward(globalXp, awardId)) return;
            writes.push(db.ref('lan/xp/awards/' + awardId).set({
                uid: entry.uid,
                delta: entry.title.xp,
                type: 'title',
                reason: entry.title.label,
                refId: lanId,
                by: (auth.currentUser && auth.currentUser.uid) || null,
                ts: firebase.database.ServerValue.TIMESTAMP
            }));
        });

        /* Une écriture refusée ne doit pas empêcher la clôture : la soirée doit
           se fermer même si l'expérience d'un joueur passe à la trappe. */
        await Promise.allSettled(writes);
        return titles;
    }

    function previousLanLabel() {
        return globalSettings.lanName ? 'Soirée ' + globalSettings.lanName : 'Une soirée de plus';
    }

    async function startNewLan(newName) {
        const sortedGames = calculateScores(globalVotes);
        const previousName = globalSettings.lanName || 'LAN Demain';

        // Tout ce qui appartient à une soirée est archivé avec elle, puis effacé :
        // sans ça, la nouvelle LAN héritait des événements et des kocktails
        // de la précédente.
        const [eventsSnap, cocktailsSnap, economySnap] = await Promise.all([
            db.ref('lan/events').once('value'),
            db.ref('lan/cocktails/oneshot').once('value'),
            db.ref('lan/economy').once('value')
        ]);

        // Le classement des fortunes part avec la soirée : c'est un palmarès,
        // pas un solde. On l'archive avant d'effacer, sinon il n'en resterait
        // aucune trace nulle part.
        const previousEconomy = economySnap.val() || {};
        const finalStandings = economyLeaderboard(previousEconomy, economyPlayers())
            .map(row => ({ name: playerLabel(row.uid), balance: row.balance }));

        const hadContent = sortedGames.length > 0 || eventsSnap.exists() || cocktailsSnap.exists()
            || finalStandings.length > 0;

        /* L'expérience se distribue AVANT l'effacement : les titres se
           calculent sur les compteurs de la soirée, qui n'existent plus une
           ligne plus bas. L'identifiant vient de l'horodatage, ce qui rend les
           clés déterministes — reclôturer deux fois ne paie pas deux fois. */
        const lanId = 'lan-' + Date.now();
        const awardedTitles = hadContent ? await awardLanExperience(lanId) : [];

        if (hadContent) {
            await db.ref('lan/history').push().set({
                name: previousName,
                date: new Date().toLocaleDateString('fr-FR'),
                timestamp: firebase.database.ServerValue.TIMESTAMP,
                topGames: sortedGames.slice(0, globalSettings.topGamesCount || 10),
                votes: globalVotes,
                events: eventsSnap.val() || null,
                oneshotCocktails: cocktailsSnap.val() || null,
                economyStandings: finalStandings.length ? finalStandings : null,
                // Ce que la soirée a laissé en cartes. Tant que la LAN tourne,
                // une collection est un brouillon qu'on peut jeter en
                // recomposant le set ; à la clôture, elle devient un souvenir
                // et c'est ici qu'elle est gardée.
                tcgStandings: tcgStandingsForArchive(),
                // Les titres décernés ce soir-là. Ils ne se recalculent pas
                // après coup — les compteurs qui les ont produits sont effacés
                // trois lignes plus bas.
                lanTitles: awardedTitles.length ? awardedTitles : null
            });
        }

        // Seule la carte officielle des kocktails survit : c'est un acquis
        // curé par les admins. Les bibliothèques, elles, bougent entre deux
        // soirées (achats, abonnements), donc on repart d'une liste fraîche.
        // La boutique suit la même règle que le bar : la carte des articles
        // reste — elle s'est construite au fil des soirées — mais les soldes,
        // le registre, les compteurs de présence et les demandes repartent de
        // zéro. Une fortune se gagne dans une soirée, elle ne se transporte pas.
        await Promise.all([
            db.ref('lan/votes').remove(),
            db.ref('lan/events').remove(),
            db.ref('lan/cocktails/oneshot').remove(),
            db.ref('lan/cocktails/orders').remove(),
            db.ref('lan/polls').remove(),
            db.ref('lan/foodRuns').remove(),
            db.ref('lan/steamLibraries').remove(),
            // Une soirée s'installe pour ses jeux à elle : les coches de la
            // précédente annonceraient des jeux prêts qui ne le sont plus.
            db.ref('lan/installed').remove(),
            db.ref('lan/economy/ledger').remove(),
            db.ref('lan/economy/ticks').remove(),
            db.ref('lan/economy/purchases').remove(),
            // Une réclamation appartient à la soirée où elle a été faite. Les
            // laisser traîner, c'était une file « à valider » jamais vide et
            // une pastille de rail qui ne s'éteignait plus. L'expérience
            // gagnée, elle, reste : elle vit dans lan/xp/awards.
            db.ref('lan/claims').remove()
        ]);

        // lanFinished doit retomber ici : sinon la nouvelle soirée s'ouvrirait
        // directement sur le bilan de la précédente.
        const settings = { isVotingOpen: true, isLanActive: false, lanFinished: false };
        if (newName) settings.lanName = newName;
        await db.ref('lan/settings').update(settings);

        return sortedGames.length;
    }

    document.getElementById('btn-new-lan')?.addEventListener('click', async () => {
        const input = document.getElementById('new-lan-name');
        const newName = (input?.value || '').trim();

        const ok = await askConfirm(
            "Archiver la soirée en cours (classement, événements, créations kocktails, sondages, commandes) puis repartir de zéro ? Les bibliothèques Steam sont également effacées. La carte officielle des kocktails est conservée, ainsi que les cartes à collectionner : une collection ne se réinitialise pas.",
            { title: '🎉 Nouvelle LAN', danger: true, confirmLabel: 'Démarrer' }
        );
        if (!ok) return;

        try {
            desktopAdminOverride = false;
            const archived = await startNewLan(newName);
            if (input) input.value = '';
            showToast(archived > 0
                ? `Nouvelle LAN lancée ! ${archived} jeux archivés dans l'historique.`
                : 'Nouvelle LAN lancée ! Les votes sont ouverts.', 'success');
        } catch (error) {
            console.error('New LAN error:', error);
            showToast('Impossible de démarrer une nouvelle LAN : ' + error.message, 'error');
        }
    });

    // --- FICHE JEU STEAM ---------------------------------------------------

    const detailsCache = new Map();

    // Les détails sont mis en cache côté client en plus du CDN : une même partie
    // affiche le même jeu dans plusieurs listes.
    async function getGameDetails(gameName) {
        const key = gameName.toLowerCase().trim();
        if (detailsCache.has(key)) return detailsCache.get(key);

        const promise = (async () => {
            try {
                const res = await fetch(`/api/game-details?name=${encodeURIComponent(key)}`);
                if (!res.ok) return null;
                return await res.json();
            } catch (error) {
                console.error('Game details error:', error);
                return null;
            }
        })();

        detailsCache.set(key, promise);
        return promise;
    }

    // hls.js n'est chargé qu'à l'ouverture d'une première bande-annonce :
    // inutile de le faire payer à tous les visiteurs au chargement de la page.
    let hlsLoader = null;
    function loadHls() {
        if (window.Hls) return Promise.resolve(window.Hls);
        if (hlsLoader) return hlsLoader;

        hlsLoader = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
            // SRI : le CDN ne peut pas nous servir un hls.js altéré sans que le
            // navigateur refuse de l'exécuter.
            script.integrity = 'sha384-9v3HcdYrO3D+OPDTjZ40RXocgE4GtXVCd3/mCS62JsM93JXgI1afJVuwjFvsu6ni';
            script.crossOrigin = 'anonymous';
            script.onload = () => resolve(window.Hls);
            script.onerror = () => reject(new Error('hls.js indisponible'));
            document.head.appendChild(script);
        });
        return hlsLoader;
    }

    const wikiCache = new Map();

    // Repli pour les jeux absents de Steam (LoL, Fortnite, Riftbound…)
    async function getWikiInfo(gameName) {
        const key = gameName.toLowerCase().trim();
        if (wikiCache.has(key)) return wikiCache.get(key);

        const promise = (async () => {
            try {
                const res = await fetch(`/api/game-wiki?name=${encodeURIComponent(gameName)}`);
                if (!res.ok) return null;
                return await res.json();
            } catch (error) {
                console.error('Wiki error:', error);
                return null;
            }
        })();

        wikiCache.set(key, promise);
        return promise;
    }

    // Prix multi-boutiques via IsThereAnyDeal
    async function getDeals({ appId, title }) {
        try {
            const query = appId ? `appid=${encodeURIComponent(appId)}` : `title=${encodeURIComponent(title)}`;
            const res = await fetch(`/api/game-deals?${query}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (error) {
            console.error('Deals error:', error);
            return null;
        }
    }

    function renderDeals(data) {
        const box = document.getElementById('game-details-deals');
        const list = document.getElementById('game-details-deals-list');
        const low = document.getElementById('game-details-lowest');
        if (!box || !list) return;

        list.innerHTML = '';

        if (!data || !data.found || !data.deals || data.deals.length === 0) {
            box.style.display = 'none';
            return;
        }

        low.textContent = data.historyLow != null
            ? `Plus bas historique : ${data.historyLow.toFixed(2)} €`
            : '';

        data.deals.forEach((deal, index) => {
            const row = document.createElement('a');
            row.className = index === 0 ? 'deal-row deal-row--best' : 'deal-row';
            // Apparition en cascade : les prix se posent l'un après l'autre
            row.classList.add('fade-in-up');
            row.style.setProperty('--stagger', `${index * 0.05}s`);
            row.href = safeHttpUrl(deal.url);
            row.target = '_blank';
            row.rel = 'noopener noreferrer';

            const shop = document.createElement('span');
            shop.className = 'deal-row__shop';
            shop.textContent = deal.shop;

            const cut = document.createElement('span');
            if (deal.cut > 0) {
                cut.className = 'deal-row__cut';
                cut.textContent = `-${deal.cut}%`;
            }

            const price = document.createElement('span');
            price.className = 'deal-row__price';
            // « 0.00 € » se lit mal pour un free-to-play
            price.textContent = deal.price === 0 ? 'Gratuit' : `${deal.price.toFixed(2)} €`;

            row.append(shop, cut, price);
            list.appendChild(row);
        });

        box.style.display = 'block';
    }

    function renderTags(container, details, limit = 4) {
        container.innerHTML = '';
        if (!details) return;
        const tags = [...(details.genres || []), ...(details.categories || [])].slice(0, limit);
        tags.forEach(label => {
            const chip = document.createElement('span');
            chip.className = 'tag';
            chip.textContent = label;
            container.appendChild(chip);
        });
    }

    // --- CONFIRMATION --------------------------------------------------------

    // Remplace confirm() : le dialogue natif jure avec le reste de l'interface
    // et bloque le rendu de la page tant qu'il est ouvert.
    let confirmResolver = null;

    function askConfirm(message, { title = 'Confirmer', danger = false, confirmLabel = null } = {}) {
        const modal = document.getElementById('confirm-modal');
        // Repli si la modale manque : mieux vaut le dialogue natif que rien
        if (!modal) return Promise.resolve(window.confirm(message));

        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;

        const accept = document.getElementById('confirm-accept');
        // .gold-btn impose son dégradé en !important : le garder en même temps
        // que .danger-btn donnait un bouton doré délavé au texte rouge illisible.
        accept.classList.toggle('gold-btn', !danger);
        accept.classList.toggle('danger-btn', danger);
        // « Supprimer » par défaut sur une action destructive, mais certaines
        // (démarrer une nouvelle LAN) méritent un libellé propre
        accept.textContent = confirmLabel || (danger ? 'Supprimer' : 'Confirmer');

        modal.style.display = 'flex';
        accept.focus();

        return new Promise(resolve => { confirmResolver = resolve; });
    }

    function closeConfirm(result) {
        const modal = document.getElementById('confirm-modal');
        if (modal) modal.style.display = 'none';
        if (confirmResolver) {
            confirmResolver(result);
            confirmResolver = null;
        }
    }

    document.getElementById('confirm-accept')?.addEventListener('click', () => closeConfirm(true));
    document.getElementById('confirm-cancel')?.addEventListener('click', () => closeConfirm(false));
    document.getElementById('confirm-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'confirm-modal') closeConfirm(false);
    });
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('confirm-modal');
        if (!modal || modal.style.display !== 'flex') return;
        if (e.key === 'Escape') closeConfirm(false);
        if (e.key === 'Enter') closeConfirm(true);
    });

    // --- CORRECTION DU NOM D'UN JEU (admin) --------------------------------

    let renameTarget = null;

    // Réécrit le nom dans les votes de tous les joueurs. Les jeux n'ont pas
    // d'entrée propre en base : ils n'existent que comme chaînes dans les
    // tableaux de votes, donc il faut parcourir chaque vote.
    async function renameGameEverywhere(oldName, newName) {
        const oldKey = normalizeGameName(oldName);
        const snapshot = await db.ref('lan/votes').once('value');
        const votes = snapshot.val() || {};

        const updates = {};
        let occurrences = 0;

        for (const userId in votes) {
            const voteData = votes[userId];
            if (!voteData || !voteData.votes) continue;

            for (const priority in voteData.votes) {
                const games = voteData.votes[priority];
                if (!Array.isArray(games)) continue;

                let touched = false;
                const next = games.map(game => {
                    if (normalizeGameName(game) === oldKey) {
                        touched = true;
                        occurrences++;
                        return newName;
                    }
                    return game;
                });

                if (touched) updates[`lan/votes/${userId}/votes/${priority}`] = next;
            }
        }

        if (occurrences === 0) return 0;
        await db.ref().update(updates);
        return occurrences;
    }

    function openRenameGame(gameName) {
        const modal = document.getElementById('rename-game-modal');
        if (!modal) return;
        renameTarget = gameName;
        document.getElementById('rename-game-current').textContent = `Nom actuel : « ${gameName} »`;
        const input = document.getElementById('rename-game-input');
        input.value = gameName;
        modal.style.display = 'flex';
        input.focus();
        input.select();
    }

    function closeRenameGame() {
        const modal = document.getElementById('rename-game-modal');
        if (modal) modal.style.display = 'none';
        renameTarget = null;
    }

    document.getElementById('cancel-rename-game')?.addEventListener('click', closeRenameGame);

    document.getElementById('rename-game-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'rename-game-modal') closeRenameGame();
    });

    document.getElementById('rename-game-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('confirm-rename-game')?.click();
        if (e.key === 'Escape') closeRenameGame();
    });

    document.getElementById('confirm-rename-game')?.addEventListener('click', async () => {
        const input = document.getElementById('rename-game-input');
        const newName = input.value.trim().replace(/\s+/g, ' ');

        if (!renameTarget) return;
        if (!newName) { showToast('Le nom ne peut pas être vide.', 'error'); return; }
        if (newName === renameTarget) { closeRenameGame(); return; }

        const previous = renameTarget;
        closeRenameGame();

        try {
            const count = await renameGameEverywhere(previous, newName);
            if (count === 0) {
                showToast('Aucun vote ne correspondait à ce jeu.', 'error');
            } else {
                showToast(`« ${newName} » corrigé dans ${count} vote(s).`, 'success');
                // la vignette et la fiche dépendent du nom : on vide les caches,
                // y compris la copie persistée dans localStorage
                imageCache.delete(previous.toLowerCase().trim());
                detailsCache.delete(previous.toLowerCase().trim());
                wikiCache.delete(previous.toLowerCase().trim());
                persistImageStore();
            }
        } catch (error) {
            console.error('Rename error:', error);
            showToast('Correction refusée : ' + error.message, 'error');
        }
    });

    let currentHls = null;

    // Le bouton « Ajouter à mon vote » de la fiche : visible seulement pendant
    // la phase de vote, et rattaché au jeu actuellement affiché.
    function setupGameCardVoteButton(gameName) {
        const btn = document.getElementById('game-details-add-vote');
        if (!btn) return;

        const canVote = globalSettings.isVotingOpen && !!document.getElementById('vote-form');
        btn.style.display = canVote ? 'block' : 'none';
        if (!canVote) return;

        btn.textContent = `➕ Ajouter « ${gameName} » à mon vote`;
        // onclick (et non addEventListener) : réécrit à chaque ouverture,
        // donc aucun risque d'empiler les gestionnaires des fiches précédentes
        btn.onclick = () => {
            addGameToVote(gameName);
            document.getElementById('close-game-details-btn')?.click();
        };
    }

    // Fiche pour un jeu absent de Steam : infos Wikipédia, pas de tags Steam,
    // mais on tente quand même le comparateur de prix par titre.
    function renderWikiCard(gameName, wiki) {
        const body = document.getElementById('game-details-body');

        document.getElementById('game-details-title').textContent = wiki.title || gameName;
        document.getElementById('game-details-desc').textContent = wiki.description || '';
        document.getElementById('game-details-tags').innerHTML = '';

        const notice = document.getElementById('game-details-notice');
        notice.textContent = `Pas disponible sur Steam : informations issues de Wikipédia${wiki.lang === 'en' ? ' (en anglais)' : ''}.`;
        notice.style.display = 'block';

        const media = document.getElementById('game-details-media');
        media.innerHTML = '';
        if (wiki.image) {
            const img = document.createElement('img');
            img.src = wiki.image;
            img.alt = '';
            media.appendChild(img);
        }

        document.getElementById('game-details-price').textContent = '';

        const storeQuery = encodeURIComponent(wiki.title || gameName);
        const steamLink = document.getElementById('game-details-link');
        steamLink.href = safeHttpUrl(wiki.url);
        steamLink.textContent = 'Wikipédia';
        document.getElementById('game-details-ig').href =
            `https://www.instant-gaming.com/fr/rechercher/?q=${storeQuery}`;
        document.getElementById('game-details-itad').href =
            `https://isthereanydeal.com/search/?q=${storeQuery}`;

        renderDeals(null);
        getDeals({ title: wiki.title || gameName }).then(renderDeals);

        // On vote pour le nom tel qu'il figure dans la LAN, pas le titre Wikipédia
        setupGameCardVoteButton(gameName);

        body.style.display = 'block';
    }

    async function openGameDetails(gameName) {
        const modal = document.getElementById('game-details-modal');
        if (!modal) return;

        const loading = document.getElementById('game-details-loading');
        const body = document.getElementById('game-details-body');
        const errorBox = document.getElementById('game-details-error');

        // La fiche s'ouvre tout de suite avec ce qu'on sait déjà (le nom) : attendre
        // Steam avant d'afficher quoi que ce soit donnait une impression de lenteur.
        modal.style.display = 'flex';
        errorBox.style.display = 'none';
        body.style.display = 'block';
        loading.style.display = 'none';

        document.getElementById('game-details-title').textContent = gameName;

        // On retire fade-in avant de re-remplir, sinon l'animation ne rejoue
        // pas à la deuxième ouverture (la classe est déjà présente)
        const descBox = document.getElementById('game-details-desc');
        const tagsBox = document.getElementById('game-details-tags');
        descBox.classList.remove('fade-in');
        tagsBox.classList.remove('fade-in');
        descBox.innerHTML = '<span class="skeleton-line"></span><span class="skeleton-line"></span>';
        tagsBox.innerHTML = '';
        document.getElementById('game-details-notice').style.display = 'none';
        document.getElementById('game-details-price').textContent = '';
        renderDeals(null);

        // Vignette connue : elle occupe le cadre pendant le chargement
        const mediaBox = document.getElementById('game-details-media');
        const known = getCachedGameImage(gameName);
        mediaBox.innerHTML = '';
        if (known && known !== DEFAULT_GAME_ICON) {
            const preview = document.createElement('img');
            preview.src = known;
            preview.alt = '';
            preview.className = 'fade-in';
            mediaBox.appendChild(preview);
        } else {
            mediaBox.innerHTML = '<div class="skeleton-media"></div>';
        }

        const details = await getGameDetails(gameName);

        // Pas de correspondance exacte sur Steam : on bascule sur Wikipédia
        // plutôt que d'afficher la fiche d'un autre jeu.
        if (!details || !details.exactMatch) {
            const wiki = await getWikiInfo(gameName);
            loading.style.display = 'none';

            if (!wiki || !wiki.found) {
                // la coquille affichait des squelettes : on la retire
                body.style.display = 'none';
                errorBox.style.display = 'block';
                return;
            }
            renderWikiCard(gameName, wiki);
            return;
        }

        loading.style.display = 'none';

        document.getElementById('game-details-title').textContent = details.name || gameName;

        const desc = document.getElementById('game-details-desc');
        desc.textContent = details.shortDescription || '';
        desc.classList.add('fade-in');

        const tagBox = document.getElementById('game-details-tags');
        renderTags(tagBox, details, 8);
        tagBox.classList.add('fade-in');

        document.getElementById('game-details-notice').style.display = 'none';

        // Les prix arrivent après coup : la fiche s'affiche sans attendre
        renderDeals(null);
        getDeals({ appId: details.appId }).then(renderDeals);

        // Le nom officiel Steam est le meilleur candidat pour le vote
        setupGameCardVoteButton(details.name || gameName);

        // Steam ne sert la bande-annonce qu'en HLS. Attention : Chrome répond
        // "maybe" à canPlayType pour ce type MIME alors qu'il ne sait pas le lire
        // (le lecteur reste bloqué à readyState 0). Seul "probably" (Safari)
        // indique un vrai support ; ailleurs on affiche l'image fixe.
        const media = document.getElementById('game-details-media');
        media.innerHTML = '';
        const trailer = details.trailer;
        const still = (trailer && trailer.thumbnail) || details.headerImage;

        const showStill = () => {
            media.innerHTML = '';
            if (!still) return;
            const img = document.createElement('img');
            img.src = still;
            img.alt = '';
            media.appendChild(img);
        };

        const nativeHls = document.createElement('video')
            .canPlayType('application/vnd.apple.mpegurl') === 'probably';

        if (trailer && trailer.hls) {
            const video = document.createElement('video');
            video.controls = true;
            video.preload = 'metadata';
            if (trailer.thumbnail) video.poster = trailer.thumbnail;
            video.addEventListener('error', showStill);
            media.appendChild(video);

            if (nativeHls) {
                video.src = trailer.hls;
            } else {
                // Chrome et Firefox ne lisent pas le HLS nativement : hls.js
                // rattache le flux au <video>. En cas d'échec, on retombe sur l'image.
                loadHls().then(Hls => {
                    if (!Hls || !Hls.isSupported()) { showStill(); return; }
                    const hls = new Hls();

                    // Hls.isSupported() ne vérifie que la présence de MediaSource.
                    // Certains environnements l'exposent sans que « sourceopen » ne
                    // se déclenche jamais : aucune erreur n'est émise et le lecteur
                    // reste noir. Ce délai garantit qu'on retombe sur l'image.
                    const giveUp = setTimeout(() => {
                        if (video.readyState === 0) {
                            hls.destroy();
                            if (currentHls === hls) currentHls = null;
                            showStill();
                        }
                    }, 8000);

                    hls.on(Hls.Events.FRAG_BUFFERED, () => clearTimeout(giveUp));
                    hls.on(Hls.Events.ERROR, (_evt, data) => {
                        if (data && data.fatal) {
                            clearTimeout(giveUp);
                            hls.destroy();
                            if (currentHls === hls) currentHls = null;
                            showStill();
                        }
                    });

                    hls.loadSource(trailer.hls);
                    hls.attachMedia(video);
                    // libère le flux quand on ferme la fiche
                    currentHls = hls;
                }).catch(showStill);
            }
        } else {
            showStill();
        }

        const priceEl = document.getElementById('game-details-price');
        priceEl.innerHTML = '';
        if (details.price) {
            if (details.price.discountPercent > 0 && details.price.initialFormatted) {
                const old = document.createElement('del');
                old.textContent = details.price.initialFormatted;
                priceEl.appendChild(old);
            }
            priceEl.appendChild(document.createTextNode(details.price.formatted || ''));
            if (details.price.discountPercent > 0) {
                const badge = document.createElement('span');
                badge.className = 'price-badge';
                badge.textContent = `-${details.price.discountPercent}%`;
                priceEl.appendChild(badge);
            }
        } else {
            priceEl.textContent = 'Prix indisponible';
        }

        // Liens boutiques. Instant Gaming et IsThereAnyDeal n'ont pas d'API
        // publique sans clé : on ouvre donc leur recherche sur le nom du jeu.
        const storeQuery = encodeURIComponent(details.name || gameName);
        const steamLink = document.getElementById('game-details-link');
        steamLink.href = details.steamUrl || '#';
        // renderWikiCard réutilise ce bouton pour Wikipédia : on remet le libellé
        steamLink.textContent = 'Steam';
        document.getElementById('game-details-ig').href =
            `https://www.instant-gaming.com/fr/rechercher/?q=${storeQuery}`;
        document.getElementById('game-details-itad').href =
            `https://isthereanydeal.com/search/?q=${storeQuery}`;

        body.style.display = 'block';
    }

    document.getElementById('close-game-details-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('game-details-modal');
        if (modal) modal.style.display = 'none';
        // coupe la bande-annonce et libère le flux HLS en fermant
        if (currentHls) { currentHls.destroy(); currentHls = null; }
        const media = document.getElementById('game-details-media');
        if (media) media.innerHTML = '';
    });

    document.getElementById('game-details-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'game-details-modal') {
            document.getElementById('close-game-details-btn')?.click();
        }
    });

    // --- BIBLIOTHÈQUES STEAM DU GROUPE -------------------------------------

    let groupLibraries = {};

    // Agrège les bibliothèques de tous les joueurs liés et classe par
    // pourcentage de possession. On ignore les jeux possédés par une seule
    // personne : l'intérêt est de trouver ce que le groupe a en commun.
    let libraryMode = 'common';

    // Tags des jeux de bibliothèque. Contrairement au classement, on ne peut pas
    // interroger Steam pour 600 jeux : on ne récupère les détails que des lignes
    // réellement affichées, et la liste de tags s'enrichit au fil du défilement.
    const libraryTagsByGame = new Map();
    const selectedLibraryTags = new Set();

    function libraryGameKey(game) {
        return game.appId ? `a${game.appId}` : normalizeGameName(game.name);
    }

    async function loadLibraryTags(games) {
        const missing = games.filter(g => g.appId && !libraryTagsByGame.has(libraryGameKey(g)));
        if (missing.length === 0) return false;

        let added = false;
        await Promise.all(missing.slice(0, 30).map(async (g) => {
            const key = libraryGameKey(g);
            libraryTagsByGame.set(key, null); // marque comme demandé
            try {
                const res = await fetch(`/api/game-details?appid=${encodeURIComponent(g.appId)}`);
                if (!res.ok) return;
                const details = await res.json();
                const tags = [...(details.genres || []), ...(details.categories || [])];
                tags.forEach(t => tagLabels.set(t.toLowerCase(), t));
                (details.genres || []).forEach(t => gameplayTags.add(t.toLowerCase()));
                (details.categories || []).forEach(t => {
                    if (GAMEPLAY_CATEGORY.test(t)) gameplayTags.add(t.toLowerCase());
                });
                libraryTagsByGame.set(key, tags.map(t => t.toLowerCase()));
                added = true;
            } catch (error) {
                console.debug('Tags bibliothèque indisponibles:', error);
            }
        }));

        return added;
    }

    function makeLibraryTagChip(key, count) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = selectedLibraryTags.has(key) ? 'filter-chip active' : 'filter-chip';
        chip.dataset.libtag = key;
        chip.textContent = tagLabels.get(key) || key;
        if (count != null) {
            const badge = document.createElement('span');
            badge.className = 'filter-chip__n';
            badge.textContent = count;
            chip.appendChild(badge);
        }
        return chip;
    }

    function renderLibraryTagBar(mount, games) {
        const bar = mount.querySelector('.js-library-tags');
        const menu = mount.querySelector('.js-library-tagmenu');
        const menuList = mount.querySelector('.js-library-taglist');
        if (!bar) return;

        const counts = new Map();
        games.forEach(g => {
            const tags = libraryTagsByGame.get(libraryGameKey(g));
            if (!Array.isArray(tags)) return;
            new Set(tags).forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
        });

        const sorted = [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || (tagLabels.get(a[0]) || a[0]).localeCompare(tagLabels.get(b[0]) || b[0]));

        // En tête : seulement les tags de gameplay, comme pour le classement
        const top = sorted.filter(([k]) => gameplayTags.has(k)).slice(0, 6).map(([k]) => k);
        selectedLibraryTags.forEach(t => { if (!top.includes(t)) top.push(t); });

        bar.innerHTML = '';
        if (sorted.length === 0) {
            if (menu) menu.style.display = 'none';
            return;
        }
        if (menu) menu.style.display = '';

        const label = document.createElement('span');
        label.className = 'filter-bar__label';
        label.textContent = 'Tags';
        bar.appendChild(label);

        top.forEach(key => bar.appendChild(makeLibraryTagChip(key, counts.get(key) || 0)));

        if (selectedLibraryTags.size) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'filter-chip filter-chip--reset';
            reset.dataset.libtag = '__reset__';
            reset.textContent = '✕ Effacer';
            bar.appendChild(reset);
        }

        // Le menu liste tout, y compris les fonctionnalités de plateforme
        if (menuList) {
            const search = (mount.querySelector('.js-library-tagsearch')?.value || '').toLowerCase().trim();
            const filtered = sorted.filter(([k]) =>
                !search || (tagLabels.get(k) || k).toLowerCase().includes(search));

            menuList.innerHTML = '';
            if (filtered.length === 0) {
                menuList.innerHTML = '<span class="tag-menu__empty">Aucun tag correspondant.</span>';
            } else {
                filtered.forEach(([key, n]) => menuList.appendChild(makeLibraryTagChip(key, n)));
            }
        }
    }

    // Les puces existent dans la barre et dans le menu déroulant
    document.addEventListener('click', (e) => {
        const chip = e.target.closest('.js-library-tags .filter-chip, .js-library-taglist .filter-chip');
        if (!chip) return;
        const key = chip.dataset.libtag;
        if (key === '__reset__') selectedLibraryTags.clear();
        else if (selectedLibraryTags.has(key)) selectedLibraryTags.delete(key);
        else selectedLibraryTags.add(key);
        renderGroupLibrary();
    });

    document.addEventListener('input', (e) => {
        const field = e.target.closest('.js-library-tagsearch');
        if (!field) return;
        const mount = field.closest('.library-panel-mount');
        if (mount) renderLibraryPanel(mount);
    });

    // Referme le menu des tags au clic à l'extérieur
    document.addEventListener('click', (e) => {
        document.querySelectorAll('.js-library-tagmenu[open]').forEach(menu => {
            if (!menu.contains(e.target)) menu.open = false;
        });
    });

    // Une ligne de jeu issue d'une bibliothèque Steam (pas du classement de votes)
    function buildLibraryRow(game, index, playerCount) {
        const row = document.createElement('div');
        row.className = 'rank-row rank-row--clickable';

        const rank = document.createElement('span');
        rank.className = 'rank-row__position';
        rank.textContent = index + 1;

        const img = document.createElement('img');
        img.className = 'rank-row__thumb';
        img.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appId}/header.jpg`;
        img.alt = '';
        img.addEventListener('error', () => { img.src = DEFAULT_GAME_ICON; });

        const cell = document.createElement('div');
        cell.className = 'rank-row__namecell';
        const name = document.createElement('span');
        name.className = 'rank-row__name';
        name.textContent = game.name;
        name.title = game.name;
        cell.appendChild(name);

        const badge = document.createElement('span');
        badge.className = game.count === playerCount && playerCount > 1
            ? 'owner-badge owner-badge--all'
            : 'owner-badge';
        // Avec une seule bibliothèque, « 1/1 joueur » n'apprend rien : on
        // affiche le temps de jeu, plus parlant pour trier ses propres jeux.
        badge.textContent = playerCount > 1
            ? `${game.count}/${playerCount}`
            : (game.minutes >= 60 ? `${Math.round(game.minutes / 60)} h` : `${game.minutes} min`);

        row.append(rank, img, cell, badge);

        // Pendant la phase de vote, on peut ajouter le jeu directement à son vote
        if (globalSettings.isVotingOpen && document.getElementById('vote-form')) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'rank-row__add';
            addBtn.textContent = '+';
            addBtn.title = `Ajouter « ${game.name} » à mon vote`;
            addBtn.setAttribute('aria-label', `Ajouter ${game.name} à mon vote`);
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addGameToVote(game.name);
            });
            row.appendChild(addBtn);
        }

        row.addEventListener('click', () => openGameDetails(game.name));
        return row;
    }

    function showVoteError(message) {
        const box = document.getElementById('vote-error');
        if (!box) { showToast(message, 'error'); return; }
        box.textContent = message;
        box.style.display = 'block';
        box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function clearVoteError() {
        const box = document.getElementById('vote-error');
        if (box) box.style.display = 'none';
    }

    // Normalise les noms saisis via Steam avant l'enregistrement, pour que
    // « Crusader Kings 3 » et « Crusader Kings III » deviennent le même jeu.
    //
    // Prudence volontaire : la recherche floue renverrait « Riftbound Survivors »
    // pour « Riftbound ». On n'accepte donc la correction que si le nom proposé
    // reste proche de la saisie : le bouton « Vérifier », lui, est explicite et
    // peut se permettre d'être plus agressif.
    const AUTOFIX_MAX_DISTANCE_RATIO = 0.34;

    async function canonicalizeVoteInputs() {
        const form = document.getElementById('vote-form');
        if (!form) return [];

        const inputs = [...form.querySelectorAll('input[type="text"]')].filter(i => i.value.trim());
        const changes = [];

        await Promise.all(inputs.map(async (input) => {
            const raw = input.value.trim().replace(/\s+/g, ' ');
            try {
                const res = await fetch(`/api/get-game-image?name=${encodeURIComponent(raw)}&fuzzy=1`);
                if (!res.ok) return;
                const data = await res.json();
                if (!data.name || data.name === raw) return;

                const distance = levenshtein(normalizeGameName(raw), normalizeGameName(data.name));
                const ratio = distance / Math.max(raw.length, data.name.length);
                if (!data.exactMatch && ratio > AUTOFIX_MAX_DISTANCE_RATIO) return;

                input.value = data.name;
                changes.push({ from: raw, to: data.name });
            } catch (error) {
                // Steam indisponible : on garde la saisie telle quelle
                console.debug('Canonicalisation ignorée:', error);
            }
        }));

        return changes;
    }

    // Renvoie les noms saisis plus d'une fois, toutes priorités confondues
    function findDuplicateVotes() {
        const form = document.getElementById('vote-form');
        if (!form) return [];

        const seen = new Map();
        const duplicates = new Set();

        form.querySelectorAll('input[type="text"]').forEach(input => {
            const raw = input.value.trim();
            if (!raw) return;
            const key = normalizeGameName(raw);
            if (!key) return;
            if (seen.has(key)) duplicates.add(seen.get(key));
            else seen.set(key, raw);
        });

        return [...duplicates];
    }

    // Souligne en rouge les champs fautifs, le temps de les corriger
    function highlightDuplicateInputs() {
        const form = document.getElementById('vote-form');
        if (!form) return;

        const counts = new Map();
        const inputs = [...form.querySelectorAll('input[type="text"]')];

        inputs.forEach(input => {
            const key = normalizeGameName(input.value.trim());
            if (key) counts.set(key, (counts.get(key) || 0) + 1);
        });

        inputs.forEach(input => {
            const key = normalizeGameName(input.value.trim());
            const isDupe = key && counts.get(key) > 1;
            input.classList.toggle('input-error', !!isDupe);
            if (isDupe) {
                // le surlignage disparaît dès qu'on modifie le champ
                input.addEventListener('input', () => input.classList.remove('input-error'), { once: true });
            }
        });
    }

    // Place un jeu dans le formulaire de vote : premier champ libre, sinon
    // nouvelle ligne dans « Autres ».
    function addGameToVote(gameName) {
        const form = document.getElementById('vote-form');
        if (!form) return;

        const existing = [...form.querySelectorAll('input[type="text"]')];

        // Déjà voté ? On le signale plutôt que de créer un doublon
        const already = existing.find(i => normalizeGameName(i.value) === normalizeGameName(gameName));
        if (already) {
            showToast(`« ${gameName} » est déjà dans votre vote.`, 'error');
            already.focus();
            return;
        }

        const empty = existing.find(i => !i.value.trim());
        if (empty) {
            empty.value = gameName;
            empty.focus();
            isEditing = true;
            showToast(`« ${gameName} » ajouté à votre vote.`, 'success');
            return;
        }

        // Tous les champs sont pris : on en ajoute un dans « Autres »
        const otherList = form.querySelector('.priority-group[data-priority="p_other"] .game-input-list');
        if (!otherList) return;
        createInput(gameName, false, otherList);
        isEditing = true;
        showToast(`« ${gameName} » ajouté dans « Autres ».`, 'success');
    }

    // Agrège toutes les sources (bibliothèques Steam et abonnements) et compte
    // combien de personnes possèdent chaque jeu.
    //
    // La clé est le nom normalisé, pas l'appId : un abonnement Game Pass ne
    // fournit que des titres, et c'est le seul terrain commun avec Steam.
    function aggregateLibraries(owners) {
        const games = new Map();

        owners.forEach(owner => {
            // Set : un même jeu ne doit compter qu'une fois par personne
            const seen = new Set();
            (owner.games || []).forEach(g => {
                const key = normalizeGameName(g.name);
                if (!key || seen.has(key)) return;
                seen.add(key);

                const entry = games.get(key) || { name: g.name, appId: g.appId || null, count: 0, minutes: 0 };
                entry.count += 1;
                entry.minutes += g.playtimeMinutes || 0;
                // On garde le premier appId rencontré : il sert à la jaquette
                if (!entry.appId && g.appId) entry.appId = g.appId;
                games.set(key, entry);
            });
        });

        return [...games.values()];
    }

    // Catalogue Game Pass. Il est identique pour tout le monde et bouge peu :
    // on le garde une journée dans localStorage plutôt que de le retélécharger
    // à chaque ouverture de page.
    const GAMEPASS_STORE_KEY = 'lan-demain:gamepass:v1';
    const GAMEPASS_TTL_MS = 24 * 60 * 60 * 1000;

    let gamepassCatalog = null;
    let gamepassPromise = null;

    function readGamepassCache() {
        try {
            const raw = localStorage.getItem(GAMEPASS_STORE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data || !Array.isArray(data.games)) return null;
            if (Date.now() - data.ts > GAMEPASS_TTL_MS) return null;
            return data.games;
        } catch (error) {
            return null;
        }
    }

    function loadGamepassCatalog() {
        if (gamepassCatalog) return Promise.resolve(gamepassCatalog);

        const cached = readGamepassCache();
        if (cached) {
            gamepassCatalog = cached;
            return Promise.resolve(gamepassCatalog);
        }

        if (gamepassPromise) return gamepassPromise;

        gamepassPromise = fetch('/api/gamepass-catalog')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                gamepassCatalog = (data && data.games) ? data.games : [];
                try {
                    localStorage.setItem(GAMEPASS_STORE_KEY,
                        JSON.stringify({ ts: Date.now(), games: gamepassCatalog }));
                } catch (error) {
                    console.debug('Catalogue Game Pass non mis en cache:', error);
                }
                return gamepassCatalog;
            })
            .catch(error => {
                // API non officielle : une panne ne doit pas casser le panneau
                console.debug('Catalogue Game Pass indisponible:', error);
                gamepassCatalog = [];
                return gamepassCatalog;
            });

        return gamepassPromise;
    }

    // Transforme les bibliothèques Steam en une liste unique de "possesseurs"
    function collectLibraryOwners() {
        const owners = [];

        const catalogue = gamepassCatalog || [];

        Object.values(groupLibraries).forEach(lib => {
            if (!Array.isArray(lib.games) || lib.games.length === 0) return;

            // Un abonné possède sa bibliothèque Steam ET le catalogue Game Pass :
            // les deux comptent pour la même personne, donc une seule entrée.
            const games = lib.gamepass && catalogue.length
                ? lib.games.concat(catalogue.map(g => ({ name: g.name, appId: null, playtimeMinutes: 0 })))
                : lib.games;

            owners.push({
                id: lib.steamId,
                name: lib.gamepass ? `${lib.personaName || 'Joueur'} + Game Pass` : (lib.personaName || 'Joueur'),
                source: 'steam',
                gamepass: !!lib.gamepass,
                games
            });
        });

        return owners;
    }

    // Le panneau apparaît dans deux vues (vote et LAN active). On l'injecte dans
    // chaque point de montage plutôt que de dupliquer le markup : des ID en double
    // ne câbleraient que la première copie : c'est exactement le bug B1.
    const LIBRARY_PANEL_HTML = `
        <h3 class="section-title">🎮 Bibliothèques Steam</h3>
        <p class="panel-section__hint js-library-summary">Aucune bibliothèque liée.</p>
        <div class="filter-bar js-library-filter"></div>
        <input type="search" class="luxury-input js-library-search" placeholder="Rechercher un jeu..."
            style="margin-bottom: 10px;">
        <div class="filter-bar js-library-tagbar">
            <span class="filter-bar__chips js-library-tags"></span>
            <details class="tag-menu js-library-tagmenu">
                <summary class="filter-chip">Tous les tags ▾</summary>
                <div class="tag-menu__panel">
                    <input type="text" class="luxury-input tag-menu__search js-library-tagsearch"
                        placeholder="Rechercher un tag...">
                    <div class="tag-menu__list js-library-taglist"></div>
                </div>
            </details>
        </div>
        <div class="rank-list scroll-area js-library-list"></div>
        <details class="link-steam">
            <summary>Ajouter une bibliothèque Steam</summary>
            <p class="panel-section__hint js-steam-status">La vôtre ou celle d'un ami. Le profil doit avoir
                « Détails du jeu » en Public dans Steam.</p>
            <div class="field-row">
                <input type="text" class="luxury-input js-steam-input" placeholder="URL de profil ou pseudo Steam"
                    style="flex: 1;">
                <button class="gold-btn btn-inline js-steam-add">Ajouter</button>
            </div>
            <div class="stack stack--xs js-linked-libraries" style="margin-top: 12px;"></div>

            <p class="panel-section__hint" style="margin-top: 14px;">Cochez « Game Pass » sur une bibliothèque pour
                compter tout le catalogue PC comme possédé. (Ubisoft+ n'expose aucun catalogue public, donc pas encore
                supporté.)</p>
        </details>`;

    function ensureLibraryPanels() {
        document.querySelectorAll('.library-panel-mount').forEach(mount => {
            if (!mount.dataset.built) {
                mount.innerHTML = LIBRARY_PANEL_HTML;
                mount.dataset.built = '1';
            }
        });
    }

    function renderGroupLibrary() {
        ensureLibraryPanels();
        const mounts = [...document.querySelectorAll('.library-panel-mount')];
        if (mounts.length === 0) return;
        mounts.forEach(renderLibraryPanel);
    }

    function renderLibraryPanel(mount) {
        const container = mount.querySelector('.js-library-list');
        const summary = mount.querySelector('.js-library-summary');
        const filterBar = mount.querySelector('.js-library-filter');
        if (!container) return;

        const libraries = collectLibraryOwners();
        const playerCount = libraries.length;
        const names = libraries.map(p => p.name).filter(Boolean);

        container.innerHTML = '';

        if (playerCount === 0) {
            if (summary) summary.textContent = 'Aucune bibliothèque ajoutée pour l\'instant.';
            if (filterBar) filterBar.innerHTML = '';
            container.innerHTML = '<p style="font-style:italic; color:var(--secondary-text);">Ajoutez un profil Steam ou un abonnement ci-dessous.</p>';
            renderLinkedLibrariesAdmin(libraries, mount);
            return;
        }

        const all = aggregateLibraries(libraries);
        const shared = all.filter(g => g.count > 1);

        if (summary) {
            summary.textContent = playerCount === 1
                ? `1 bibliothèque : ${names[0]} (${all.length} jeux). Ajoutez-en une autre pour comparer.`
                : `${playerCount} bibliothèques : ${shared.length} jeux en commun sur ${all.length}.`;
        }

        // Onglets : en commun, tous, puis un par personne
        if (filterBar) {
            filterBar.innerHTML = '';
            const chips = [];
            if (playerCount > 1) chips.push({ mode: 'common', label: 'En commun' });
            chips.push({ mode: 'all', label: 'Tous' });
            libraries.forEach(lib => chips.push({ mode: lib.id, label: lib.name }));

            // Si le mode courant n'existe plus, on retombe sur un onglet valide
            if (!chips.some(c => c.mode === libraryMode)) {
                libraryMode = chips[0].mode;
            }

            chips.forEach(c => {
                const btn = document.createElement('button');
                btn.className = c.mode === libraryMode ? 'filter-chip active' : 'filter-chip';
                btn.dataset.libmode = c.mode;
                btn.textContent = c.label;
                filterBar.appendChild(btn);
            });
        }

        let list;
        let countBasis = playerCount;

        if (libraryMode === 'common') {
            list = shared.sort((a, b) => b.count - a.count || b.minutes - a.minutes);
        } else if (libraryMode === 'all') {
            list = all.sort((a, b) => b.count - a.count || b.minutes - a.minutes);
        } else {
            // Bibliothèque d'une personne précise, triée par temps de jeu
            const lib = libraries.find(l => l.id === libraryMode);
            countBasis = 1;
            list = lib
                ? lib.games
                    .map(g => ({ appId: g.appId, name: g.name, count: 1, minutes: g.playtimeMinutes || 0 }))
                    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))
                : [];
        }

        // Recherche textuelle : avec 600 jeux, les onglets ne suffisent pas
        const search = (mount.querySelector('.js-library-search')?.value || '').toLowerCase().trim();
        if (search) {
            list = list.filter(g => (g.name || '').toLowerCase().includes(search));
        }

        // Filtre par tags : un jeu doit porter tous ceux qui sont sélectionnés.
        // Les jeux dont les tags ne sont pas encore connus sont écartés, sinon
        // le filtre semblerait ne rien faire.
        if (selectedLibraryTags.size) {
            list = list.filter(g => {
                const tags = libraryTagsByGame.get(libraryGameKey(g));
                if (!Array.isArray(tags)) return false;
                return [...selectedLibraryTags].every(t => tags.includes(t));
            });
        }

        if (list.length === 0) {
            container.innerHTML = search
                ? `<p style="font-style:italic; color:var(--secondary-text);">Aucun jeu ne correspond à « ${escapeHtml(search)} ».</p>`
                : '<p style="font-style:italic; color:var(--secondary-text);">Aucun jeu à afficher ici.</p>';
            return;
        }

        // Sans recherche on plafonne l'affichage ; en recherche on veut tout voir
        const shown = list.slice(0, search ? 200 : 60);
        shown.forEach((game, index) => {
            container.appendChild(buildLibraryRow(game, index, countBasis));
        });

        renderLibraryTagBar(mount, shown);
        renderLinkedLibrariesAdmin(libraries, mount);

        // Les tags arrivent après coup : on redessine une fois qu'ils sont là
        loadLibraryTags(shown).then(added => {
            if (added) renderLibraryTagBar(mount, shown);
        });
    }

    function formatAge(timestamp) {
        if (!timestamp) return 'date inconnue';
        const days = Math.floor((Date.now() - timestamp) / 86400000);
        if (days <= 0) return "aujourd'hui";
        if (days === 1) return 'hier';
        if (days < 30) return `il y a ${days} jours`;
        const months = Math.floor(days / 30);
        return months === 1 ? 'il y a 1 mois' : `il y a ${months} mois`;
    }

    // Liste des bibliothèques ajoutées, avec retrait (utile en cas d'erreur)
    function renderLinkedLibrariesAdmin(libraries, mount) {
        const box = mount.querySelector('.js-linked-libraries');
        if (!box) return;
        box.innerHTML = '';

        libraries.forEach(lib => {
            const row = document.createElement('div');
            row.className = 'player-row';

            const source = groupLibraries[lib.id];

            const name = document.createElement('span');
            name.className = 'player-row__name';
            // Une bibliothèque est un instantané : sans date, impossible de
            // savoir si elle date d'avant les derniers achats.
            name.textContent = `${lib.name} : ${lib.games.length} jeux · ${formatAge(source && source.updatedAt)}`;
            name.title = source && source.addedByName ? `Ajoutée par ${source.addedByName}` : '';

            row.appendChild(name);

            // L'abonnement est une propriété de la personne, donc de sa
            // bibliothèque : une case à cocher plutôt qu'une saisie séparée.
            if (lib.source === 'steam') {
                const toggle = document.createElement('label');
                toggle.className = 'lib-sub-toggle';
                toggle.title = 'Compter tout le catalogue PC Game Pass comme possédé';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!(source && source.gamepass);
                cb.addEventListener('change', async () => {
                    try {
                        if (cb.checked) await loadGamepassCatalog();
                        await db.ref(`lan/steamLibraries/${lib.id}/gamepass`).set(cb.checked);
                        showToast(cb.checked
                            ? `${lib.name} compte aussi le Game Pass.`
                            : `Game Pass retiré pour ${lib.name}.`, 'success');
                    } catch (error) {
                        cb.checked = !cb.checked;
                        showToast('Erreur : ' + error.message, 'error');
                    }
                });
                toggle.append(cb, document.createTextNode(' Game Pass'));
                toggle.classList.toggle('is-selected', cb.checked);
                row.appendChild(toggle);
            }

            const del = document.createElement('button');
            del.className = 'danger-link-btn';
            del.textContent = 'Retirer';
            del.style.marginLeft = 'var(--space-3)';
            del.addEventListener('click', () => {
                askConfirm(`Retirer ${lib.name} ?`, { danger: true }).then(ok => {
                    if (!ok) return;
                    db.ref(`lan/steamLibraries/${lib.id}`).remove()
                        .then(() => showToast(`${lib.name} retiré.`, 'success'))
                        .catch(err => showToast('Erreur : ' + err.message, 'error'));
                });
            });

            row.appendChild(del);
            box.appendChild(row);
        });
    }


    // Délégation : les panneaux sont construits à la volée, donc on écoute le
    // document plutôt que des éléments qui n'existent pas encore.
    document.addEventListener('click', (e) => {
        const chip = e.target.closest('.js-library-filter .filter-chip');
        if (!chip) return;
        libraryMode = chip.dataset.libmode;
        renderGroupLibrary();
    });

    // La recherche ne redessine que son propre panneau, pour ne pas perdre le
    // focus ni le texte saisi dans l'autre.
    document.addEventListener('input', (e) => {
        const field = e.target.closest('.js-library-search');
        if (!field) return;
        const mount = field.closest('.library-panel-mount');
        if (mount) renderLibraryPanel(mount);
    });

    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.js-steam-add');
        if (!btn) return;

        // On travaille dans le panneau cliqué, pas dans le premier de la page
        const panel = btn.closest('.library-panel-mount');
        const input = panel?.querySelector('.js-steam-input');
        const status = panel?.querySelector('.js-steam-status');
        const user = auth.currentUser;
        if (!input || !user) return;

        const profile = input.value.trim();
        if (!profile) { showToast('Entrez une URL de profil Steam.', 'error'); return; }

        status.textContent = 'Récupération de votre bibliothèque…';

        try {
            const res = await fetch(`/api/steam-library?profile=${encodeURIComponent(profile)}`);
            const data = await res.json();

            if (data.missingKey) {
                status.textContent = 'La clé API Steam n\'est pas configurée côté serveur.';
                showToast('STEAM_API_KEY manquante sur Vercel.', 'error');
                return;
            }
            if (!res.ok) {
                status.textContent = 'Profil Steam introuvable. Vérifiez l\'URL ou le pseudo.';
                showToast('Profil Steam introuvable.', 'error');
                return;
            }
            if (data.privateProfile) {
                status.textContent = 'Profil trouvé, mais ses détails de jeu sont privés. Passez « Détails du jeu » en Public dans Steam puis réessayez.';
                showToast('Bibliothèque Steam privée.', 'error');
                return;
            }

            // Indexé par compte Steam, et non par joueur connecté : on peut
            // ainsi ajouter la bibliothèque d'un ami sans écraser la sienne.
            const label = data.personaName || `Steam ${data.steamId}`;
            await db.ref(`lan/steamLibraries/${data.steamId}`).set({
                steamId: data.steamId,
                personaName: label,
                avatar: data.avatar || null,
                profileUrl: data.profileUrl || null,
                games: data.games.slice(0, 500),
                addedBy: user.uid,
                addedByName: user.displayName || null,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            });

            status.textContent = `${data.gameCount} jeux importés pour ${label}.`;
            showToast(`${data.gameCount} jeux importés pour ${label} !`, 'success');
            input.value = '';
        } catch (error) {
            console.error('Steam link error:', error);
            status.textContent = 'Erreur lors de la récupération de la bibliothèque.';
            showToast('Erreur Steam.', 'error');
        }
    });

    // --- FILTRES DU CLASSEMENT ---------------------------------------------

    // Tags sélectionnés (clé en minuscules) : un jeu doit tous les porter
    const selectedTags = new Set();
    // minuscule -> libellé d'origine, pour afficher « Coopération » et non « coopération »
    const tagLabels = new Map();

    const FREE_TAG = '__free__';
    const TOP_TAG_COUNT = 6;

    // Tags utiles pour choisir un jeu en LAN. Les catégories Steam contiennent
    // surtout des fonctionnalités de plateforme (Succès, Cartes à échanger,
    // Remote Play, options d'accessibilité…) : pertinentes dans le menu complet,
    // mais elles n'ont rien à faire en tête de liste.
    const GAMEPLAY_CATEGORY = /multijoueur|solo|coop|pvp|jcj|écran partagé|lan|mmo|crossplay|multiplateforme|joueur/i;
    const gameplayTags = new Set([FREE_TAG]);

    function registerTags(details) {
        (details.genres || []).forEach(label => {
            tagLabels.set(label.toLowerCase(), label);
            // Un genre (Action, RPG, Stratégie…) est toujours pertinent
            gameplayTags.add(label.toLowerCase());
        });
        (details.categories || []).forEach(label => {
            tagLabels.set(label.toLowerCase(), label);
            if (GAMEPLAY_CATEGORY.test(label)) gameplayTags.add(label.toLowerCase());
        });
    }

    function rowTags(row) {
        const raw = row.dataset.tags || '';
        return raw ? raw.split('|') : [];
    }

    // Fréquence de chaque tag parmi les jeux du classement
    function computeTagCounts() {
        const counts = new Map();
        document.querySelectorAll('#active-lan-games-list .rank-row').forEach(row => {
            new Set(rowTags(row)).forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
            if (row.dataset.isFree === 'true') {
                counts.set(FREE_TAG, (counts.get(FREE_TAG) || 0) + 1);
            }
        });
        return counts;
    }

    function tagLabel(key) {
        if (key === FREE_TAG) return 'Gratuit';
        return tagLabels.get(key) || key;
    }

    function makeTagChip(key, count) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = selectedTags.has(key) ? 'filter-chip active' : 'filter-chip';
        chip.dataset.tag = key;
        chip.textContent = tagLabel(key);
        if (count != null) {
            const n = document.createElement('span');
            n.className = 'filter-chip__n';
            n.textContent = count;
            chip.appendChild(n);
        }
        return chip;
    }

    function applyGameFilter() {
        const rows = document.querySelectorAll('#active-lan-games-list .rank-row');
        let shown = 0;

        rows.forEach(row => {
            const tags = rowTags(row);
            const visible = [...selectedTags].every(t =>
                t === FREE_TAG ? row.dataset.isFree === 'true' : tags.includes(t)
            );
            row.classList.toggle('rank-row--hidden', !visible);
            if (visible) shown++;
        });

        const count = document.getElementById('filter-count');
        if (count) {
            count.textContent = selectedTags.size === 0
                ? `${rows.length} jeux`
                : `${shown} / ${rows.length} jeux`;
        }

        const reset = document.getElementById('filter-reset');
        if (reset) reset.style.display = selectedTags.size ? 'inline-block' : 'none';
    }

    // Reconstruit les puces : les plus fréquentes en tête, le reste dans le menu
    function renderTagFilters() {
        const topBox = document.getElementById('filter-top-tags');
        const menuList = document.getElementById('tag-menu-list');
        if (!topBox || !menuList) return;

        const counts = computeTagCounts();
        const sorted = [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || tagLabel(a[0]).localeCompare(tagLabel(b[0])));

        // En tête : uniquement les tags de gameplay, les plus fréquents d'abord.
        // Un tag sélectionné y reste même s'il en sort.
        const top = sorted
            .filter(([k]) => gameplayTags.has(k))
            .slice(0, TOP_TAG_COUNT)
            .map(([k]) => k);
        selectedTags.forEach(t => { if (!top.includes(t)) top.push(t); });

        topBox.innerHTML = '';
        top.forEach(key => topBox.appendChild(makeTagChip(key, counts.get(key) || 0)));

        const search = (document.getElementById('tag-search')?.value || '').toLowerCase().trim();
        menuList.innerHTML = '';
        const menuTags = sorted.filter(([k]) => !search || tagLabel(k).toLowerCase().includes(search));

        if (menuTags.length === 0) {
            menuList.innerHTML = '<span class="tag-menu__empty">Aucun tag correspondant.</span>';
        } else {
            menuTags.forEach(([key, n]) => menuList.appendChild(makeTagChip(key, n)));
        }

        applyGameFilter();
    }

    // Les fiches Steam reviennent une par une ; sans regroupement on
    // reconstruirait la barre 20 fois de suite.
    let tagRefreshTimer = null;
    function scheduleTagFilterRefresh() {
        clearTimeout(tagRefreshTimer);
        tagRefreshTimer = setTimeout(renderTagFilters, 150);
    }

    // Clic sur une puce, dans la barre comme dans le menu
    function onTagChipClick(e) {
        const chip = e.target.closest('.filter-chip');
        if (!chip || !chip.dataset.tag) return;
        const key = chip.dataset.tag;
        if (selectedTags.has(key)) selectedTags.delete(key);
        else selectedTags.add(key);
        renderTagFilters();
    }

    document.getElementById('filter-top-tags')?.addEventListener('click', onTagChipClick);
    document.getElementById('tag-menu-list')?.addEventListener('click', onTagChipClick);

    document.getElementById('tag-search')?.addEventListener('input', renderTagFilters);

    document.getElementById('filter-reset')?.addEventListener('click', () => {
        selectedTags.clear();
        renderTagFilters();
    });

    // Referme le menu quand on clique ailleurs
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('filter-all-tags');
        if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
    });

    // Construit une ligne de classement. Utilisé partout où l'on affiche
    // un jeu avec son rang, sa jaquette et son score (dashboard, résultats, admin).
    function buildRankRow(game, position) {
        const row = document.createElement('div');
        row.className = position <= 3 ? `rank-row rank-row--${position}` : 'rank-row';

        const rank = document.createElement('span');
        rank.className = 'rank-row__position';
        rank.textContent = position;

        const img = document.createElement('img');
        img.className = 'rank-row__thumb';
        // Vignette connue : on l'affiche directement, sans passer par le placeholder
        img.src = getCachedGameImage(game.name) || DEFAULT_GAME_ICON;
        img.alt = '';
        getGameImage(game.name).then(url => { if (url !== img.src) img.src = url; });

        // Le nom et ses étiquettes partagent la même colonne de la grille
        const nameCell = document.createElement('div');
        nameCell.className = 'rank-row__namecell';

        const name = document.createElement('span');
        name.className = 'rank-row__name';
        name.textContent = game.name;
        name.title = game.name;
        nameCell.appendChild(name);

        const tags = document.createElement('div');
        tags.className = 'rank-row__tags';
        nameCell.appendChild(tags);

        const score = document.createElement('span');
        score.className = 'rank-row__score';
        score.textContent = `${game.score} pts`;

        row.append(rank, img, nameCell, score);

        // Les admins peuvent corriger une faute de frappe directement ici
        if (window.currentUserIsAdmin) {
            const editBtn = document.createElement('button');
            editBtn.className = 'rank-row__edit';
            editBtn.type = 'button';
            editBtn.textContent = '✏️';
            editBtn.title = `Corriger le nom de « ${game.name} »`;
            editBtn.setAttribute('aria-label', `Corriger le nom de ${game.name}`);
            editBtn.addEventListener('click', (e) => {
                // sans ça, le clic ouvrirait aussi la fiche du jeu
                e.stopPropagation();
                openRenameGame(game.name);
            });
            row.appendChild(editBtn);
        }

        // Ouvre la fiche Steam au clic, et récupère les étiquettes en arrière-plan
        row.classList.add('rank-row--clickable');
        row.addEventListener('click', () => openGameDetails(game.name));

        getGameDetails(game.name).then(details => {
            // Sur une correspondance approximative, les genres/prix sont ceux d'un
            // autre jeu : on n'affiche ni étiquettes ni données de filtrage.
            if (!details || !details.exactMatch) return;
            renderTags(tags, details, 3);
            row.dataset.tags = [...(details.genres || []), ...(details.categories || [])]
                .join('|').toLowerCase();
            row.dataset.isFree = details.price && details.price.free ? 'true' : 'false';
            registerTags(details);
            // Les fiches arrivent une par une : on reconstruit la barre au fil de l'eau
            scheduleTagFilterRefresh();
        });

        return row;
    }

    // Populate closed-voting game lists (both user and admin views)
    function renderClosedResults(sortedGames) {
        const count = globalSettings.topGamesCount || 10;
        const topGames = sortedGames.slice(0, count);

        const renderList = async (containerId) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';

            container.classList.add('rank-list');

            for (let i = 0; i < topGames.length; i++) {
                const game = topGames[i];
                container.appendChild(buildRankRow(game, i + 1));
            }
        };

        // La liste joueur vit désormais dans « À installer », qui dit en plus
        // qui doit encore télécharger. Ici, seule la vue admin.
        renderList('admin-closed-download-list');
    }

    // Populate the LAN Active dashboard official games list
    function renderActiveLanGames(sortedGames) {
        const container = document.getElementById('active-lan-games-list');
        if (!container) return;
        container.innerHTML = '';
        const count = globalSettings.topGamesCount || 10;
        const topGames = sortedGames.slice(0, count);

        container.classList.add('rank-list');

        topGames.forEach((game, index) => {
            container.appendChild(buildRankRow(game, index + 1));
        });
    }

    // Populate the voting history in the Active LAN phase
    function renderActiveLanAllGames(sortedGames) {
        const container = document.getElementById('active-lan-all-games');
        if (!container) return;
        container.innerHTML = '';

        const gameCount = document.getElementById('vote-history-game-count');
        const voterCount = document.getElementById('vote-history-voter-count');
        const cutCount = document.getElementById('vote-history-cut-count');
        if (gameCount) gameCount.textContent = String(sortedGames.length);
        if (voterCount) voterCount.textContent = String(Object.keys(globalVotes || {}).length);
        if (cutCount) cutCount.textContent = String(Math.min(sortedGames.length, globalSettings.topGamesCount || 10));

        const podium = document.getElementById('vote-history-podium');
        if (podium) podium.innerHTML = '';

        if (sortedGames.length === 0) {
            container.innerHTML = '<div class="vote-history-empty"><strong>Le tableau est encore vierge.</strong><span>Les premiers bulletins feront apparaître le podium ici.</span></div>';
            return;
        }

        if (podium) {
            sortedGames.slice(0, 3).forEach((game, index) => {
                const card = document.createElement('article');
                card.className = `vote-history-podium__card vote-history-podium__card--${index + 1}`;
                card.innerHTML = `
                    <span class="vote-history-podium__place">${index === 0 ? 'LE CHOIX DU GROUPE' : `PLACE ${index + 1}`}</span>
                    <strong>${escapeHtml(game.name)}</strong>
                    <small>${game.score} point${game.score > 1 ? 's' : ''}</small>
                `;
                podium.appendChild(card);
            });
        }

        container.className = 'vote-history-list';
        const maxScore = Math.max(1, Number(sortedGames[0].score) || 1);
        sortedGames.forEach((game, index) => {
            const row = document.createElement('article');
            row.className = 'vote-history-row';
            row.style.setProperty('--vote-share', `${Math.max(4, ((Number(game.score) || 0) / maxScore) * 100).toFixed(2)}%`);
            row.innerHTML = `
                <span class="vote-history-row__rank">${String(index + 1).padStart(2, '0')}</span>
                <div class="vote-history-row__game">
                    <strong>${escapeHtml(game.name)}</strong>
                    <i></i>
                </div>
                <span class="vote-history-row__score">${game.score}<small>pts</small></span>
            `;
            container.appendChild(row);
        });

        players.forEach(uid => {
            closureAchievements(data, uid).forEach(ach => {
                const awardId = achievementAwardId(uid, ach.id);
                if (hasXpAward(globalXp, awardId)) return;
                writes.push(db.ref('lan/xp/awards/' + awardId).set({
                    uid: uid,
                    delta: ach.xp,
                    type: 'achievement',
                    reason: ach.label,
                    refId: ach.id,
                    by: (auth.currentUser && auth.currentUser.uid) || null,
                    ts: firebase.database.ServerValue.TIMESTAMP
                }));
            });
        });
    }

    function showFinalResults() {
        const sortedGames = calculateScores(globalVotes);
        const count = globalSettings.topGamesCount || 10;
        const topGames = sortedGames.slice(0, count);
        const listContainer = document.getElementById('download-list');
        const finalModal = document.getElementById('final-results-modal');

        if (listContainer) {
            listContainer.innerHTML = '';
            listContainer.classList.add('rank-list');
            topGames.forEach((game, index) => {
                const row = buildRankRow(game, index + 1);
                row.classList.add('rank-row--lg');
                // décalage d'apparition en cascade, piloté par le CSS
                row.style.setProperty('--stagger', `${index * 0.1}s`);
                listContainer.appendChild(row);
            });
        }

        if (finalModal) finalModal.style.display = 'flex';
    }

    /* --- Le tableau de bord de la soirée ---------------------------------

       Quatre questions, une réponse chacune : on joue à quoi, il se passe quoi
       ensuite, on mange quoi, qu'est-ce qui attend une décision. Tout le reste
       a sa propre destination dans le rail — l'empiler ici en ferait un
       sommaire de plus. */

    // La partie en cours se déduit du programme : le dernier événement du jour
    // dont l'heure est passée. Personne n'a à déclarer « on joue à ça
    // maintenant » ; le programme le dit déjà.
    function currentAgendaEvent(now) {
        const agenda = buildAgenda(window._latestEventsData || {}, globalSettings.lanDate || '');
        const today = currentDayKey(now);
        const minutes = nowNightMinutes(now);
        let running = null;
        agenda.forEach(day => {
            if (day.dayKey !== today) return;
            day.events.forEach(event => {
                if (event.order === null || event.order > minutes) return;
                if (!running || event.order >= running.order) running = event;
            });
        });
        return running;
    }

    function renderBoardNow() {
        const title = document.getElementById('board-now-title');
        const meta = document.getElementById('board-now-meta');
        if (!title || !meta) return;

        const now = new Date();
        const running = currentAgendaEvent(now);
        const next = nextEventInAgenda(buildAgenda(window._latestEventsData || {}, globalSettings.lanDate || ''), now);

        if (running) {
            title.textContent = running.game || running.title;
            const parts = [];
            if (running.game && running.title !== running.game) parts.push(running.title);
            if (running.time) parts.push('depuis ' + running.time);
            if (running.creatorName) parts.push('lancé par ' + running.creatorName);
            meta.textContent = parts.join(' · ');
            return;
        }

        const top = calculateScores(globalVotes)[0];
        title.textContent = top ? top.name : 'Rien de lancé';
        meta.textContent = next && next.time
            ? 'Rien au programme pour l’instant. Prochain rendez-vous à ' + next.time + '.'
            : 'Le programme ne dit rien de l’heure qu’il est. Le vainqueur du vote reste le pari sûr.';
    }

    function renderBoardOrder() {
        const mount = document.getElementById('board-order-body');
        if (!mount) return;
        mount.innerHTML = '';

        const open = Object.entries(globalFoodRuns || {})
            .map(([id, run]) => Object.assign({ id }, run))
            .filter(run => run && !isRunClosed(run))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        if (!open.length) {
            const empty = document.createElement('p');
            empty.className = 'board-card__hint';
            empty.textContent = 'Aucune commande en cours. Ouvrez-en une quand la faim arrive.';
            mount.appendChild(empty);
            return;
        }

        open.slice(0, 2).forEach(run => {
            const items = Object.values(run.items || {});
            const total = items.reduce((sum, item) => sum + (Number(item.price) || 0), 0);

            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'board-order__row';
            row.addEventListener('click', () => activateDesktopSubview('lan-food'));

            const head = document.createElement('strong');
            head.textContent = run.place || 'Commande groupée';
            const line = document.createElement('span');
            line.textContent = items.length + ' article' + (items.length > 1 ? 's' : '')
                + ' · ' + total.toFixed(2).replace('.', ',') + ' € · ' + pollTimeLeft(run);
            row.append(head, line);
            mount.appendChild(row);
        });
    }

    /* « À valider » ne montre pas la même chose à tout le monde : le maître du
       jeu voit ce qu'il doit trancher, un joueur voit ce qu'il attend. Deux
       files distinctes, un seul panneau — sinon la moitié de la table regarde
       un cadre vide toute la soirée. */
    function renderBoardReview() {
        const mount = document.getElementById('board-review-body');
        const count = document.getElementById('board-review-count');
        if (!mount) return;
        const user = auth.currentUser;
        if (!user) return;
        mount.innerHTML = '';

        const isGm = !!window.currentUserIsGamemaster;
        const claims = Object.values((globalQuests.claims || {}))
            .filter(claim => claim && claim.status === 'pending' && (isGm || claim.uid === user.uid));
        const purchases = pendingPurchases(globalEconomy)
            .filter(purchase => isGm || purchase.uid === user.uid);
        const orders = isGm && (window.currentUserIsMixologist || window.currentUserIsAdmin)
            ? Object.values((window._latestCocktailsData || {}).orders || {}).filter(Boolean)
            : [];

        const rows = [];
        purchases.forEach(purchase => rows.push({
            label: purchase.itemName || 'Article',
            who: isGm ? (purchase.userName || playerLabel(purchase.uid)) : 'ma demande',
            where: 'lan-boutique'
        }));
        claims.forEach(claim => rows.push({
            label: claim.title || 'Défi relevé',
            who: isGm ? (claim.userName || playerLabel(claim.uid)) : 'ma réclamation',
            where: 'lan-defis'
        }));
        orders.forEach(order => rows.push({
            label: order.cocktailName || 'Cocktail',
            who: order.userName || 'Un joueur',
            where: 'lan-food'
        }));

        if (count) count.textContent = rows.length ? String(rows.length) : '';

        if (!rows.length) {
            const empty = document.createElement('p');
            empty.className = 'board-card__hint';
            empty.textContent = isGm
                ? 'Rien à trancher. La table tourne toute seule.'
                : 'Aucune demande en attente de votre côté.';
            mount.appendChild(empty);
            return;
        }

        rows.slice(0, 5).forEach(row => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'board-review__row';
            item.addEventListener('click', () => activateDesktopSubview(row.where));
            const label = document.createElement('strong');
            label.textContent = row.label;
            const who = document.createElement('span');
            who.textContent = row.who;
            item.append(label, who);
            mount.appendChild(item);
        });
    }

    function renderBoard() {
        if (document.getElementById('view-lan-active')?.style.display === 'none') return;
        renderBoardNow();
        renderBoardOrder();
        renderBoardReview();
    }

    /* --- Entre le vote et la soirée -------------------------------------

       Le vote est clos, la LAN n'est pas lancée. C'est la phase la plus
       longue et la seule où l'on ne peut rien faire dans l'application : elle
       doit donc dire tout ce qu'il reste à faire dehors. Trois colonnes — ce
       que le vote a décidé, ce qu'il reste à télécharger, ce qui est annoncé
       — sous un compte à rebours qui descend jusqu'à l'heure dite. */

    function waitingViewIsVisible() {
        const view = document.getElementById('view-waiting-closed');
        return !!view && view.style.display !== 'none';
    }

    function renderWaitingCountdown() {
        const schedule = describeLanSchedule(globalSettings, new Date());
        const band = document.getElementById('waiting-rendezvous');
        if (!band) return;

        const when = document.getElementById('waiting-when');
        const place = document.getElementById('waiting-place');
        const ics = document.getElementById('waiting-ics');
        const cells = document.getElementById('waiting-countdown');

        if (!schedule) {
            band.classList.add('is-empty');
            if (when) when.textContent = 'Date encore à fixer';
            if (place) {
                place.textContent = window.currentUserIsAdmin
                    ? 'Renseignez-la dans « Quand et où », au panneau admin.'
                    : 'L’organisateur ne l’a pas encore annoncée.';
            }
            if (cells) cells.hidden = true;
            if (ics) ics.hidden = true;
            return;
        }

        band.classList.remove('is-empty');
        if (when) {
            when.textContent = schedule.time
                ? schedule.when + ', ' + schedule.time
                : (schedule.when || 'Date encore à fixer');
        }
        if (place) place.textContent = schedule.place ? '\u{1F4CD} ' + schedule.place : '';
        if (ics) ics.hidden = !schedule.startKey;

        // Sans heure de début connue, il n'y a pas de minute à décompter :
        // un compte à rebours inventé vaut moins que pas de compte à rebours.
        const target = schedule.startsAt;
        const left = target ? target.getTime() - Date.now() : null;
        if (cells) cells.hidden = !(left !== null && left > 0);
        if (left === null || left <= 0) return;

        const minutesTotal = Math.floor(left / 60000);
        const set = (id, value) => {
            const node = document.getElementById(id);
            if (node) node.textContent = String(value).padStart(2, '0');
        };
        set('waiting-days', Math.floor(minutesTotal / 1440));
        set('waiting-hours', Math.floor(minutesTotal / 60) % 24);
        set('waiting-minutes', minutesTotal % 60);
    }

    function renderWaitingWinner(sortedGames) {
        const name = document.getElementById('waiting-winner-name');
        const meta = document.getElementById('waiting-winner-meta');
        const runners = document.getElementById('waiting-winner-runners');
        if (!name || !meta || !runners) return;

        const voters = Object.keys(globalVotes || {}).length;
        const winner = sortedGames[0];

        if (!winner) {
            name.textContent = 'Aucun vote';
            meta.textContent = 'Personne n’a déposé de bulletin.';
            runners.innerHTML = '';
            return;
        }

        name.textContent = winner.name;
        meta.textContent = winner.score + ' point' + (winner.score > 1 ? 's' : '')
            + ' · ' + voters + ' votant' + (voters > 1 ? 's' : '');

        runners.innerHTML = '';
        sortedGames.slice(1, 4).forEach((game, index) => {
            const row = document.createElement('div');
            row.className = 'waiting-runners__row';
            const rank = document.createElement('span');
            rank.textContent = '#' + (index + 2);
            const label = document.createElement('strong');
            label.textContent = game.name;
            const score = document.createElement('span');
            score.textContent = game.score + ' pts';
            row.append(rank, label, score);
            runners.appendChild(row);
        });
    }

    /* La checklist d'installation.

       Posséder un jeu et l'avoir installé sont deux choses différentes — et
       c'est justement la seconde qui décide si la soirée peut commencer à
       l'heure. Les bibliothèques Steam ne peuvent donc pas y répondre : chacun
       coche ses jeux lui-même, sous `lan/installed/<uid>/<clé du jeu>`.

       Les règles Firebase n'autorisent l'écriture qu'à son propre nœud. Elles
       doivent être publiées à part : une mise en ligne Vercel ne les publie
       pas, et sans elles la coche sera refusée en silence côté serveur. */
    let globalInstalled = {};

    function installedKey(name) {
        return cardKey(name);
    }

    function installedCount(gameName) {
        const key = installedKey(gameName);
        if (!key) return 0;
        return Object.values(globalInstalled).filter(node => node && node[key] === true).length;
    }

    function iHaveInstalled(gameName) {
        const user = auth.currentUser;
        const key = installedKey(gameName);
        if (!user || !key) return false;
        return !!(globalInstalled[user.uid] && globalInstalled[user.uid][key] === true);
    }

    function toggleInstalled(gameName, checked) {
        const user = auth.currentUser;
        const key = installedKey(gameName);
        if (!user || !key) return;
        const ref = db.ref('lan/installed/' + user.uid + '/' + key);
        const write = checked ? ref.set(true) : ref.remove();
        write.catch(error => showToast('Impossible d’enregistrer : ' + error.message, 'error'));
    }

    function renderWaitingInstall(sortedGames) {
        const mount = document.getElementById('closed-download-list');
        const count = document.getElementById('waiting-install-count');
        const hint = document.getElementById('waiting-install-hint');
        if (!mount) return;

        const top = sortedGames.slice(0, globalSettings.topGamesCount || 10);
        const players = Math.max(1, economyPlayers().length);

        mount.innerHTML = '';
        if (!top.length) {
            mount.innerHTML = '<p class="waiting-card__hint">Le vote n’a rien retenu.</p>';
            if (count) count.textContent = '';
            if (hint) hint.textContent = '';
            return;
        }

        let mine = 0;
        top.forEach((game, index) => {
            const checked = iHaveInstalled(game.name);
            if (checked) mine += 1;

            const row = document.createElement('label');
            row.className = 'waiting-install__row' + (checked ? ' is-ready' : '');

            const box = document.createElement('input');
            box.type = 'checkbox';
            box.className = 'waiting-install__box';
            box.checked = checked;
            box.addEventListener('change', () => toggleInstalled(game.name, box.checked));

            const label = document.createElement('span');
            label.className = 'waiting-install__name';
            label.textContent = (index + 1) + '. ' + game.name;

            const state = document.createElement('span');
            state.className = 'waiting-install__state';
            state.textContent = installedCount(game.name) + ' / ' + players + ' installé' + (players > 1 ? 's' : '');

            row.append(box, label, state);
            mount.appendChild(row);
        });

        if (count) count.textContent = mine + ' / ' + top.length + ' prêts';
        if (hint) {
            hint.textContent = mine === top.length
                ? 'Tout est installé chez toi. Il ne reste plus qu’à attendre.'
                : 'Coche ce que tu as vraiment installé — posséder un jeu ne suffit pas à le lancer samedi.';
        }
    }

    function renderWaitingProgramme() {
        const mount = document.getElementById('waiting-programme-list');
        if (!mount) return;
        mount.innerHTML = '';

        const agenda = buildAgenda(window._latestEventsData || {}, globalSettings.lanDate || '');
        const rows = [];
        agenda.forEach(day => day.events.forEach(event => rows.push({ day: day.dayKey, event: event })));

        if (!rows.length) {
            const empty = document.createElement('p');
            empty.className = 'waiting-card__hint';
            empty.textContent = 'Rien n’est encore annoncé. Le programme s’écrit pendant la soirée.';
            mount.appendChild(empty);
            return;
        }

        rows.slice(0, 7).forEach(row => {
            const line = document.createElement('div');
            line.className = 'waiting-programme__row';
            const time = document.createElement('span');
            time.className = 'waiting-programme__time';
            time.textContent = row.event.time || '—';
            const label = document.createElement('strong');
            label.textContent = row.event.title || 'Sans titre';
            line.append(time, label);
            mount.appendChild(line);
        });
    }

    function renderWaitingClosed() {
        if (!waitingViewIsVisible()) return;

        const sortedGames = calculateScores(globalVotes);
        const subtitle = document.getElementById('waiting-subtitle');
        if (subtitle) {
            subtitle.textContent = sortedGames.length
                ? 'Le classement est arrêté. Il reste à télécharger, et à attendre.'
                : 'Les bulletins sont clos. Personne n’a voté : la liste reste ouverte à l’organisateur.';
        }

        renderWaitingCountdown();
        renderWaitingWinner(sortedGames);
        renderWaitingInstall(sortedGames);
        renderWaitingProgramme();
    }

    document.getElementById('waiting-ics')?.addEventListener('click', downloadLanIcs);

    // --- PHASE 4: ACTIVE LAN LOGIC ---

    // Event Reminders : toast when a registered event is coming up within 15 minutes
    const remindedEventIds = new Set();

    // Rappels système : utiles quand l'onglet est en arrière-plan, là où un
    // toast passerait inaperçu. Le toast est conservé dans tous les cas.
    function requestReminderPermission() {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'default') return;
        Notification.requestPermission().catch(() => { /* refus : on garde les toasts */ });
    }

    function showReminderNotification(title, body) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        try {
            new Notification(title, { body, icon: '/favicon.ico', tag: title });
        } catch (error) {
            // Certains navigateurs exigent un service worker : on ignore, le toast reste
            console.debug('Notification indisponible:', error);
        }
    }

    function checkEventReminders(eventsData, currentUser) {
        if (!eventsData || !currentUser) return;
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const today = currentDayKey(now);

        Object.entries(eventsData).forEach(([id, evt]) => {
            if (!evt.time || remindedEventIds.has(id)) return;
            // Only remind if the user has accepted this event
            if (!evt.rsvps || evt.rsvps[currentUser.uid] !== 'accepted') return;
            // Un événement daté d'un autre jour ne se rappelle pas aujourd'hui :
            // sans ce filtre, une LAN sur deux jours annonçait dès le samedi les
            // tournois du dimanche.
            const dayKey = eventDayKey(evt, globalSettings.lanDate || '');
            if (dayKey && dayKey !== today) return;
            // Parse time "HH:MM"
            const [h, m] = evt.time.split(':').map(Number);
            if (isNaN(h) || isNaN(m)) return;
            const eventMinutes = h * 60 + m;
            const diff = eventMinutes - currentMinutes;
            // Remind if event is between 1 and 15 minutes away
            if (diff > 0 && diff <= 15) {
                remindedEventIds.add(id);
                showToast(`⏰ Rappel : "${evt.title}" commence à ${evt.time} !`, 'success');
                showReminderNotification(
                    `⏰ ${evt.title}`,
                    `Ça commence à ${evt.time} : dans ${diff} minute(s).`
                );
            }
        });
    }

    // 4. Navigation : re-render data on tab switch
    document.querySelectorAll('.lan-nav-list .nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const targetId = e.currentTarget.dataset.target;
            // Le bar a rejoint la table : une seule porte, deux rendus.
            if (targetId === 'lan-food') {
                renderFoodRuns();
                if (window._latestCocktailsData) renderCocktails(window._latestCocktailsData, auth.currentUser);
            }
            if (targetId === 'lan-defis') {
                renderDefis();
            }
            if (targetId === 'lan-polls') {
                renderPolls();
            }
            if (targetId === 'lan-library') {
                renderGroupLibrary();
            }
            if (targetId === 'lan-calendar') {
                renderWhenWhere();
                renderAgenda();
            }
            // Deactivate all
            document.querySelectorAll('.lan-nav-list .nav-item').forEach(nav => nav.classList.remove('active'));
            document.querySelectorAll('.lan-subview').forEach(view => {
                view.style.display = 'none';
                view.classList.remove('active');
            });

            // Activate target : reuse targetId already declared above
            e.currentTarget.classList.add('active');
            const targetView = document.getElementById(targetId);
            if (targetView) {
                targetView.style.display = 'block';
                targetView.classList.add('active');
            }

            /* Après l'affichage, pas avant : renderCollection ne dessine la
               grille que si son panneau est visible (cinq cents cartes ne se
               redessinent pas à chaque mise à jour Firebase pour personne), et
               au moment du clic il ne l'était pas encore. */
            if (targetId === 'lan-tcg') renderCollection();
            // Même raison pour la Boutique : ses volets fermés ne construisent
            // rien, et au moment du clic aucun n'était encore « actif ».
            if (targetId === 'lan-boutique') renderBoutique();
        });
    });

    // 2. Modals (Events & Kocktails)
    function openCreateEventModal() {
        const createModal = document.getElementById('create-event-modal');
        if (createModal) createModal.style.display = 'flex';

        // Le jour part sur la date de la LAN : l'écrasante majorité des
        // événements s'y déroule, et le laisser vide les jetait « sans date ».
        const dateInput = document.getElementById('event-date');
        if (dateInput && !dateInput.value) dateInput.value = globalSettings.lanDate || '';

        if (window.currentUserIsAdmin) {
            const toggleContainer = document.getElementById('event-global-toggle-container');
            if (toggleContainer) toggleContainer.style.display = 'flex';
        }
    }

    document.getElementById('board-action-event')?.addEventListener('click', openCreateEventModal);
    document.getElementById('btn-create-event-calendar')?.addEventListener('click', openCreateEventModal);

    document.getElementById('btn-goto-calendar')?.addEventListener('click', () => {
        activateDesktopSubview('lan-calendar');
    });
    bindScheduleForms();

    document.getElementById('cancel-event-btn')?.addEventListener('click', () => {
        const createModal = document.getElementById('create-event-modal');
        if (createModal) createModal.style.display = 'none';
    });

    const playerModal = document.getElementById('player-votes-modal');
    const closePlayerModal = () => {
        if (playerModal) playerModal.style.display = 'none';
        openProfileUid = null;
        openProfileName = '';
        profileDraft = null;
    };
    document.getElementById('close-player-votes-btn')?.addEventListener('click', closePlayerModal);
    playerModal?.addEventListener('click', (event) => {
        if (event.target === playerModal) closePlayerModal();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && playerModal?.style.display === 'flex') closePlayerModal();
    });

    document.getElementById('player-prof-customize-btn')?.addEventListener('click', () => {
        const user = auth.currentUser;
        if (!user || user.uid !== openProfileUid) return;
        const profile = playerProfile(achData(), user.uid);
        profileDraft = {
            titleId: profile.equippedTitle ? profile.equippedTitle.id : '',
            featuredIds: [1, 2, 3]
                .map(index => (globalProfiles[user.uid] || {})['featuredAchievement' + index])
                .filter(Boolean)
        };
        const panel = document.getElementById('player-prof-customizer');
        if (panel) panel.hidden = false;
        renderProfileCustomizer(profile);
        panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    document.getElementById('player-prof-customize-cancel')?.addEventListener('click', () => {
        profileDraft = null;
        const panel = document.getElementById('player-prof-customizer');
        if (panel) panel.hidden = true;
        if (openProfileUid) renderPlayerProfileHead(openProfileUid, openProfileName);
    });

    document.getElementById('player-prof-customize-save')?.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user || user.uid !== openProfileUid || !profileDraft) return;
        const update = { equippedTitleId: profileDraft.titleId || null };
        [1, 2, 3].forEach(index => {
            update['featuredAchievement' + index] = profileDraft.featuredIds[index - 1] || null;
        });
        try {
            await db.ref('lan/users/' + user.uid).update(update);
            profileDraft = null;
            const panel = document.getElementById('player-prof-customizer');
            if (panel) panel.hidden = true;
            showToast('Ta signature est enregistrée.', 'success');
        } catch (error) {
            showToast('Impossible d’enregistrer ce profil : ' + error.message, 'error');
        }
    });

    // --- HISTORIQUE ---
    function openLanHistory() {
        const modal = document.getElementById('history-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        const container = document.getElementById('history-list-container');
        if (!container) return;
        container.innerHTML = '<div style="text-align:center; color:var(--secondary-text);">Chargement...</div>';

        db.ref('lan/history').orderByChild('timestamp').once('value').then(snapshot => {
            const data = snapshot.val();
            container.innerHTML = '';
            if (!data) {
                container.innerHTML = '<p style="text-align:center; color:var(--secondary-text); font-style:italic;">Aucun historique disponible.</p>';
                return;
            }
            const entries = Object.entries(data).map(([id, d]) => ({ id, ...d }));
            entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            entries.forEach(entry => {
                const card = document.createElement('div');
                card.className = 'content-card';

                const header = document.createElement('div');
                header.className = 'card-header';
                header.innerHTML = `<h3 class="card-header__title">${escapeHtml(entry.name || 'LAN')}</h3><span class="card-header__meta">${escapeHtml(entry.date || '')}</span>`;

                // Les LAN de test s'accumulent dans l'historique : les admins
                // doivent pouvoir en supprimer une.
                if (window.currentUserIsAdmin) {
                    const del = document.createElement('button');
                    del.className = 'danger-link-btn';
                    del.textContent = 'Supprimer';
                    del.addEventListener('click', () => {
                        askConfirm(`Supprimer « ${entry.name || 'LAN'} » de l'historique ?`, { danger: true })
                            .then(ok => {
                                if (!ok) return;
                                db.ref(`lan/history/${entry.id}`).remove()
                                    .then(() => {
                                        card.remove();
                                        showToast('LAN supprimée de l\'historique.', 'success');
                                        if (!container.querySelector('.content-card')) {
                                            container.innerHTML = '<p style="text-align:center; color:var(--secondary-text); font-style:italic;">Aucun historique disponible.</p>';
                                        }
                                    })
                                    .catch(err => showToast('Suppression refusée : ' + err.message, 'error'));
                            });
                    });
                    header.appendChild(del);
                }

                card.appendChild(header);

                if (entry.topGames && entry.topGames.length > 0) {
                    const list = document.createElement('div');
                    list.className = 'stack stack--xs';
                    entry.topGames.slice(0, 5).forEach((game, i) => {
                        const row = document.createElement('div');
                        row.className = 'player-row';
                        row.innerHTML = `<span class="player-row__rank">#${i + 1}</span><span class="player-row__name">${escapeHtml(game.name)}</span><span class="player-row__score">${game.score} pts</span>`;
                        list.appendChild(row);
                    });
                    card.appendChild(list);
                }
                container.appendChild(card);
            });
        });
    }

    document.getElementById('close-history-modal-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('history-modal');
        if (modal) modal.style.display = 'none';
    });
    document.getElementById('history-modal')?.addEventListener('click', function (e) {
        if (e.target === this) this.style.display = 'none';
    });

    // --- OUVRIR LA LAN (from admin dashboard) ---
    document.getElementById('btn-open-lan-dashboard')?.addEventListener('click', () => {
        askConfirm("Ouvrir la LAN en mode actif ? Tout le monde passera en mode LAN active.",
            { title: '🔥 Ouvrir la LAN' }).then(ok => {
                if (!ok) return;
                db.ref('lan/settings').update({ isLanActive: true })
                    .then(() => showToast("La LAN est officiellement ouverte ! 🔥", "success"));
            });
    });

    // --- ADMIN BROADCAST NOTIFICATION ---
    // Une seule fonction pour les deux panneaux admin (console + onglet Admin de la LAN active).
    // Type 'alert' pour que le toast s'affiche immédiatement chez les joueurs, comme promis par l'UI.
    const handleBroadcast = (inputId) => {
        const msgInput = document.getElementById(inputId);
        if (!msgInput) return;
        const message = msgInput.value.trim();
        if (!message) { showToast('Saisissez un message d\'abord.', 'error'); return; }

        // On touche les joueurs connectés ET tous les votants (au cas où quelqu'un est déconnecté)
        Promise.all([db.ref('/status').once('value'), db.ref('lan/votes').once('value')])
            .then(([statusSnap, votesSnap]) => {
                const uids = new Set([
                    ...Object.keys(statusSnap.val() || {}),
                    ...Object.keys(votesSnap.val() || {})
                ]);
                const sends = [...uids].map(uid => sendNotification(uid, `🍊 Admin: ${message}`, 'alert'));
                Promise.all(sends).then(() => {
                    showToast(`Message envoyé à ${sends.length} joueur(s) !`, 'success');
                    msgInput.value = '';
                });
            });
    };
    document.getElementById('btn-send-broadcast')?.addEventListener('click', () => handleBroadcast('broadcast-message'));
    document.getElementById('btn-send-broadcast-lan')?.addEventListener('click', () => handleBroadcast('broadcast-message-lan'));

    document.getElementById('btn-assign-role')?.addEventListener('click', () => {
        const uid = document.getElementById('role-user-select').value;
        const role = document.getElementById('role-type-select').value;
        if (!uid) { showToast('Veuillez sélectionner un joueur.', 'error'); return; }

        db.ref('lan/roles/' + uid).set(role)
            .then(() => showToast('Rôle mis à jour avec succès !', 'success'))
            .catch(err => showToast('Erreur: ' + err.message, 'error'));
    });

    // Active LAN admin panel : role assignment
    document.getElementById('btn-assign-role-lan')?.addEventListener('click', () => {
        const uid = document.getElementById('role-user-select-lan').value;
        const role = document.getElementById('role-type-select-lan').value;
        if (!uid) { showToast('Veuillez sélectionner un joueur.', 'error'); return; }

        db.ref('lan/roles/' + uid).set(role)
            .then(() => showToast('Rôle mis à jour avec succès !', 'success'))
            .catch(err => showToast('Erreur: ' + err.message, 'error'));
    });

    // Active LAN admin panel : toggle voting button
    document.getElementById('toggle-voting-btn-dashboard-lan')?.addEventListener('click', handleToggleVoting);

    // Handle Event Creation (with description + notifications)
    const createEventForm = document.getElementById('create-event-form');
    if (createEventForm) {
        createEventForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const user = auth.currentUser;
            if (!user) return;

            const title = document.getElementById('event-title').value;
            const game = document.getElementById('event-game').value;
            const time = document.getElementById('event-time').value;
            const date = document.getElementById('event-date')?.value || '';
            const slots = document.getElementById('event-slots').value;
            const desc = document.getElementById('event-desc')?.value || '';
            const isGlobal = document.getElementById('event-is-global')?.checked || false;
            const isAlcohol = document.getElementById('event-is-alcohol')?.checked || false;
            const alcoholRules = document.getElementById('event-alcohol-rules')?.value || '';

            const newEvent = {
                title: title,
                description: desc,
                game: game || '',
                time: time || '',
                date: date || '',
                slots: slots ? parseInt(slots) : 0,
                creatorId: user.uid,
                creatorName: user.displayName,
                isGlobal: isGlobal,
                isAlcohol: isAlcohol,
                alcoholRules: alcoholRules,
                rsvps: {},
                createdAt: firebase.database.ServerValue.TIMESTAMP
            };

            // Creator auto-accepts
            newEvent.rsvps[user.uid] = 'accepted';

            const newEventRef = eventsRef.push();
            newEventRef.set(newEvent)
                .then(() => {
                    showToast("Événement créé avec succès !", "success");
                    // Send notifications to everyone for all events (invasive if global)
                    db.ref('/status').once('value').then(snap => {
                        const users = snap.val() || {};
                        const notifType = isGlobal ? 'alert' : 'info';
                        const emoji = isGlobal ? '🌍' : '🎮';
                        const when = describeEventWhen({ date, time });
                        Object.keys(users).forEach(uid => {
                            if (uid !== user.uid) {
                                sendNotification(uid,
                                    `${emoji} ${user.displayName} a créé un événement : "${title}"${when ? ' ' + when : ''}`,
                                    notifType
                                );
                            }
                        });
                    });
                    const createModal = document.getElementById('create-event-modal');
                    if (createModal) createModal.style.display = 'none';
                    createEventForm.reset();
                })
                .catch(err => {
                    showToast("Erreur lors de la création de l'événement.", "error");
                    console.error(err);
                });
        });
    }

    // --- KOCKTAILS: ONE-SHOT CREATION ---
    document.getElementById('btn-create-kocktail')?.addEventListener('click', () => {
        const modal = document.getElementById('create-kocktail-modal');
        if (modal) modal.style.display = 'flex';
    });
    document.getElementById('cancel-kocktail-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('create-kocktail-modal');
        if (modal) modal.style.display = 'none';
    });
    document.getElementById('create-kocktail-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const user = auth.currentUser;
        if (!user) return;
        const name = document.getElementById('kocktail-name').value.trim();
        const recipe = document.getElementById('kocktail-recipe').value.trim();
        if (!name) { showToast('Donnez un nom à votre création !', 'error'); return; }

        db.ref('lan/cocktails/oneshot').push({
            name: name,
            recipe: recipe,
            creatorId: user.uid,
            creatorName: user.displayName,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            showToast(`"${name}" ajouté aux One-Shots !`, 'success');
            const modal = document.getElementById('create-kocktail-modal');
            if (modal) modal.style.display = 'none';
            e.target.reset();
        }).catch(err => showToast('Erreur: ' + err.message, 'error'));
    });

    // --- KOCKTAILS: ADMIN MASTER LIST MANAGEMENT ---
    document.getElementById('btn-add-master-kocktail')?.addEventListener('click', () => {
        const modal = document.getElementById('add-master-kocktail-modal');
        if (modal) modal.style.display = 'flex';
    });
    document.getElementById('cancel-master-kocktail-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('add-master-kocktail-modal');
        if (modal) modal.style.display = 'none';
    });
    document.getElementById('add-master-kocktail-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const user = auth.currentUser;
        if (!user) return;
        const name = document.getElementById('master-kocktail-name').value.trim();
        const ingredients = document.getElementById('master-kocktail-ingredients').value.trim();
        if (!name) { showToast('Donnez un nom au cocktail !', 'error'); return; }

        db.ref('lan/cocktails/masterList').push({
            name: name,
            ingredients: ingredients
        }).then(() => {
            showToast(`"${name}" ajouté à la carte !`, 'success');
            const modal = document.getElementById('add-master-kocktail-modal');
            if (modal) modal.style.display = 'none';
            e.target.reset();
        }).catch(err => showToast('Erreur (vérifiez les règles Firebase): ' + err.message, 'error'));
    });

    // 3. Notifications bell  toggle
    const btnNotifications = document.getElementById('btn-notifications');
    const notifPanel = document.getElementById('notifications-panel');
    btnNotifications?.addEventListener('click', (e) => {
        if (!notifPanel) return;
        // sans ça, le clic remonte jusqu'au document et referme aussitôt le panneau
        e.stopPropagation();
        notifPanel.style.display = (notifPanel.style.display === 'none' || !notifPanel.style.display) ? 'block' : 'none';
    });

    // Un panneau qui ne se ferme qu'en recliquant la cloche est pénible :
    // on le referme aussi au clic ailleurs et à la touche Échap.
    document.addEventListener('click', (e) => {
        if (!notifPanel || notifPanel.style.display !== 'block') return;
        if (notifPanel.contains(e.target) || btnNotifications?.contains(e.target)) return;
        notifPanel.style.display = 'none';
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && notifPanel && notifPanel.style.display === 'block') {
            notifPanel.style.display = 'none';
        }
    });


    /* ======================================================================
       LA MODALE DE SAISIE
       Elle remplace window.prompt, qui sortait complètement de la charte et,
       pour créer un seul défi, enchaînait CINQ boîtes grises à la suite —
       impossible de revenir en arrière, impossible de voir ce qu'on avait déjà
       saisi. Un formulaire, une fois, avec le style du reste.

       Rend une promesse : les valeurs saisies, ou null si on annule.
       ====================================================================== */

    function openFormModal(options) {
        const modal = document.getElementById('form-modal');
        const mount = document.getElementById('form-modal-fields');
        const intro = document.getElementById('form-modal-intro');
        const ok = document.getElementById('form-modal-ok');
        const cancel = document.getElementById('form-modal-cancel');
        if (!modal || !mount) return Promise.resolve(null);

        document.getElementById('form-modal-title').textContent = options.title || '';
        intro.textContent = options.intro || '';
        intro.style.display = options.intro ? 'block' : 'none';
        ok.textContent = options.submitLabel || 'Valider';

        mount.innerHTML = '';
        const inputs = {};

        (options.fields || []).forEach(field => {
            const group = document.createElement('div');
            group.className = 'admin-select-group';

            if (field.label) {
                const label = document.createElement('label');
                label.textContent = field.label;
                group.appendChild(label);
            }

            let input;
            if (field.type === 'textarea') {
                input = document.createElement('textarea');
                input.rows = field.rows || 3;
                input.style.resize = 'vertical';
            } else if (field.type === 'select') {
                input = document.createElement('select');
                (field.options || []).forEach(opt => {
                    const node = document.createElement('option');
                    node.value = opt.value;
                    node.textContent = opt.label;
                    input.appendChild(node);
                });
            } else {
                input = document.createElement('input');
                input.type = field.type === 'number' ? 'number' : 'text';
                if (field.min !== undefined) input.min = String(field.min);
                if (field.max !== undefined) input.max = String(field.max);
            }

            input.className = 'luxury-input shop-field';
            if (field.placeholder) input.placeholder = field.placeholder;
            if (field.value !== undefined && field.value !== null) input.value = String(field.value);
            group.appendChild(input);

            if (field.hint) {
                const hint = document.createElement('p');
                hint.className = 'panel-section__hint';
                hint.style.margin = '4px 0 0';
                hint.textContent = field.hint;
                group.appendChild(hint);
            }

            inputs[field.key] = input;
            mount.appendChild(group);
        });

        modal.style.display = 'flex';
        const first = Object.values(inputs)[0];
        if (first) { first.focus(); if (first.select) first.select(); }

        return new Promise(resolve => {
            const close = (value) => {
                modal.style.display = 'none';
                /* On remplace les gestionnaires plutôt que d'en empiler : la
                   modale sert à tout, et deux ouvertures laisseraient deux
                   écouteurs qui résoudraient deux promesses. */
                ok.onclick = null;
                cancel.onclick = null;
                modal.onclick = null;
                document.removeEventListener('keydown', onKey);
                resolve(value);
            };
            const submit = () => {
                const values = {};
                Object.keys(inputs).forEach(key => { values[key] = inputs[key].value; });
                close(values);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') close(null);
                /* Entrée valide, sauf dans une zone de texte où elle sert à
                   passer à la ligne. */
                if (e.key === 'Enter' && e.target && e.target.tagName !== 'TEXTAREA') submit();
            };

            ok.onclick = submit;
            cancel.onclick = () => close(null);
            modal.onclick = (e) => { if (e.target === modal) close(null); };
            document.addEventListener('keydown', onKey);
        });
    }

    /* La liste des autres joueurs, prête pour un champ « select ». */
    function playerOptions(includeNone) {
        const user = auth.currentUser;
        const list = includeNone ? [{ value: '', label: 'Personne' }] : [];
        economyPlayers()
            .filter(uid => !user || uid !== user.uid)
            .forEach(uid => list.push({ value: uid, label: playerLabel(uid) }));
        return list;
    }

    /* ======================================================================
       PROGRAMME : quand & où a lieu la LAN, puis le déroulé de la soirée.
       Le calcul (jour, ordre, compte à rebours) vit dans core.js ; ici on ne
       fait que le mettre à l'écran.
       ====================================================================== */

    const twoDigits = (n) => String(n).padStart(2, '0');

    // "demain à 21:00", "à 21:00", "samedi 13 septembre" — vide si rien n'est su.
    function describeEventWhen(evt) {
        const dayKey = evt && parseDayKey(evt.date) ? String(evt.date).trim() : '';
        const time = evt && parseClock(evt.time) !== null ? String(evt.time).trim() : '';
        const distance = dayKey ? dayKeyDistance(currentDayKey(new Date()), dayKey) : null;

        let day = '';
        // Le jour même se passe de mention : « à 21:00 » suffit.
        if (dayKey && distance !== 0) {
            if (distance === 1) day = 'demain';
            else day = parseDayKey(dayKey).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
        }

        if (day && time) return `${day} à ${time}`;
        return day || (time ? `à ${time}` : '');
    }

    /* --- Quand et où ----------------------------------------------------- */

    const WHEN_WHERE_MOUNTS = ['when-where-voting', 'when-where-calendar'];

    function buildWhenWhereContent(schedule) {
        const fragment = document.createDocumentFragment();

        const main = document.createElement('div');
        main.className = 'when-where__main';

        const eyebrow = document.createElement('span');
        eyebrow.className = 'when-where__eyebrow';
        eyebrow.textContent = 'Rendez-vous';
        main.appendChild(eyebrow);

        const when = document.createElement('p');
        when.className = 'when-where__when';
        when.textContent = schedule.when || 'Date encore à fixer';
        if (schedule.time) {
            const time = document.createElement('span');
            time.className = 'when-where__time';
            time.textContent = ` dès ${schedule.time}`;
            when.appendChild(time);
        }
        main.appendChild(when);

        if (schedule.place) {
            const place = document.createElement('p');
            place.className = 'when-where__place';
            place.textContent = `📍 ${schedule.place}`;
            main.appendChild(place);
        }
        fragment.appendChild(main);

        const side = document.createElement('div');
        side.className = 'when-where__side';

        if (schedule.countdown) {
            const countdown = document.createElement('span');
            countdown.className = `when-where__countdown when-where__countdown--${schedule.state}`;
            countdown.textContent = schedule.countdown;
            side.appendChild(countdown);
        }

        if (schedule.startKey) {
            const ics = document.createElement('button');
            ics.className = 'gold-link-btn';
            ics.textContent = '📆 Ajouter à mon agenda';
            ics.addEventListener('click', downloadLanIcs);
            side.appendChild(ics);
        }
        fragment.appendChild(side);

        return fragment;
    }

    function renderWhenWhere() {
        const schedule = describeLanSchedule(globalSettings, new Date());

        WHEN_WHERE_MOUNTS.forEach(id => {
            const mount = document.getElementById(id);
            if (!mount) return;
            mount.innerHTML = '';

            if (!schedule) {
                // Rien d'annoncé : seul l'admin voit le rappel. Les autres n'ont
                // pas à contempler un cadre vide.
                mount.classList.add('when-where--empty');
                if (!window.currentUserIsAdmin) {
                    mount.style.display = 'none';
                    return;
                }
                mount.style.display = 'flex';
                const hint = document.createElement('p');
                hint.className = 'when-where__hint';
                hint.textContent = 'Ni date ni lieu annoncés. Renseignez-les dans « Quand et où », au panneau Admin.';
                mount.appendChild(hint);
                return;
            }

            mount.classList.remove('when-where--empty');
            mount.style.display = 'flex';
            mount.appendChild(buildWhenWhereContent(schedule));
        });
    }

    // Fichier .ics : chacun pose la LAN dans son propre agenda et n'a plus à
    // se souvenir de la date.
    function downloadLanIcs() {
        const ics = buildLanIcs(globalSettings);
        if (!ics) {
            showToast("Aucune date n'est encore annoncée.", 'error');
            return;
        }

        const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${(globalSettings.lanName || 'LAN Demain').replace(/[^\w\- ]+/g, '').trim() || 'lan'}.ics`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Certains navigateurs n'ont pas fini de lire le blob au retour du clic.
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    /* --- Réglages « quand & où » (admin) --------------------------------- */

    // Les deux panneaux d'admin (console fermée, LAN active) portent les mêmes
    // champs data-schedule : un seul code les remplit et les enregistre.
    function fillScheduleInputs() {
        document.querySelectorAll('[data-schedule]').forEach(input => {
            // Ne pas écraser une saisie en cours : la mise à jour temps réel
            // arrive pendant que l'admin tape.
            if (document.activeElement === input) return;
            input.value = globalSettings[input.dataset.schedule] || '';
        });
    }

    function bindScheduleForms() {
        document.querySelectorAll('.schedule-form .schedule-save-btn').forEach(button => {
            button.addEventListener('click', () => {
                const form = button.closest('.schedule-form');
                if (!form) return;

                const update = {};
                form.querySelectorAll('[data-schedule]').forEach(input => {
                    update[input.dataset.schedule] = input.value.trim();
                });

                if (update.lanEndDate && update.lanDate && update.lanEndDate < update.lanDate) {
                    showToast('La date de fin tombe avant le début.', 'error');
                    return;
                }

                db.ref('lan/settings').update(update)
                    .then(() => showToast('Date et lieu annoncés à tout le monde.', 'success'))
                    .catch(error => showToast('Erreur : ' + error.message, 'error'));
            });
        });
    }

    /* --- Le programme ---------------------------------------------------- */

    function buildNowMarker(now) {
        const marker = document.createElement('li');
        marker.className = 'agenda__now';
        const label = document.createElement('span');
        label.className = 'agenda__now-label';
        label.textContent = `maintenant · ${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}`;
        marker.appendChild(label);
        return marker;
    }

    function buildAgendaSlot(evt, flags) {
        const item = document.createElement('li');
        item.className = 'agenda__slot';
        if (flags.isPast) item.classList.add('is-past');
        if (flags.isNext) item.classList.add('is-next');
        if (evt.isGlobal) item.classList.add('is-global');

        const time = document.createElement('span');
        time.className = 'agenda__time';
        // Un événement sans heure se joue « quelque part dans la soirée ».
        time.textContent = evt.time || '· · ·';
        item.appendChild(time);

        const body = document.createElement('div');
        body.className = 'agenda__body';

        const title = document.createElement('h4');
        title.className = 'agenda__title';
        title.textContent = `${evt.isGlobal ? '🌍 ' : ''}${evt.title || 'Événement'}`;
        if (flags.isNext) {
            const tag = document.createElement('span');
            tag.className = 'agenda__tag';
            tag.textContent = 'à suivre';
            title.appendChild(tag);
        }
        body.appendChild(title);

        const rsvpCount = evt.rsvps ? Object.values(evt.rsvps).filter(v => v === 'accepted').length : 0;
        const details = [];
        if (evt.game) details.push(`🎮 ${evt.game}`);
        details.push(evt.slots > 0 ? `👥 ${rsvpCount}/${evt.slots}` : `👥 ${rsvpCount}`);
        if (evt.isAlcohol) details.push('🥃 jeu à boire');
        if (evt.creatorName) details.push(`par ${evt.creatorName}`);

        const meta = document.createElement('p');
        meta.className = 'agenda__meta';
        meta.textContent = details.join(' · ');
        body.appendChild(meta);

        item.appendChild(body);

        const currentUser = auth.currentUser;
        if (currentUser) {
            const accepted = evt.rsvps && evt.rsvps[currentUser.uid] === 'accepted';
            const isCreator = evt.creatorId === currentUser.uid;

            if (accepted && isCreator) {
                const badge = document.createElement('span');
                badge.className = 'badge badge--accent';
                badge.textContent = '✓ Organisateur';
                item.appendChild(badge);
            } else if (accepted) {
                const badge = document.createElement('button');
                badge.className = 'badge badge--success badge--clickable';
                badge.textContent = '✓ Inscrit';
                badge.title = 'Cliquer pour annuler votre participation';
                badge.addEventListener('click', () => {
                    db.ref(`lan/events/${evt.id}/rsvps/${currentUser.uid}`).remove();
                });
                item.appendChild(badge);
            } else {
                const join = document.createElement('button');
                join.className = 'gold-link-btn';
                join.textContent = 'Participer';
                join.addEventListener('click', () => {
                    db.ref(`lan/events/${evt.id}/rsvps/${currentUser.uid}`).set('accepted');
                    requestReminderPermission();
                });
                item.appendChild(join);
            }
        }

        return item;
    }

    function renderAgenda() {
        const mount = document.getElementById('agenda-timeline');
        if (!mount) return;
        mount.innerHTML = '';

        const now = new Date();
        const agenda = buildAgenda(window._latestEventsData || {}, globalSettings.lanDate || '');

        if (!agenda.length) {
            const empty = document.createElement('p');
            empty.className = 'agenda__empty';
            empty.textContent = "Le programme est encore vide. Créez un événement pour l'ouvrir.";
            mount.appendChild(empty);
            return;
        }

        const today = currentDayKey(now);
        const nowOrder = nowNightMinutes(now);
        const next = nextEventInAgenda(agenda, now);

        agenda.forEach(day => {
            const section = document.createElement('section');
            section.className = 'agenda__day';
            const isToday = !!day.dayKey && day.dayKey === today;
            if (isToday) section.classList.add('agenda__day--today');

            const head = document.createElement('header');
            head.className = 'agenda__day-head';

            const title = document.createElement('h3');
            title.textContent = formatDayLabel(day.dayKey, now);
            head.appendChild(title);

            const count = document.createElement('span');
            count.className = 'agenda__day-count';
            count.textContent = `${day.events.length} événement${day.events.length > 1 ? 's' : ''}`;
            head.appendChild(count);
            section.appendChild(head);

            const list = document.createElement('ol');
            list.className = 'agenda__list';

            // Le trait « maintenant » n'a de sens que sur la journée en cours.
            let markerPlaced = !isToday;
            day.events.forEach(evt => {
                if (!markerPlaced && evt.order !== null && evt.order > nowOrder) {
                    list.appendChild(buildNowMarker(now));
                    markerPlaced = true;
                }
                list.appendChild(buildAgendaSlot(evt, {
                    isPast: isEventPast(evt, now),
                    isNext: !!next && next.id === evt.id
                }));
            });
            // Tout est déjà passé : le trait ferme la journée.
            if (!markerPlaced) list.appendChild(buildNowMarker(now));

            section.appendChild(list);
            mount.appendChild(section);
        });
    }

    /* --- L'aperçu du programme sur le tableau de bord ---------------------

       Il n'y a plus qu'un écran d'événements : le Programme, qui les groupe par
       jour et marque celui « à suivre ». La liste de fiches à plat montrait les
       mêmes données avec les mêmes actions — deux écrans pour une chose. Ne
       reste ici que les trois prochains, pour le tableau de bord. */
    function renderEvents(eventsData) {
        const previewList = document.getElementById('upcoming-events-preview');
        if (!previewList) return;
        previewList.innerHTML = '';

        const now = new Date();
        const eventsArray = flattenAgenda(buildAgenda(eventsData, globalSettings.lanDate || ''));

        if (eventsArray.length === 0) {
            previewList.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Rien de prévu pour le moment.</p>';
            return;
        }

        // Une soirée entièrement jouée retombe sur les derniers événements,
        // faute de mieux : un cadre vide n'apprendrait rien.
        const upcoming = eventsArray.filter(evt => !isEventPast(evt, now));
        const previewSource = upcoming.length ? upcoming : eventsArray.slice(-3);

        previewSource.slice(0, 3).forEach(evt => {
            const rsvpCount = evt.rsvps ? Object.values(evt.rsvps).filter(v => v === 'accepted').length : 0;
            const when = describeEventWhen(evt);
            const previewItem = document.createElement('div');
            previewItem.className = 'list-item';
            previewItem.innerHTML = `
                   <div>
                       <div style="color: var(--primary-text); font-weight: 500;">${evt.isGlobal ? '🌍 ' : ''}${escapeHtml(evt.title)}</div>
                       <div style="font-size: 0.85em; color: var(--secondary-text);">${escapeHtml(evt.game || '')} ${escapeHtml(when)}</div>
                   </div>
                   <div style="font-size: 0.85em; color: var(--accent-color);">👥 ${rsvpCount}</div>
               `;
            previewList.appendChild(previewItem);
        });
    }

    // Bouton de suppression d'un kocktail. La permission est vérifiée par les
    // règles Firebase ; ici on ne fait qu'afficher le bouton aux personnes concernées.
    function buildDeleteKocktailBtn(refPath, kocktailName) {
        const btn = document.createElement('button');
        btn.className = 'danger-link-btn';
        btn.textContent = 'Supprimer';
        btn.title = `Supprimer "${kocktailName}"`;
        btn.addEventListener('click', () => {
            askConfirm(`Supprimer « ${kocktailName} » ?`, { danger: true }).then(ok => {
                if (!ok) return;
                db.ref(refPath).remove()
                    .then(() => showToast(`"${kocktailName}" supprimé.`, 'success'))
                    .catch(err => showToast('Suppression refusée : ' + err.message, 'error'));
            });
        });
        return btn;
    }

    // --- RENDER KOCKTAILS ---
    function renderCocktails(cocktailsData, currentUser) {
        const masterList = document.getElementById('kocktail-master-list');
        const oneShotList = document.getElementById('kocktail-one-shot-list');
        const queuePanel = document.getElementById('kocktail-queue-panel');
        const ordersList = document.getElementById('kocktail-orders-list');

        if (!masterList) return;

        masterList.innerHTML = '';
        if (oneShotList) oneShotList.innerHTML = '';
        if (ordersList) ordersList.innerHTML = '';

        const master = cocktailsData.masterList || {};
        const oneShots = cocktailsData.oneshot || {};
        const orders = cocktailsData.orders || {};

        // Master List render
        const masterArray = Object.entries(master).map(([id, data]) => ({ id, ...data }));
        if (masterArray.length === 0) {
            masterList.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">La carte est en cours de création...</p>';
        } else {
            masterArray.forEach(kocktail => {
                const card = document.createElement('div');
                card.className = 'kocktail-card';
                card.innerHTML = `
                        <h4>${escapeHtml(kocktail.name)}</h4>
                        <p style="font-size: 0.8em; color: var(--secondary-text); margin-bottom: 15px;">${escapeHtml(kocktail.ingredients || 'Secret du barman')}</p>
                   `;
                const actions = document.createElement('div');
                actions.className = 'kocktail-card__actions';

                const orderBtn = document.createElement('button');
                orderBtn.className = 'gold-link-btn';
                orderBtn.textContent = 'Commander';
                orderBtn.addEventListener('click', () => orderCocktail(kocktail.name, currentUser));
                actions.appendChild(orderBtn);

                // La carte officielle est gérée par les admins et les mixologues
                if (window.currentUserIsAdmin || window.currentUserIsMixologist) {
                    actions.appendChild(buildDeleteKocktailBtn(
                        `lan/cocktails/masterList/${kocktail.id}`, kocktail.name
                    ));
                }

                card.appendChild(actions);
                masterList.appendChild(card);
            });
        }

        // One Shots render
        const oneShotsArray = Object.entries(oneShots).map(([id, data]) => ({ id, ...data }));
        if (oneShotsArray.length === 0) {
            oneShotList.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Soyez le premier à proposer une création !</p>';
        } else {
            oneShotsArray.forEach(kocktail => {
                const card = document.createElement('div');
                card.className = 'kocktail-card';
                card.innerHTML = `
                        <h4>${escapeHtml(kocktail.name)}</h4>
                        <p style="font-size: 0.8em; color: var(--secondary-text); margin-bottom: 5px;">Proposé par: ${escapeHtml(kocktail.creatorName)}</p>
                        <p style="font-size: 0.8em; color: var(--accent-color); margin-bottom: 15px;">${escapeHtml(kocktail.recipe || '')}</p>
                   `;
                const actions = document.createElement('div');
                actions.className = 'kocktail-card__actions';

                const orderBtn = document.createElement('button');
                orderBtn.className = 'gold-link-btn';
                orderBtn.textContent = 'Commander';
                orderBtn.addEventListener('click', () => orderCocktail(kocktail.name, currentUser));
                actions.appendChild(orderBtn);

                // Les règles autorisent la suppression au créateur et aux admins
                const canDelete = window.currentUserIsAdmin || kocktail.creatorId === currentUser.uid;
                if (canDelete) {
                    actions.appendChild(buildDeleteKocktailBtn(
                        `lan/cocktails/oneshot/${kocktail.id}`, kocktail.name
                    ));
                }

                card.appendChild(actions);
                oneShotList.appendChild(card);
            });
        }

        // Mixologist Queue
        // Note: For now, if the user is Admin they see the queue. 
        // Realistically, you check if root.child('lan/roles/' + auth.uid) === 'mixologist'
        if ((window.currentUserIsAdmin || window.currentUserIsMixologist) && queuePanel) {
            queuePanel.style.display = 'block';
            const ordersArray = Object.entries(orders).map(([id, data]) => ({ id, ...data }));
            // Sort oldest first
            ordersArray.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            if (ordersArray.length === 0) {
                ordersList.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Aucune commande en attente.</p>';
            } else {
                ordersArray.forEach(order => {
                    const item = document.createElement('div');
                    item.className = 'list-item list-item--queue';
                    item.innerHTML = `
                             <div>
                                  <strong>${escapeHtml(order.cocktailName)}</strong> pour <span style="color: var(--primary-text);">${escapeHtml(order.userName)}</span>
                                  <div style="font-size: 0.8em; color: var(--secondary-text);">${new Date(order.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                             </div>
                        `;
                    const doneBtn = document.createElement('button');
                    doneBtn.className = 'gold-link-btn gold-link-btn--mixo';
                    doneBtn.textContent = 'Servi';
                    doneBtn.addEventListener('click', () => {
                        db.ref(`lan/cocktails/orders/${order.id}`).remove();
                        // Send Notif back to user
                        sendNotification(order.userId, `Votre cocktail "${order.cocktailName}" est prêt au bar ! 🍹`, 'alert');
                    });
                    item.appendChild(doneBtn);
                    ordersList.appendChild(item);
                });
            }
        }
    }

    async function orderCocktail(cocktailName, user) {
        const ok = await askConfirm(`Commander un ${cocktailName} ?`, { title: '🍹 Commande au bar' });
        if (!ok) return;

        const newOrderRef = db.ref('lan/cocktails/orders').push();
        newOrderRef.set({
            cocktailName: cocktailName,
            userId: user.uid,
            userName: user.displayName,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            showToast("Commande envoyée au bar !", "success");
        }).catch(err => {
            showToast("Erreur lors de la commande.", "error");
        });
    }

    /* L'expéditeur est inscrit DANS la clé, pas seulement dans le corps :
       les règles Firebase exigent que `lan/notifications/<cible>/<clé>`
       commence par l'uid de celui qui écrit. Un champ `senderId` seul se
       laissait omettre, et une notif sans expéditeur passait — « L'admin a
       annulé la LAN », signée personne. Une clé, elle, ne s'omet pas. */
    function sendNotification(targetUid, message, type = 'info') {
        const user = auth.currentUser;
        if (!user) return Promise.resolve();

        const notifId = user.uid + '__' + db.ref().push().key;
        return db.ref(`lan/notifications/${targetUid}/${notifId}`).set({
            message: message,
            timestamp: firebase.database.ServerValue.TIMESTAMP,
            read: false,
            type: type,
            senderId: user.uid
        });
    }

    // --- RENDER NOTIFICATIONS ---
    const seenNotifIds = new Set();

    function renderNotifications(notifsData, currentUser) {
        const notifList = document.getElementById('notifications-list');
        const badge = document.getElementById('notif-badge');
        const btnNotif = document.getElementById('btn-notifications');

        if (!notifList || !badge || !btnNotif) return;

        // Bell is always visible once authenticated
        btnNotif.style.display = 'grid';

        const notifsArray = Object.entries(notifsData).map(([id, data]) => ({ id, ...data }));
        notifsArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const unreadCount = notifsArray.filter(n => !n.read).length;

        if (unreadCount > 0) {
            badge.style.display = 'flex';
            badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
        } else {
            badge.style.display = 'none';
        }

        notifList.innerHTML = '';

        if (notifsArray.length === 0) {
            notifList.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Aucune notification.</p>';
            return;
        }

        notifsArray.forEach(notif => {
            // Show invasive toast for new alert-type notifications
            if (!notif.read && notif.type === 'alert' && !seenNotifIds.has(notif.id)) {
                showToast(notif.message, 'success');
            }
            seenNotifIds.add(notif.id);

            const item = document.createElement('div');
            item.className = `notif-item ${!notif.read ? 'unread' : ''}`;
            // Visually distinguish alert-type notifications
            if (notif.type === 'alert') {
                item.style.borderLeftColor = 'var(--danger-color)';
            }

            const text = document.createElement('div');
            text.textContent = notif.message; // textContent : un message ne doit jamais injecter du HTML
            text.style.color = "var(--primary-text)";

            const time = document.createElement('span');
            time.className = 'notif-time';
            time.textContent = new Date(notif.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            item.appendChild(text);
            item.appendChild(time);

            // Mark as read when clicked
            item.addEventListener('click', () => {
                if (!notif.read) {
                    db.ref(`lan/notifications/${currentUser.uid}/${notif.id}`).update({ read: true });
                }
            });

            notifList.appendChild(item);
        });
    }

    document.getElementById('clear-notifications-btn')?.addEventListener('click', () => {
        const user = auth.currentUser;
        if (user) {
            db.ref(`lan/notifications/${user.uid}`).remove();
        }
    });


    /* ======================================================================
       BOUTIQUE
       Aucun solde n'est stocké : il se recalcule à chaque rendu depuis le
       registre et le compteur de présence (core.js). Un joueur n'écrit ici
       que deux choses — une tranche de présence, plafonnée par les règles
       Firebase, et une demande d'achat, qu'un maître du jeu doit trancher.
       Le registre lui-même est en écriture unique et réservé aux maîtres du
       jeu : c'est ce qui empêche quiconque de s'enrichir tout seul.
       ====================================================================== */

    /* Le gain passif. Les règles imposent le rythme (une tranche par dix
       minutes) et le plafond ; ce minuteur ne fait que proposer la tranche
       quand elle est due. Un refus est normal : c'est le second appareil du
       même joueur qui arrive après le premier. On gagne par joueur, jamais
       par écran ouvert. */
    function claimTick() {
        const user = auth.currentUser;
        if (!user || !globalSettings.isLanActive) return;

        const node = (globalEconomy.ticks || {})[user.uid] || null;
        const count = Number(node && node.count) || 0;
        if (count >= ECONOMY.MAX_TICKS) return;

        const last = Number(node && node.lastTick) || 0;
        // Marge de deux secondes : l'horloge du PC n'est pas celle du serveur,
        // et une tentative en avance serait rejetée pour rien.
        if (last && Date.now() - last < ECONOMY.TICK_INTERVAL_MS + 2000) return;

        db.ref('lan/economy/ticks/' + user.uid).set({
            count: count + 1,
            lastTick: firebase.database.ServerValue.TIMESTAMP
        }).catch(() => { /* trop tôt, ou un autre appareil a pris la tranche */ });
    }

    function startTickEngine() {
        clearInterval(tickTimer);
        // On sonde plus souvent que l'intervalle : le joueur arrive au milieu
        // d'une tranche et attendre dix minutes pleines ressemblerait à une panne.
        tickTimer = setInterval(claimTick, 60000);
        claimTick();
    }

    // Tous ceux qu'on connaît : connectés, votants, ou simplement déjà venus.
    // Un joueur parti se coucher reste une cible valable pour un handicap.
    function economyPlayers() {
        const seen = {};
        [globalUsers, globalVotes, globalProfiles].forEach(source => {
            Object.keys(source || {}).forEach(uid => { seen[uid] = true; });
        });
        return Object.keys(seen);
    }

    function playerLabel(uid) {
        if (globalVotes[uid] && globalVotes[uid].name) return globalVotes[uid].name;
        const identity = statusIdentity(globalUsers[uid]);
        if (identity && identity.name) return identity.name;
        if (globalProfiles[uid] && globalProfiles[uid].name) return globalProfiles[uid].name;
        return 'Un joueur';
    }

    /* Onglets internes à un écran. Le rail conduit à la destination, ces
       onglets à la pièce. Un volet fermé porte `hidden` — c'est du balisage,
       pas un display:none de plus — et surtout il ne se construit pas :
       renderShopFeed(), renderXpBoard() et renderLanTitlesPanel() tournaient à
       chaque mise à jour de l'économie pour peupler un DOM invisible. */
    function activatePane(rootId, name) {
        const root = document.getElementById(rootId);
        if (!root) return;
        root.dataset.pane = name;
        root.querySelectorAll('[data-pane]').forEach(node => {
            if (node.tagName === 'BUTTON') node.classList.toggle('active', node.dataset.pane === name);
            else node.hidden = node.dataset.pane !== name;
        });
        scheduleDesktopMotionRefresh();
    }

    function paneIsOpen(rootId, name) {
        const root = document.getElementById(rootId);
        return !!root && root.classList.contains('active') && (root.dataset.pane || '') === name;
    }

    function shopPaneIsOpen(name) {
        return paneIsOpen('lan-boutique', name);
    }

    function setupPanes() {
        document.querySelectorAll('.lan-subview .desktop-subnav__item[data-pane]').forEach(tab => {
            const root = tab.closest('.lan-subview');
            if (!root) return;
            if (!root.dataset.pane) root.dataset.pane = tab.dataset.pane;
            tab.addEventListener('click', () => {
                activatePane(root.id, tab.dataset.pane);
                if (root.id === 'lan-boutique') renderBoutique();
            });
        });
    }

    function renderBoutique() {
        const user = auth.currentUser;
        if (!user || !document.getElementById('lan-boutique')) return;

        const isGm = !!window.currentUserIsGamemaster;
        const balance = economyBalance(globalEconomy, user.uid);
        const reserved = balance - availablePoints(globalEconomy, user.uid);

        // Le solde s'affiche dans le bandeau. Ici, seule sa provenance.
        const hint = document.getElementById('wallet-hint');
        if (hint) {
            if (reserved > 0) {
                hint.textContent = `dont ${formatPoints(reserved)} réservés par une demande en attente`;
            } else if (globalSettings.isLanActive) {
                const ticks = Number(((globalEconomy.ticks || {})[user.uid] || {}).count) || 0;
                hint.textContent = ticks >= ECONOMY.MAX_TICKS
                    ? 'Présence : plafond atteint. Les points se gagnent autrement, maintenant.'
                    : `+${ECONOMY.TICK_VALUE} ${ECONOMY.CURRENCY} toutes les 10 minutes de présence`;
            } else {
                hint.textContent = 'Les points se gagnent une fois la LAN lancée.';
            }
        }

        document.getElementById('shop-grant-panel').style.display = isGm ? 'block' : 'none';
        document.getElementById('btn-add-shop-item').style.display = isGm ? 'inline-block' : 'none';

        /* Le tiroir n'existe que pour le maître du jeu, et il reste replié :
           l'ouvrir tout seul repousserait la carte sous la ligne de flottaison,
           ce qu'on cherchait précisément à éviter. La pastille suffit à dire
           qu'il y a quelque chose dedans — le tableau de bord et la pastille
           du rail le disent déjà de leur côté. */
        const shopTools = document.getElementById('shop-gm-tools');
        const shopToolsBadge = document.getElementById('shop-gm-tools-badge');
        if (shopTools) shopTools.style.display = isGm ? 'block' : 'none';
        if (shopToolsBadge) {
            const waiting = isGm ? pendingPurchases(globalEconomy).length : 0;
            shopToolsBadge.textContent = waiting ? String(waiting) : '';
        }

        grantPendingAchievements();
        renderBoosterShelf(user);
        renderShopQueue(isGm);
        renderShopCatalog(user);
        fillGrantSelect();
        updateShopBadge(isGm);

        renderShopFeed();
        renderShopLeaderboard();
        renderMyShopRequests(user);
        renderLanTitlesPanel();
        renderXpBoard();
        updateShopPaneBadge(user);
    }

    // « Mes demandes » vit derrière un onglet : c'est par là qu'on apprend
    // qu'un achat est validé, donc l'onglet doit le dire de lui-même.
    function updateShopPaneBadge(user) {
        const badge = document.getElementById('shop-pane-requests-badge');
        if (!badge) return;
        const mine = Object.values((globalEconomy || {}).purchases || {})
            .filter(item => item && item.uid === user.uid && item.status === 'pending').length;
        badge.textContent = mine ? String(mine) : '';
    }

    // La pastille de navigation ne parle qu'au maître du jeu : pour les autres,
    // une file d'attente n'est pas une nouvelle à traiter.
    function updateShopBadge(isGm) {
        const badge = document.getElementById('shop-nav-badge');
        if (!badge) return;
        const waiting = isGm ? pendingPurchases(globalEconomy).length : 0;
        badge.style.display = waiting ? 'inline-block' : 'none';
        badge.textContent = waiting;
    }

    /* --- File d'attente du maître du jeu -------------------------------- */

    function renderShopQueue(isGm) {
        const panel = document.getElementById('shop-gm-panel');
        const mount = document.getElementById('shop-gm-queue');
        if (!mount || !panel) return;

        const queue = pendingPurchases(globalEconomy);
        /* Les achats sont immédiats : cette file ne sert plus qu'aux demandes
           déposées avant le changement. Vide, elle disparaît plutôt que
           d'annoncer un travail qui n'existe plus. */
        if (!isGm || !queue.length) { panel.style.display = 'none'; return; }

        panel.style.display = 'block';
        mount.innerHTML = '';

        queue.forEach(p => {
            const buyerBalance = economyBalance(globalEconomy, p.uid);
            const card = document.createElement('div');
            card.className = 'shop-request';

            let meta = `${escapeHtml(p.userName || playerLabel(p.uid))} — solde ${escapeHtml(formatPoints(buyerBalance))}`;
            if (p.targetName) meta += ` — visé : ${escapeHtml(p.targetName)}`;

            card.innerHTML = `
                <div class="shop-card__head">
                    <h4 class="shop-card__name">${escapeHtml(p.itemName || 'Article')}</h4>
                    <span class="shop-card__price">${escapeHtml(formatPoints(p.price))}</span>
                </div>
                <p class="shop-card__meta">${meta}</p>
            `;

            // Le solde s'affiche au moment de trancher : c'est le garde-fou
            // contre un client bricolé, puisque les règles Firebase ne savent
            // pas additionner un registre.
            if (buyerBalance < (Number(p.price) || 0)) {
                const warn = document.createElement('p');
                warn.className = 'shop-request__warn';
                warn.textContent = '⚠️ Solde insuffisant : valider le ferait passer en négatif.';
                card.appendChild(warn);
            }

            const actions = document.createElement('div');
            actions.className = 'shop-card__actions';

            const grant = document.createElement('button');
            grant.className = 'gold-btn';
            grant.style.padding = '8px 18px';
            grant.textContent = 'Valider';
            grant.addEventListener('click', () => resolvePurchase(p, 'granted'));
            actions.appendChild(grant);

            const refuse = document.createElement('button');
            refuse.className = 'gold-link-btn';
            refuse.textContent = 'Refuser';
            refuse.addEventListener('click', () => resolvePurchase(p, 'refused'));
            actions.appendChild(refuse);

            card.appendChild(actions);
            mount.appendChild(card);
        });
    }

    /* Valider, c'est écrire deux choses : la ligne du registre qui débite, puis
       le sort de la demande. Le registre en premier — si la seconde écriture
       échoue, le joueur est débité d'un article qu'il recevra quand même, ce
       qui se rattrape à la main ; l'ordre inverse offrirait l'article. */
    function resolvePurchase(purchase, status) {
        const user = auth.currentUser;
        if (!user) return;

        const close = () => db.ref('lan/economy/purchases/' + purchase.id).update({
            status: status,
            resolvedBy: user.uid,
            resolvedByName: user.displayName || 'Maître du jeu',
            resolvedAt: firebase.database.ServerValue.TIMESTAMP
        });

        if (status === 'refused') {
            close()
                .then(() => {
                    sendNotification(purchase.uid, `Demande refusée : ${purchase.itemName}`, 'info');
                    showToast('Demande refusée.', 'success');
                })
                .catch(err => showToast('Erreur : ' + err.message, 'error'));
            return;
        }

        writeLedger({
            uid: purchase.uid,
            delta: -(Number(purchase.price) || 0),
            type: 'purchase',
            reason: purchase.itemName || 'Achat',
            refId: purchase.id
        })
            .then(close)
            .then(() => {
                sendNotification(purchase.uid, `${purchase.itemName} : c'est validé !`, 'success');
                showToast('Achat validé.', 'success');
            })
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    }

    function writeLedger(entry) {
        const user = auth.currentUser;
        return db.ref('lan/economy/ledger').push().set(Object.assign({
            by: user ? user.uid : null,
            byName: user ? (user.displayName || 'Maître du jeu') : null,
            ts: firebase.database.ServerValue.TIMESTAMP
        }, entry));
    }

    /* --- La carte ------------------------------------------------------- */

    function renderShopCatalog(user) {
        const mount = document.getElementById('shop-catalog');
        if (!mount) return;
        mount.innerHTML = '';

        // Les boosters ont leur panneau à eux, plus haut : les remettre ici
        // ferait deux fois le même article sur le même écran.
        const catalog = Object.entries(globalEconomy.catalog || {})
            .filter(([, item]) => item && item.active !== false && !isPackItem(item));

        if (!catalog.length) {
            if (!window.currentUserIsGamemaster) {
                mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">La boutique n\'a pas encore ouvert.</p>';
                return;
            }
            // Pour un maître du jeu, une boutique vide est une chose à faire,
            // pas une absence à constater.
            mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic; margin-bottom:14px;">La boutique est vide. Une carte de départ existe : privilèges, handicaps à jouer sur quelqu\'un, cosmétiques.</p>';
            const go = document.createElement('button');
            go.className = 'gold-btn';
            go.style.padding = '10px 20px';
            go.textContent = 'Garnir la boutique';
            go.addEventListener('click', stockStarterShop);
            mount.appendChild(go);
            return;
        }

        // Groupé par rayon : une liste à plat de vingt articles ne se lit pas.
        ECONOMY.CATEGORIES.forEach(cat => {
            const items = catalog.filter(([, item]) => (item.category || 'fun') === cat.key);
            if (!items.length) return;

            const title = document.createElement('p');
            title.className = 'shop-cat-title';
            title.textContent = `${cat.icon} ${cat.label}`;
            mount.appendChild(title);

            const grid = document.createElement('div');
            grid.className = 'shop-grid';
            items
                .sort((a, b) => (Number(a[1].price) || 0) - (Number(b[1].price) || 0))
                .forEach(([id, item]) => grid.appendChild(buildShopCard(id, item, user)));
            mount.appendChild(grid);
        });

        // Il reste des articles de la carte de départ à poser : on le propose
        // sans insister, tout en bas.
        const missing = window.currentUserIsGamemaster
            ? missingStarterItems(globalEconomy).length : 0;
        if (missing) {
            const more = document.createElement('button');
            more.className = 'gold-link-btn';
            more.style.marginTop = '18px';
            more.textContent = `+ Ajouter les ${missing} articles de la carte de départ`;
            more.addEventListener('click', stockStarterShop);
            mount.appendChild(more);
        }
    }

    /* Un article de boutique, à la manière d'une carte : jeton de coût, nom
       gravé, bande de famille. Le format reste le PAYSAGE — les collectibles
       sont en portrait, et deux systèmes de cartes qui se ressemblent trop
       finissent par se confondre. */
    function buildShopCard(id, item, user) {
        const verdict = canBuy(globalEconomy, user.uid, id, item);
        const family = item.category || 'fun';
        const card = document.createElement('div');
        card.className = 'shop-item shop-item--' + family + (verdict.ok ? '' : ' is-locked');

        const left = itemStockLeft(globalEconomy, id, item);
        const stockLine = left === null
            ? ''
            : `<span class="shop-item__stock">${left ? `${left} restant${left > 1 ? 's' : ''}` : 'Épuisé'}</span>`;

        const descLine = item.description
            ? `<p class="shop-item__desc">${escapeHtml(item.description)}</p>`
            : '';

        card.innerHTML = `
            <span class="shop-item__cost">${Math.round(Number(item.price) || 0)}</span>
            <div class="shop-item__main">
                <h4 class="shop-item__name">${escapeHtml(item.name || 'Article')}</h4>
                ${descLine}
                <div class="shop-item__strip">
                    <span class="shop-item__gem"></span>
                    <span class="shop-item__fam">${escapeHtml(item.needsTarget ? 'Handicap ciblé' : categoryLabel(family))}</span>
                    ${stockLine}
                </div>
            </div>
        `;

        const actions = document.createElement('div');
        actions.className = 'shop-item__actions';

        const buy = document.createElement('button');
        buy.className = 'shop-item__buy';
        buy.textContent = verdict.ok ? (item.needsTarget ? 'Viser' : 'Prendre') : verdict.why;
        buy.disabled = !verdict.ok;
        buy.addEventListener('click', () => requestPurchase(id, item));
        actions.appendChild(buy);

        if (window.currentUserIsGamemaster) {
            const del = document.createElement('button');
            del.className = 'gold-link-btn';
            del.style.color = 'var(--danger-color)';
            del.textContent = 'Retirer';
            del.addEventListener('click', () => removeCatalogItem(id, item.name));
            actions.appendChild(del);
        }

        card.querySelector('.shop-item__main').appendChild(actions);
        return card;
    }

    /* Garnir la boutique d'un coup. On n'ajoute que ce qui manque, comparé sur
       le nom : regarnir deux fois ne double pas les articles. */
    function stockStarterShop() {
        const user = auth.currentUser;
        if (!user) return;
        const missing = missingStarterItems(globalEconomy);
        if (!missing.length) { showToast('La boutique a déjà tout.', 'success'); return; }

        const update = {};
        missing.forEach(item => {
            const id = db.ref('lan/economy/catalog').push().key;
            update['lan/economy/catalog/' + id] = {
                name: item.name,
                description: item.description || '',
                price: item.price,
                category: item.category || 'fun',
                stock: null,
                needsTarget: !!item.needsTarget,
                kind: null,
                active: true,
                createdBy: user.uid,
                createdAt: firebase.database.ServerValue.TIMESTAMP
            };
        });

        db.ref().update(update)
            .then(() => showToast(`${missing.length} articles ajoutés à la boutique.`, 'success'))
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    }

    function removeCatalogItem(id, name) {
        askConfirm(`Retirer « ${name} » de la carte ?`, { danger: true }).then(ok => {
            if (!ok) return;
            db.ref('lan/economy/catalog/' + id).remove()
                .then(() => showToast('Article retiré.', 'success'))
                .catch(err => showToast('Erreur : ' + err.message, 'error'));
        });
    }

    /* ---------- Le booster en tête de gondole ----------
       Le paquet est l'article que la soirée met en avant : il a droit à son
       emballage plutôt qu'à une ligne de liste. */

    function renderBoosterShelf(user) {
        const panel = document.getElementById('booster-panel');
        const mount = document.getElementById('booster-shelf');
        if (!panel || !mount) return;

        // Sans set, un booster ne contiendrait rien : on ne le propose pas.
        if (!tcgCurrentSetId(globalTcg)) { panel.style.display = 'none'; return; }

        const items = packItems(globalEconomy);
        if (!items.length) {
            // Pour un maître du jeu, c'est une chose à faire — pas une absence
            // à constater.
            if (!window.currentUserIsGamemaster) { panel.style.display = 'none'; return; }
            panel.style.display = 'block';
            mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic; margin-bottom:14px;">Aucun booster en vente : les joueurs ne peuvent pas acheter de cartes.</p>';
            const go = document.createElement('button');
            go.className = 'gold-btn';
            go.style.padding = '10px 20px';
            go.textContent = 'Mettre le booster en vente';
            go.addEventListener('click', createDefaultPackItem);
            mount.appendChild(go);
            return;
        }

        panel.style.display = 'block';
        mount.innerHTML = '';
        items.forEach(([id, item]) => mount.appendChild(buildBoosterCard(id, item, user)));
    }

    function buildBoosterCard(id, item, user) {
        const verdict = canBuy(globalEconomy, user.uid, id, item);
        const card = document.createElement('div');
        card.className = 'booster-buy';

        const name = item.name
            || packLabel({ name: generatedArtNames[PACK_ART_KEY] }, globalSettings.lanName);
        const art = generatedArt[PACK_ART_KEY] || '';

        card.innerHTML = `
            <div class="booster-buy__art">${art ? `<img src="${escapeHtml(art)}" alt="">` : ''}</div>
            <div class="booster-buy__main">
                <h4 class="booster-buy__name">${escapeHtml(name)}</h4>
                <p class="booster-buy__meta">${TCG.PACK_SIZE} cartes du set de la soirée, dont trois brillantes.</p>
                <span class="booster-buy__cost"><span>${escapeHtml(ECONOMY.CURRENCY)}</span>${Math.round(Number(item.price) || 0)}</span>
            </div>
        `;

        const side = document.createElement('div');
        side.className = 'booster-buy__go';

        const buy = document.createElement('button');
        buy.className = 'gold-btn';
        buy.style.padding = '12px 24px';
        buy.textContent = verdict.ok ? 'Acheter un booster' : verdict.why;
        buy.disabled = !verdict.ok;
        buy.addEventListener('click', () => requestPurchase(id, item));
        side.appendChild(buy);

        if (window.currentUserIsGamemaster) {
            const del = document.createElement('button');
            del.className = 'gold-link-btn';
            del.style.cssText = 'color: var(--danger-color); display: block; margin-top: 10px;';
            del.textContent = 'Retirer de la vente';
            del.addEventListener('click', () => removeCatalogItem(id, name));
            side.appendChild(del);
        }

        card.appendChild(side);
        return card;
    }

    /* Un booster prêt à vendre, sans passer par le formulaire. Le prix part du
       plafond de présence : dix heures de LAN paient trois paquets, ce qui
       laisse la place aux défis pour le reste. */
    function createDefaultPackItem() {
        const user = auth.currentUser;
        if (!user) return;
        const price = Math.round(ECONOMY.MAX_TICKS * ECONOMY.TICK_VALUE / 3);
        db.ref('lan/economy/catalog').push().set({
            name: packLabel({ name: generatedArtNames[PACK_ART_KEY] }, globalSettings.lanName),
            description: `${TCG.PACK_SIZE} cartes du set de la soirée.`,
            price: price,
            category: 'fun',
            stock: null,
            needsTarget: false,
            kind: 'pack',
            active: true,
            createdBy: user.uid,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        })
            .then(() => showToast(`Le booster est en vente à ${formatPoints(price)}.`, 'success'))
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    }


    /* ======================================================================
       EXPÉRIENCE ET HAUTS FAITS
       Les points mesurent une soirée ; l'expérience mesure les soirées. Elle
       ne se dépense pas, et `lan/xp` n'est pas effacé à la clôture — c'est
       toute la différence.

       Les jalons se CALCULENT depuis les données du moment (core.js), mais ce
       qui fait foi est la récompense inscrite au journal : sans elle, un jalon
       gagné ce soir se reverrouillerait à la prochaine LAN, quand les
       compteurs de la soirée repartent à zéro.
       ====================================================================== */

    const XP_SEGMENTS = 24;

    const ACH_ICONS = {
        cart: 'M5 6h15l-1.6 8.2a2 2 0 0 1-2 1.6H9a2 2 0 0 1-2-1.6L5.2 4.6A1 1 0 0 0 4.2 4H3M9 20h.01M17 20h.01',
        coin: 'M12 3c4.4 0 8 1.6 8 3.5S16.4 10 12 10 4 8.4 4 6.5 7.6 3 12 3zM4 6.5v11C4 19.4 7.6 21 12 21s8-1.6 8-3.5v-11',
        target: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
        pack: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2M9 12h6',
        cards: 'M8 3h12v14H8zM5.5 6.5 4 8v11l6 2',
        spark: 'M12 3l2 5.6 5.6 2-5.6 2L12 18l-2-5.4-5.6-2 5.6-2zM19 4v3M17.5 5.5h3',
        signature: 'M4 17c4-1 5-10 8-10s2 8 5 8M4 21h16',
        trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 5H5v2a3 3 0 0 0 3 3M16 5h3v2a3 3 0 0 1-3 3M12 13v4M9 20h6',
        trade: 'M4 8h13l-3-3M20 16H7l3 3',
        clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
        flag: 'M5 21V4M5 5h11l-1.5 3.5L16 12H5'
    };

    // Les données que core.js attend. Le rejeu des cartes est le seul calcul
    // lourd : on le prend au cache partagé plutôt que de le refaire.
    function achData() {
        return {
            economy: globalEconomy,
            tcg: globalTcg,
            cards: tcgView().cards,
            xp: globalXp,
            history: globalHistory,
            votes: globalVotes,
            settings: globalSettings,
            quests: globalQuests,
            profiles: globalProfiles,
            roles: globalRoles,
            adminUid: ADMIN_UID
        };
    }


    /* ======================================================================
       LES DÉFIS ET LA BOÎTE À IDÉES
       Rien ici ne se calcule : un défi se raconte, et c'est un humain qui
       tranche. Le joueur réclame, l'admin valide, et c'est la validation qui
       écrit les złotych au registre et l'expérience au journal — jamais le
       joueur lui-même. Un débit, il sait l'écrire ; un CRÉDIT, non.
       ====================================================================== */

    function renderDefis() {
        const user = auth.currentUser;
        if (!user || !document.getElementById('lan-defis')) return;

        renderClaimsQueue();
        renderProposals();
        renderMyClaims(user);
        renderChallengeList(user);
        renderSuggestions(user);
        updateDefisBadge();

        document.getElementById('btn-new-challenge').textContent =
            window.currentUserIsGamemaster ? '+ Créer un défi' : '+ Proposer un défi';
    }

    function updateDefisBadge() {
        const badge = document.getElementById('defis-nav-badge');
        if (!badge) return;
        const waiting = window.currentUserIsGamemaster
            ? pendingClaims(globalQuests).length + proposedChallenges(globalQuests).length : 0;
        badge.style.display = waiting ? 'inline-block' : 'none';
        badge.textContent = waiting;
    }

    /* --- Ce que l'admin doit trancher ------------------------------------ */

    function renderClaimsQueue() {
        const panel = document.getElementById('claims-panel');
        const mount = document.getElementById('claims-queue');
        if (!panel || !mount) return;

        const queue = pendingClaims(globalQuests);
        if (!window.currentUserIsGamemaster || !queue.length) { panel.style.display = 'none'; return; }

        panel.style.display = 'block';
        mount.innerHTML = '';
        queue.forEach(claim => {
            const card = document.createElement('div');
            card.className = 'shop-request';
            const witness = claim.witnessName ? ` — témoin : ${escapeHtml(claim.witnessName)}` : '';
            const note = claim.note ? `<p class="shop-card__desc">« ${escapeHtml(claim.note)} »</p>` : '';
            card.innerHTML = `
                <div class="shop-card__head">
                    <h4 class="shop-card__name">${escapeHtml(claim.title || 'Défi')}</h4>
                    <span class="shop-card__price">${escapeHtml(formatPoints(claim.zl))} · ${Number(claim.xp) || 0} XP</span>
                </div>
                <p class="shop-card__meta">${escapeHtml(claim.userName || playerLabel(claim.uid))}${witness}</p>
                ${note}
            `;

            const actions = document.createElement('div');
            actions.className = 'shop-card__actions';

            const ok = document.createElement('button');
            ok.className = 'gold-btn';
            ok.style.padding = '8px 18px';
            ok.textContent = 'Valider';
            ok.addEventListener('click', () => resolveClaim(claim, 'granted'));
            actions.appendChild(ok);

            const no = document.createElement('button');
            no.className = 'gold-link-btn';
            no.textContent = 'Refuser';
            no.addEventListener('click', () => resolveClaim(claim, 'refused'));
            actions.appendChild(no);

            card.appendChild(actions);
            mount.appendChild(card);
        });
    }

    /* Valider paie. Les złotych, l'expérience et le sort de la réclamation
       partent ensemble dans une écriture multi-chemins : on ne peut pas être
       payé deux fois, ni payé sans que la réclamation soit close. La clé de la
       récompense d'XP est déterministe — deux admins qui valident en même temps
       écrivent le même nœud plutôt que deux récompenses. */
    function resolveClaim(claim, status) {
        const user = auth.currentUser;
        if (!user) return;

        const update = {};
        update['lan/claims/' + claim.id + '/status'] = status;
        update['lan/claims/' + claim.id + '/resolvedBy'] = user.uid;
        update['lan/claims/' + claim.id + '/resolvedByName'] = user.displayName || 'Admin';
        update['lan/claims/' + claim.id + '/resolvedAt'] = firebase.database.ServerValue.TIMESTAMP;

        if (status === 'granted') {
            const zl = Number(claim.zl) || 0;
            const xp = Number(claim.xp) || 0;
            if (zl > 0) {
                const entryId = db.ref('lan/economy/ledger').push().key;
                update['lan/economy/ledger/' + entryId] = {
                    uid: claim.uid,
                    delta: zl,
                    type: 'challenge',
                    reason: claim.title || 'Défi relevé',
                    refId: claim.id,
                    by: user.uid,
                    byName: user.displayName || 'Admin',
                    ts: firebase.database.ServerValue.TIMESTAMP
                };
            }
            if (xp > 0) {
                update['lan/xp/awards/' + claim.uid + '__claim__' + claim.id] = {
                    uid: claim.uid,
                    delta: xp,
                    type: 'challenge',
                    reason: claim.title || 'Défi relevé',
                    refId: claim.id,
                    by: user.uid,
                    ts: firebase.database.ServerValue.TIMESTAMP
                };
            }
        }

        db.ref().update(update)
            .then(() => {
                if (claim.uid !== user.uid) {
                    sendNotification(claim.uid, status === 'granted'
                        ? `« ${claim.title || 'Défi'} » validé ! +${formatPoints(claim.zl)} et ${Number(claim.xp) || 0} XP`
                        : `« ${claim.title || 'Défi'} » refusé.`,
                        status === 'granted' ? 'success' : 'info');
                }
                showToast(status === 'granted' ? 'Validé et payé.' : 'Refusé.', 'success');
            })
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    }

    /* --- Les propositions des joueurs ------------------------------------ */

    function renderProposals() {
        const panel = document.getElementById('proposals-panel');
        const mount = document.getElementById('proposals-list');
        if (!panel || !mount) return;

        const list = proposedChallenges(globalQuests);
        if (!window.currentUserIsGamemaster || !list.length) { panel.style.display = 'none'; return; }

        panel.style.display = 'block';
        mount.innerHTML = '';
        list.forEach(challenge => {
            const card = document.createElement('div');
            card.className = 'shop-request';
            const desc = challenge.description
                ? `<p class="shop-card__desc">${escapeHtml(challenge.description)}</p>` : '';
            card.innerHTML = `
                <div class="shop-card__head">
                    <h4 class="shop-card__name">${escapeHtml(challenge.title || 'Défi')}</h4>
                    <span class="shop-card__price">${escapeHtml(formatPoints(challenge.zl))} · ${Number(challenge.xp) || 0} XP</span>
                </div>
                <p class="shop-card__meta">proposé par ${escapeHtml(challenge.createdByName || playerLabel(challenge.createdBy))} · ${escapeHtml(challengeCategory(challenge.category).label)}</p>
                ${desc}
            `;

            const actions = document.createElement('div');
            actions.className = 'shop-card__actions';

            const ok = document.createElement('button');
            ok.className = 'gold-btn';
            ok.style.padding = '8px 18px';
            ok.textContent = 'Ouvrir aux joueurs';
            ok.addEventListener('click', () => approveChallenge(challenge));
            actions.appendChild(ok);

            const no = document.createElement('button');
            no.className = 'gold-link-btn';
            no.style.color = 'var(--danger-color)';
            no.textContent = 'Refuser';
            no.addEventListener('click', () => {
                db.ref('lan/challenges/' + challenge.id).remove()
                    .then(() => showToast('Proposition refusée.', 'success'))
                    .catch(err => showToast('Erreur : ' + err.message, 'error'));
            });
            actions.appendChild(no);

            card.appendChild(actions);
            mount.appendChild(card);
        });
    }

    function approveChallenge(challenge) {
        const user = auth.currentUser;
        if (!user) return;
        db.ref('lan/challenges/' + challenge.id).update({
            status: 'open',
            approvedBy: user.uid,
            approvedAt: firebase.database.ServerValue.TIMESTAMP
        })
            .then(() => {
                if (challenge.createdBy && challenge.createdBy !== user.uid) {
                    sendNotification(challenge.createdBy,
                        `Votre défi « ${challenge.title || ''} » est ouvert à tous !`, 'success');
                }
                showToast('Défi ouvert.', 'success');
            })
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    }

    /* --- Mes réclamations ------------------------------------------------- */

    function renderMyClaims(user) {
        const panel = document.getElementById('myclaims-panel');
        const mount = document.getElementById('myclaims-list');
        if (!panel || !mount) return;

        const mine = claimsOf(globalQuests, user.uid).filter(c => c.status === 'pending');
        if (!mine.length) { panel.style.display = 'none'; return; }

        panel.style.display = 'block';
        mount.innerHTML = '';
        mine.forEach(claim => {
            const row = document.createElement('div');
            row.className = 'shop-move';
            row.innerHTML = `
                <span class="shop-move__text">${escapeHtml(claim.title || 'Défi')}
                    <span class="shop-move__why">en attente${claim.note ? ' · « ' + escapeHtml(claim.note) + ' »' : ''}</span>
                </span>
            `;
            const cancel = document.createElement('button');
            cancel.className = 'gold-link-btn';
            cancel.textContent = 'Retirer';
            cancel.addEventListener('click', () => {
                db.ref('lan/claims/' + claim.id).remove()
                    .then(() => showToast('Réclamation retirée.', 'success'))
                    .catch(err => showToast('Erreur : ' + err.message, 'error'));
            });
            row.appendChild(cancel);
            mount.appendChild(row);
        });
    }

    /* --- La liste des défis ----------------------------------------------- */

    function renderChallengeList(user) {
        const mount = document.getElementById('challenge-list');
        if (!mount) return;
        mount.innerHTML = '';

        const list = openChallenges(globalQuests);
        if (!list.length) {
            if (!window.currentUserIsGamemaster) {
                mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Aucun défi pour le moment. Proposez le premier !</p>';
                return;
            }
            mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic; margin-bottom:14px;">Aucun défi. Une liste de départ existe : sport, jeu, boisson, bouffe.</p>';
            const go = document.createElement('button');
            go.className = 'gold-btn';
            go.style.padding = '10px 20px';
            go.textContent = 'Garnir la liste';
            go.addEventListener('click', stockStarterChallenges);
            mount.appendChild(go);
            return;
        }

        CHALLENGES.CATEGORIES.forEach(cat => {
            const items = list.filter(c => (c.category || 'autre') === cat.key);
            if (!items.length) return;

            const title = document.createElement('p');
            title.className = 'shop-cat-title';
            title.textContent = `${cat.icon} ${cat.label}`;
            mount.appendChild(title);

            const grid = document.createElement('div');
            grid.className = 'shop-grid';
            items.forEach(challenge => grid.appendChild(buildChallengeCard(challenge, user)));
            mount.appendChild(grid);
        });

        const missing = window.currentUserIsGamemaster
            ? missingStarterChallenges(globalQuests).length : 0;
        if (missing) {
            const more = document.createElement('button');
            more.className = 'gold-link-btn';
            more.style.marginTop = '18px';
            more.textContent = `+ Ajouter les ${missing} défis de la liste de départ`;
            more.addEventListener('click', stockStarterChallenges);
            mount.appendChild(more);
        }
    }

    function buildChallengeCard(challenge, user) {
        const verdict = claimState(globalQuests, challenge, user.uid);
        const card = document.createElement('div');
        card.className = 'shop-item shop-item--'
            + (challenge.category === 'sport' ? 'privilege' : 'fun')
            + (verdict.can ? '' : ' is-locked');

        const done = challengeGrantedCount(globalQuests, challenge.id);
        const doneLine = done ? `<span class="shop-item__stock">relevé ${done}×</span>` : '';
        const desc = challenge.description
            ? `<p class="shop-item__desc">${escapeHtml(challenge.description)}</p>` : '';

        card.innerHTML = `
            <span class="shop-item__cost">${Math.round(Number(challenge.zl) || 0)}</span>
            <div class="shop-item__main">
                <h4 class="shop-item__name">${escapeHtml(challenge.title || 'Défi')}</h4>
                ${desc}
                <div class="shop-item__strip">
                    <span class="shop-item__gem"></span>
                    <span class="shop-item__fam">+${Number(challenge.xp) || 0} XP</span>
                    ${doneLine}
                </div>
            </div>
        `;

        const actions = document.createElement('div');
        actions.className = 'shop-item__actions';

        const go = document.createElement('button');
        go.className = 'shop-item__buy';
        go.textContent = verdict.can ? 'Je l\'ai fait' : verdict.why;
        go.disabled = !verdict.can;
        go.addEventListener('click', () => openClaimPrompt(challenge));
        actions.appendChild(go);

        if (window.currentUserIsGamemaster) {
            const del = document.createElement('button');
            del.className = 'gold-link-btn';
            del.style.color = 'var(--danger-color)';
            del.textContent = 'Retirer';
            del.addEventListener('click', () => {
                askConfirm(`Retirer « ${challenge.title} » ?`, { danger: true }).then(ok => {
                    if (!ok) return;
                    db.ref('lan/challenges/' + challenge.id).remove()
                        .then(() => showToast('Défi retiré.', 'success'))
                        .catch(err => showToast('Erreur : ' + err.message, 'error'));
                });
            });
            actions.appendChild(del);
        }

        card.querySelector('.shop-item__main').appendChild(actions);
        return card;
    }
    /* Réclamer, c'est raconter : le mot du joueur et le nom d'un témoin
       permettent à l'admin de trancher sans avoir tout vu. Le montant est FIGÉ
       dans la réclamation — si l'admin change le prix du défi demain, ce qui a
       été promis reste promis. */
    function openClaimPrompt(challenge) {
        const user = auth.currentUser;
        if (!user) return;

        openFormModal({
            title: challenge.title || 'Défi',
            intro: `${formatPoints(challenge.zl)} et ${Number(challenge.xp) || 0} XP, si l'admin valide.`,
            submitLabel: 'Envoyer à l\'admin',
            fields: [
                { key: 'note', type: 'textarea', label: 'Comment ça s\'est passé ?',
                  placeholder: 'Facultatif, mais ça aide à trancher.' },
                { key: 'witness', type: 'select', label: 'Un témoin ?',
                  options: playerOptions(true) }
            ]
        }).then(values => {
            if (!values) return;
            db.ref('lan/claims').push().set({
                challengeId: challenge.id,
                title: challenge.title || 'Défi',
                zl: Number(challenge.zl) || 0,
                xp: Number(challenge.xp) || 0,
                uid: user.uid,
                userName: user.displayName || 'Un joueur',
                note: (values.note || '').trim().slice(0, 500),
                witnessUid: values.witness || null,
                witnessName: values.witness ? playerLabel(values.witness) : null,
                status: 'pending',
                ts: firebase.database.ServerValue.TIMESTAMP
            })
                .then(() => showToast('Envoyé ! L\'admin tranchera.', 'success'))
                .catch(err => showToast('Erreur : ' + err.message, 'error'));
        });
    }

    /* Garnir la liste d'un coup. On n'ajoute que ce qui manque, comparé sur le
       titre : regarnir deux fois ne double pas les défis. */
    function stockStarterChallenges() {
        const user = auth.currentUser;
        if (!user) return;
        const missing = missingStarterChallenges(globalQuests);
        if (!missing.length) { showToast('La liste a déjà tout.', 'success'); return; }

        const update = {};
        missing.forEach(challenge => {
            const id = db.ref('lan/challenges').push().key;
            update['lan/challenges/' + id] = {
                title: challenge.title,
                description: challenge.description || '',
                category: challenge.category || 'autre',
                zl: challenge.zl,
                xp: challenge.xp,
                repeatable: challenge.repeatable !== false,
                status: 'open',
                createdBy: user.uid,
                createdByName: user.displayName || 'Admin',
                createdAt: firebase.database.ServerValue.TIMESTAMP
            };
        });

        db.ref().update(update)
            .then(() => showToast(`${missing.length} défis ajoutés.`, 'success'))
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    }

    /* --- Le niveau de départ ------------------------------------------------

       Toutes les LAN n'ont pas été comptées ici. Sans réglage, un vétéran de
       dix soirées repart au niveau 1 et le classement d'expérience raconte
       n'importe quoi.

       On n'efface jamais ce qui a été gagné : les récompenses de défis, de
       hauts faits et de présence restent intactes. Ce réglage écrit une seule
       ligne par joueur, à une clé déterministe — la réécrire remplace le
       crédit précédent au lieu de s'y ajouter. Les règles Firebase refusent
       une valeur négative : on ne peut donc que compléter un retard, jamais
       retirer de l'expérience réellement gagnée. */
    const LEVEL_ADJUST_TYPE = 'adjust';

    function levelAdjustId(uid) {
        return uid + '__adjust';
    }

    function earnedXpWithoutAdjust(uid) {
        const adjust = ((globalXp || {}).awards || {})[levelAdjustId(uid)];
        return xpTotal(globalXp, uid) - (Number(adjust && adjust.delta) || 0);
    }

    function describeLevelTarget() {
        const select = document.getElementById('level-user-select');
        const target = document.getElementById('level-target');
        const line = document.getElementById('level-current');
        if (!select || !target || !line) return;

        const uid = select.value;
        if (!uid) { line.textContent = 'Choisissez un joueur pour voir son niveau actuel.'; return; }

        const earned = earnedXpWithoutAdjust(uid);
        const current = xpLevel(xpTotal(globalXp, uid));
        const wanted = Math.max(1, Math.min(60, Math.round(Number(target.value) || 1)));
        const needed = xpForLevel(wanted);
        const credit = Math.max(0, needed - earned);

        const floor = xpLevel(earned).level;
        line.textContent = wanted < floor
            ? `Niveau ${current.level} aujourd'hui. ${playerLabel(uid)} a gagné le niveau ${floor} ici : `
                + 'le crédit de départ tombera à zéro, mais rien ne sera retiré.'
            : `Niveau ${current.level} aujourd'hui · ${xpTotal(globalXp, uid)} XP, dont ${earned} gagnés ici. `
                + `Viser le niveau ${wanted} pose un crédit de départ de ${credit} XP.`;
    }

    document.getElementById('level-user-select')?.addEventListener('change', describeLevelTarget);
    document.getElementById('level-target')?.addEventListener('input', describeLevelTarget);

    document.getElementById('btn-set-level')?.addEventListener('click', () => {
        const user = auth.currentUser;
        const select = document.getElementById('level-user-select');
        const target = document.getElementById('level-target');
        if (!user || !select || !target) return;

        const uid = select.value;
        if (!uid) { showToast('Choisissez un joueur.', 'error'); return; }

        const wanted = Math.max(1, Math.min(60, Math.round(Number(target.value) || 1)));
        const earned = earnedXpWithoutAdjust(uid);
        const credit = Math.max(0, xpForLevel(wanted) - earned);
        const name = playerLabel(uid);

        askConfirm(credit
            ? `Poser un crédit de départ de ${credit} XP à ${name} ? Il passera au niveau ${wanted}.`
            : `Retirer le crédit de départ de ${name} ? Il retombera au niveau qu'il a réellement gagné ici.`,
        { title: '✦ Niveau de départ' }).then(ok => {
            if (!ok) return;
            db.ref('lan/xp/awards/' + levelAdjustId(uid)).set({
                uid: uid,
                delta: credit,
                type: LEVEL_ADJUST_TYPE,
                reason: 'Soirées d\'avant l\'application',
                by: user.uid,
                ts: firebase.database.ServerValue.TIMESTAMP
            })
                .then(() => {
                    showToast(`${name} est au niveau ${xpLevel(earned + credit).level}.`, 'success');
                    describeLevelTarget();
                })
                .catch(err => showToast('Refusé : ' + err.message, 'error'));
        });
    });

    /* --- La boîte à idées -------------------------------------------------- */

    function renderSuggestions(user) {
        const mount = document.getElementById('suggestions-list');
        if (!mount) return;
        mount.innerHTML = '';

        // Tout le monde voit tout : même règle que le registre. Une idée lue
        // par les autres a une chance d'être appuyée.
        const list = allSuggestions(globalQuests).slice(0, 20);
        if (!list.length) {
            mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Rien pour l\'instant.</p>';
            return;
        }

        list.forEach(item => {
            const card = document.createElement('div');
            card.className = 'shop-request';
            const reply = item.reply
                ? `<p class="shop-card__meta">↳ ${escapeHtml(item.repliedByName || 'Admin')} : ${escapeHtml(item.reply)}</p>` : '';
            card.innerHTML = `
                <div class="shop-card__head">
                    <h4 class="shop-card__name">${escapeHtml(item.userName || playerLabel(item.uid))}</h4>
                    <span class="shop-card__meta">${escapeHtml(formatAge(item.ts))}</span>
                </div>
                <p class="shop-card__desc">${escapeHtml(item.text)}</p>
                ${reply}
            `;

            const actions = document.createElement('div');
            actions.className = 'shop-card__actions';

            if (window.currentUserIsGamemaster && !item.reply) {
                const answer = document.createElement('button');
                answer.className = 'gold-link-btn';
                answer.textContent = 'Répondre';
                answer.addEventListener('click', () => replyToSuggestion(item));
                actions.appendChild(answer);
            }
            if (item.uid === user.uid || window.currentUserIsGamemaster) {
                const del = document.createElement('button');
                del.className = 'gold-link-btn';
                del.style.color = 'var(--danger-color)';
                del.textContent = 'Supprimer';
                del.addEventListener('click', () => {
                    db.ref('lan/suggestions/' + item.id).remove()
                        .then(() => showToast('Supprimé.', 'success'))
                        .catch(err => showToast('Erreur : ' + err.message, 'error'));
                });
                actions.appendChild(del);
            }

            if (actions.children.length) card.appendChild(actions);
            mount.appendChild(card);
        });
    }

    function replyToSuggestion(item) {
        const user = auth.currentUser;
        if (!user) return;

        openFormModal({
            title: 'Répondre à ' + (item.userName || 'un joueur'),
            intro: '« ' + item.text + ' »',
            submitLabel: 'Répondre',
            fields: [
                { key: 'reply', type: 'textarea', label: 'Votre réponse', rows: 3 }
            ]
        }).then(values => {
            if (!values) return;
            const text = (values.reply || '').trim();
            if (!text) { showToast('Réponse vide.', 'error'); return; }

            db.ref('lan/suggestions/' + item.id).update({
                reply: text.slice(0, 1000),
                repliedBy: user.uid,
                repliedByName: user.displayName || 'Admin',
                repliedAt: firebase.database.ServerValue.TIMESTAMP,
                status: 'done'
            })
                .then(() => {
                    if (item.uid !== user.uid) {
                        sendNotification(item.uid, 'Réponse à votre idée : ' + text.slice(0, 80), 'info');
                    }
                    showToast('Répondu.', 'success');
                })
                .catch(err => showToast('Erreur : ' + err.message, 'error'));
        });
    }

    document.getElementById('btn-suggest')?.addEventListener('click', () => {
        const user = auth.currentUser;
        const field = document.getElementById('suggest-text');
        if (!user || !field) return;
        const value = field.value.trim();
        if (!value) { showToast('Écrivez quelque chose d\'abord.', 'error'); return; }

        db.ref('lan/suggestions').push().set({
            uid: user.uid,
            userName: user.displayName || 'Un joueur',
            text: value.slice(0, 1000),
            status: 'open',
            ts: firebase.database.ServerValue.TIMESTAMP
        })
            .then(() => {
                field.value = '';
                showToast('Envoyé à l\'admin !', 'success');
            })
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    });

    /* Proposer un défi. Un admin l'ouvre directement ; un joueur le propose, et
       il attend l'approbation — les règles plafonnent d'ailleurs sa récompense.
       Un seul formulaire : avant, c'étaient cinq boîtes grises à la suite, sans
       retour possible et sans voir ce qu'on venait de saisir. */
    document.getElementById('btn-new-challenge')?.addEventListener('click', () => {
        const user = auth.currentUser;
        if (!user) return;
        const isGm = !!window.currentUserIsGamemaster;

        openFormModal({
            title: isGm ? 'Créer un défi' : 'Proposer un défi',
            intro: isGm
                ? 'Il sera ouvert à tout le monde immédiatement.'
                : `L'admin décidera. Au maximum ${CHALLENGES.MAX_PROPOSED_ZL} ${ECONOMY.CURRENCY} et ${CHALLENGES.MAX_PROPOSED_XP} XP.`,
            submitLabel: isGm ? 'Ouvrir le défi' : 'Proposer à l\'admin',
            fields: [
                { key: 'title', type: 'text', label: 'Le défi, en une ligne',
                  placeholder: 'Ex : 10 pompes d\'affilée' },
                { key: 'description', type: 'textarea', label: 'Les règles exactes',
                  placeholder: 'Ce qui compte, ce qui ne compte pas.', rows: 2 },
                { key: 'category', type: 'select', label: 'Catégorie',
                  options: CHALLENGES.CATEGORIES.map(c => ({ value: c.key, label: `${c.icon} ${c.label}` })) },
                { key: 'zl', type: 'number', label: `Récompense en ${ECONOMY.CURRENCY}`,
                  value: 80, min: 0 },
                { key: 'xp', type: 'number', label: 'Récompense en XP', value: 50, min: 0 }
            ]
        }).then(values => {
            if (!values) return;
            const title = (values.title || '').trim();
            if (!title) { showToast('Il manque le titre.', 'error'); return; }

            let zl = Math.max(0, Math.round(Number(values.zl) || 0));
            let xp = Math.max(0, Math.round(Number(values.xp) || 0));
            if (!isGm) {
                zl = Math.min(zl, CHALLENGES.MAX_PROPOSED_ZL);
                xp = Math.min(xp, CHALLENGES.MAX_PROPOSED_XP);
            }

            db.ref('lan/challenges').push().set({
                title: title.slice(0, 120),
                description: (values.description || '').trim(),
                category: values.category || 'autre',
                zl: zl,
                xp: xp,
                repeatable: true,
                status: isGm ? 'open' : 'proposed',
                createdBy: user.uid,
                createdByName: user.displayName || 'Un joueur',
                createdAt: firebase.database.ServerValue.TIMESTAMP
            })
                .then(() => showToast(isGm ? 'Défi ouvert !' : 'Proposé ! L\'admin décidera.', 'success'))
                .catch(err => showToast('Erreur : ' + err.message, 'error'));
        });
    });

    /* Les titres de la soirée en cours : comparatifs, donc provisoires tant
       que la LAN n'est pas close. On le dit — un titre qui change de main sans
       prévenir passerait pour un bug. */
    function renderLanTitlesPanel() {
        if (!shopPaneIsOpen('registre')) return;
        const panel = document.getElementById('titles-panel');
        const mount = document.getElementById('lan-titles');
        if (!panel || !mount) return;

        const titles = lanTitles(achData(), economyPlayers());
        if (!titles.length) { panel.style.display = 'none'; return; }

        panel.style.display = 'block';
        mount.innerHTML = '';
        titles.forEach(entry => {
            const row = document.createElement('div');
            row.className = 'lan-title-row';
            row.innerHTML = `
                <span class="lan-title-row__label">${escapeHtml(entry.title.label)}</span>
                <span class="lan-title-row__who">${escapeHtml(playerLabel(entry.uid))}</span>
            `;
            mount.appendChild(row);
        });

        const note = document.createElement('p');
        note.className = 'panel-section__hint';
        note.style.marginTop = '12px';
        note.textContent = globalSettings.lanFinished
            ? 'Décernés à la clôture.'
            : 'Provisoire : les titres sont décernés à la clôture de la soirée.';
        mount.appendChild(note);
    }

    function renderXpBoard() {
        if (!shopPaneIsOpen('registre')) return;
        const mount = document.getElementById('xp-board');
        if (!mount) return;
        mount.innerHTML = '';

        const board = xpLeaderboard(globalXp, economyPlayers());
        if (!board.length) {
            mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Personne n\'a encore d\'expérience.</p>';
            return;
        }

        board.slice(0, 10).forEach((row, i) => {
            const line = document.createElement('button');
            line.className = 'rank-row rank-row--player';
            line.innerHTML = `
                <span style="color: var(--secondary-text); min-width: 24px;">${i + 1}</span>
                <span style="flex: 1; color: var(--primary-text); text-align: left;">${escapeHtml(playerFullName(playerLabel(row.uid), playerNickname(achData(), row.uid)))}</span>
                <span class="shop-card__price">${escapeHtml(levelTitle(row.level))}</span>
            `;
            line.addEventListener('click', () => showPlayerVotesModal(row.uid, playerLabel(row.uid), globalVotes));
            mount.appendChild(line);
        });
    }

    /* ---------- L'arbitre ----------
       Tourne sur les clients des maîtres du jeu. Il n'invente rien : il inscrit
       ce que tout le monde peut déjà calculer. La clé est déterministe, donc
       deux maîtres du jeu en ligne écrivent le même nœud plutôt que deux
       récompenses. Un joueur seul verra ses hauts faits « atteints » sans être
       inscrits jusqu'à ce qu'un maître du jeu se connecte — c'est la même
       dépendance que la validation des achats. */

    let granting = false;

    function grantPendingAchievements() {
        const user = auth.currentUser;
        if (!user || !window.currentUserIsGamemaster || granting) return;

        const waiting = pendingAchievements(achData(), economyPlayers());
        if (!waiting.length) return;

        granting = true;
        const next = waiting[0];

        db.ref('lan/xp/awards/' + achievementAwardId(next.uid, next.ach.id)).set({
            uid: next.uid,
            delta: next.ach.xp,
            type: 'achievement',
            reason: next.ach.label,
            refId: next.ach.id,
            by: user.uid,
            ts: firebase.database.ServerValue.TIMESTAMP
        })
            .then(() => {
                if (next.uid !== user.uid) {
                    sendNotification(next.uid,
                        `Haut fait : ${next.ach.label} (+${next.ach.xp} XP)`, 'success');
                }
            })
            .catch(() => { /* déjà inscrit par un autre maître du jeu, ou refusé */ })
            .finally(() => {
                granting = false;
                // On enchaîne : une soirée entière de jalons doit se rattraper
                // d'un coup quand le maître du jeu arrive.
                grantPendingAchievements();
            });
    }
    /* Acheter, c'est déposer une demande — jamais se débiter soi-même. Le
       maître du jeu tranche, et c'est seulement là que le registre bouge. */
    /* Combien on peut s'en offrir, sans jamais passer sous zéro ni dépasser le
       stock. Sert au bouton « Max » comme au plafond du champ. */
    function affordableCount(itemId, item) {
        const user = auth.currentUser;
        const price = Number(item.price) || 0;
        if (price <= 0) return 1;
        let max = Math.floor(availablePoints(globalEconomy, user.uid) / price);
        const left = itemStockLeft(globalEconomy, itemId, item);
        if (left !== null) max = Math.min(max, left);
        return Math.max(0, max);
    }

    /* Acheter N exemplaires d'un coup. Tout part dans UNE écriture
       multi-chemins : Firebase applique le lot entier ou rien, donc on ne peut
       pas être débité de trois boosters et n'en recevoir qu'un.

       Le joueur écrit lui-même ses lignes de registre, ce qu'il ne peut faire
       nulle part ailleurs. Les règles l'y autorisent parce qu'une ligne de type
       « purchase » est forcément NÉGATIVE et forcément égale au prix affiché en
       boutique : elle ne peut qu'appauvrir celui qui la signe. */
    function buyItem(itemId, item, quantity, targetUid, targetName) {
        const user = auth.currentUser;
        if (!user) return Promise.resolve();

        const count = Math.max(1, Math.floor(Number(quantity) || 1));
        const price = Number(item.price) || 0;
        const update = {};
        const purchaseIds = [];

        for (let i = 0; i < count; i += 1) {
            const purchaseId = db.ref('lan/economy/purchases').push().key;
            const entryId = db.ref('lan/economy/ledger').push().key;
            purchaseIds.push(purchaseId);

            update['lan/economy/ledger/' + entryId] = {
                uid: user.uid,
                delta: -price,
                type: 'purchase',
                itemId: itemId,
                reason: item.name || 'Achat',
                refId: purchaseId,
                ts: firebase.database.ServerValue.TIMESTAMP
            };
            update['lan/economy/purchases/' + purchaseId] = {
                itemId: itemId,
                itemName: item.name || 'Article',
                price: price,
                uid: user.uid,
                userName: user.displayName || 'Un joueur',
                targetUid: targetUid || null,
                targetName: targetName || null,
                status: 'granted',
                ts: firebase.database.ServerValue.TIMESTAMP
            };
        }

        // Ces paquets-là s'annoncent au moment du clic : le sceau qui suivra
        // restera muet, sinon acheter cinq boosters ferait dix bulles.
        if (isPackItem(item)) purchaseIds.forEach(id => sealedQuietly.add(id));

        return db.ref().update(update)
            .then(() => {
                if (isPackItem(item)) {
                    showToast(count > 1
                        ? `${count} boosters achetés ! Ils vous attendent dans la collection.`
                        : 'Booster acheté ! Il vous attend dans la collection.', 'success');
                } else {
                    showToast(`${item.name || 'Article'}${count > 1 ? ' ×' + count : ''} : c'est à vous !`, 'success');
                }
                if (targetUid && targetUid !== user.uid) {
                    sendNotification(targetUid,
                        `${user.displayName || 'Quelqu\'un'} vous joue « ${item.name || 'un handicap'} »`, 'info');
                }
            })
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    }

    function requestPurchase(itemId, item) {
        const user = auth.currentUser;
        if (!user) return;
        // Un handicap sans cible serait du sabotage anonyme : on demande sur
        // qui, et le nom restera visible dans le registre. On n'en achète qu'un
        // à la fois — jouer trois fois le même handicap n'a pas de sens.
        if (item.needsTarget) {
            const others = playerOptions(false);
            if (!others.length) {
                showToast('Aucun autre joueur à viser pour le moment.', 'error');
                return;
            }
            openFormModal({
                title: item.name || 'Handicap',
                intro: `${formatPoints(item.price)}. Son nom restera au registre, à côté du tien.`,
                submitLabel: 'Jouer sur lui',
                fields: [
                    { key: 'target', type: 'select', label: 'Sur qui ?', options: others }
                ]
            }).then(values => {
                if (!values || !values.target) return;
                buyItem(itemId, item, 1, values.target, playerLabel(values.target));
            });
            return;
        }

        // Tout le reste s'achète en quantité. Un seul exemplaire possible ? On
        // ne fait pas perdre un écran pour choisir « 1 ».
        const max = affordableCount(itemId, item);
        if (max <= 1) {
            askConfirm(`Acheter « ${item.name} » pour ${formatPoints(item.price)} ?`,
                { title: '🛍️ Boutique' }).then(ok => { if (ok) buyItem(itemId, item, 1, null, null); });
            return;
        }

        openQuantityModal(itemId, item, max);
    }

    /* Le choix de la quantité : un champ, deux flèches, et « Max ». Le total se
       met à jour à chaque frappe — on doit voir ce qu'on va payer avant de
       payer. */
    function openQuantityModal(itemId, item, max) {
        const modal = document.getElementById('quantity-modal');
        if (!modal) { buyItem(itemId, item, 1, null, null); return; }

        const price = Number(item.price) || 0;
        const input = document.getElementById('quantity-input');
        const total = document.getElementById('quantity-total');
        const go = document.getElementById('quantity-go');
        const hint = document.getElementById('quantity-hint');

        document.getElementById('quantity-name').textContent = item.name || 'Acheter';
        input.max = String(max);
        input.value = '1';
        hint.textContent = `Vous pouvez en prendre ${max} au maximum avec votre solde.`;

        const clamp = (n) => Math.max(1, Math.min(max, Math.floor(Number(n) || 1)));
        const paint = () => {
            const n = clamp(input.value);
            total.textContent = `${n} × ${formatPoints(price)} = ${formatPoints(n * price)}`;
            go.textContent = `Acheter · ${formatPoints(n * price)}`;
        };
        const setN = (n) => { input.value = String(clamp(n)); paint(); };

        // On remplace les gestionnaires plutôt que d'en empiler : la modale
        // sert à tous les articles, et deux clics par flèche seraient absurdes.
        document.getElementById('quantity-minus').onclick = () => setN(clamp(input.value) - 1);
        document.getElementById('quantity-plus').onclick = () => setN(clamp(input.value) + 1);
        document.getElementById('quantity-max').onclick = () => setN(max);
        input.oninput = paint;
        input.onblur = () => setN(input.value);
        go.onclick = () => {
            modal.style.display = 'none';
            buyItem(itemId, item, clamp(input.value), null, null);
        };
        document.getElementById('quantity-cancel').onclick = () => { modal.style.display = 'none'; };

        paint();
        modal.style.display = 'flex';
        input.focus();
        input.select();
    }

    /* --- Registre, fortunes, mes demandes -------------------------------- */

    // Le registre est public : c'est lui qui rend l'économie honnête. Chacun
    // voit qui a reçu quoi, et pourquoi.
    function renderShopFeed() {
        if (!shopPaneIsOpen('registre')) return;
        const mount = document.getElementById('shop-feed');
        if (!mount) return;
        mount.innerHTML = '';

        const feed = economyFeed(globalEconomy, 40);
        if (!feed.length) {
            mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Aucun mouvement pour le moment.</p>';
            return;
        }

        feed.forEach(entry => {
            const delta = Number(entry.delta) || 0;
            const row = document.createElement('div');
            row.className = 'shop-move';
            row.innerHTML = `
                <span class="shop-move__text">${escapeHtml(playerLabel(entry.uid))}
                    <span class="shop-move__why">${escapeHtml(entry.reason || 'Mouvement')}${entry.byName ? ` · par ${escapeHtml(entry.byName)}` : ''}</span>
                </span>
                <span class="shop-move__delta ${delta >= 0 ? 'is-up' : 'is-down'}">${delta >= 0 ? '+' : ''}${delta}</span>
            `;
            mount.appendChild(row);
        });
    }

    function renderShopLeaderboard() {
        if (!shopPaneIsOpen('registre')) return;
        const mount = document.getElementById('shop-leaderboard');
        if (!mount) return;
        mount.innerHTML = '';

        const board = economyLeaderboard(globalEconomy, economyPlayers());
        if (!board.length) {
            mount.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Personne n\'a encore gagné de points.</p>';
            return;
        }

        board.slice(0, 10).forEach((entry, i) => {
            const row = document.createElement('button');
            row.className = 'rank-row rank-row--player';
            row.innerHTML = `
                <span style="color: var(--secondary-text); min-width: 24px;">${i + 1}</span>
                <span style="flex: 1; color: var(--primary-text); text-align: left;">${escapeHtml(playerFullName(playerLabel(entry.uid), playerNickname(achData(), entry.uid)))}</span>
                <span class="shop-card__price">${escapeHtml(formatPoints(entry.balance))}</span>
            `;
            row.addEventListener('click', () => showPlayerVotesModal(entry.uid, playerLabel(entry.uid), globalVotes));
            mount.appendChild(row);
        });
    }

    function renderMyShopRequests(user) {
        if (!shopPaneIsOpen('registre')) return;
        const panel = document.getElementById('shop-my-purchases-panel');
        const mount = document.getElementById('shop-my-purchases');
        if (!panel || !mount) return;

        const mine = Object.entries(globalEconomy.purchases || {})
            .map(([id, p]) => Object.assign({ id: id }, p))
            .filter(p => p.uid === user.uid && p.status === 'pending')
            .sort((a, b) => (a.ts || 0) - (b.ts || 0));

        if (!mine.length) { panel.style.display = 'none'; return; }
        panel.style.display = 'block';
        mount.innerHTML = '';

        mine.forEach(p => {
            const row = document.createElement('div');
            row.className = 'shop-move';
            row.innerHTML = `
                <span class="shop-move__text">${escapeHtml(p.itemName || 'Article')}
                    <span class="shop-move__why">${escapeHtml(formatPoints(p.price))} réservés${p.targetName ? ` · visé : ${escapeHtml(p.targetName)}` : ''}</span>
                </span>
            `;
            const cancel = document.createElement('button');
            cancel.className = 'gold-link-btn';
            cancel.textContent = 'Annuler';
            cancel.addEventListener('click', () => {
                db.ref('lan/economy/purchases/' + p.id).remove()
                    .then(() => showToast('Demande annulée.', 'success'))
                    .catch(err => showToast('Erreur : ' + err.message, 'error'));
            });
            row.appendChild(cancel);
            mount.appendChild(row);
        });
    }

    /* --- Créditer (maître du jeu) ---------------------------------------- */

    function fillGrantSelect() {
        const select = document.getElementById('grant-user-select');
        if (!select || !window.currentUserIsGamemaster) return;
        // Ne pas écraser une sélection en cours : les mises à jour temps réel
        // arrivent pendant que le maître du jeu remplit le formulaire.
        const previous = select.value;
        select.innerHTML = '<option value="">Sélectionner un joueur...</option>';
        economyPlayers()
            .map(uid => ({ uid, name: playerLabel(uid) }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(player => {
                const option = document.createElement('option');
                option.value = player.uid;
                option.textContent = `${player.name} — ${formatPoints(economyBalance(globalEconomy, player.uid))}`;
                select.appendChild(option);
            });
        if (previous) select.value = previous;
    }

    document.getElementById('btn-grant-points')?.addEventListener('click', () => {
        const uid = document.getElementById('grant-user-select').value;
        const amountInput = document.getElementById('grant-amount');
        const reasonInput = document.getElementById('grant-reason');
        const amount = Math.round(Number(amountInput.value));

        if (!uid) { showToast('Sélectionnez un joueur.', 'error'); return; }
        if (!amountInput.value.trim() || !isFinite(amount) || amount === 0) {
            showToast('Montant invalide.', 'error');
            return;
        }
        const reason = reasonInput.value.trim();
        if (!reason) { showToast('Dites pourquoi : le registre est public.', 'error'); return; }

        writeLedger({ uid: uid, delta: amount, type: 'grant', reason: reason })
            .then(() => {
                sendNotification(uid, `${amount > 0 ? '+' : ''}${amount} ${ECONOMY.CURRENCY} — ${reason}`, 'success');
                amountInput.value = '';
                reasonInput.value = '';
                showToast('Crédité.', 'success');
            })
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    });

    /* Distribuer la même somme à tout le monde : c'est ainsi qu'on ouvre une
       soirée. Chacun part avec le même pécule, et les défis redistribuent
       ensuite — plutôt que de faire tourner la planche à billets. */
    document.getElementById('btn-seed-all')?.addEventListener('click', () => {
        const input = document.getElementById('seed-amount');
        const amount = Math.round(Number(input.value));
        if (!input.value.trim() || !isFinite(amount) || amount <= 0) {
            showToast('Montant invalide.', 'error');
            return;
        }

        const players = economyPlayers();
        if (!players.length) { showToast('Aucun joueur connu.', 'error'); return; }

        askConfirm(`Créditer ${formatPoints(amount)} à ${players.length} joueur${players.length > 1 ? 's' : ''} ?`,
            { title: '🎁 Distribution' }).then(ok => {
                if (!ok) return;
                Promise.all(players.map(uid => writeLedger({
                    uid: uid,
                    delta: amount,
                    type: 'grant',
                    reason: 'Pécule de départ'
                })))
                    .then(() => {
                        input.value = '';
                        showToast(`${players.length} joueurs crédités.`, 'success');
                    })
                    .catch(err => showToast('Erreur : ' + err.message, 'error'));
            });
    });

    /* --- Mettre un article en boutique ----------------------------------- */

    document.getElementById('btn-add-shop-item')?.addEventListener('click', () => {
        const select = document.getElementById('shop-item-category');
        if (select && !select.options.length) {
            ECONOMY.CATEGORIES.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.key;
                option.textContent = `${cat.icon} ${cat.label}`;
                select.appendChild(option);
            });
        }
        document.getElementById('add-shop-item-modal').style.display = 'flex';
    });

    document.getElementById('cancel-shop-item-btn')?.addEventListener('click', () => {
        document.getElementById('add-shop-item-modal').style.display = 'none';
    });

    document.getElementById('add-shop-item-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const user = auth.currentUser;
        if (!user) return;

        const name = document.getElementById('shop-item-name').value.trim();
        const priceField = document.getElementById('shop-item-price');
        const price = Math.round(Number(priceField.value));
        const stockField = document.getElementById('shop-item-stock');
        const stock = Math.round(Number(stockField.value));

        if (!name) { showToast('Il manque le nom.', 'error'); return; }
        if (!priceField.value.trim() || !isFinite(price) || price < 0) {
            showToast('Prix invalide.', 'error');
            return;
        }

        db.ref('lan/economy/catalog').push().set({
            name: name,
            description: document.getElementById('shop-item-desc').value.trim(),
            price: price,
            category: document.getElementById('shop-item-category').value || 'fun',
            stock: stockField.value.trim() && isFinite(stock) && stock > 0 ? stock : null,
            needsTarget: document.getElementById('shop-item-target').checked,
            kind: document.getElementById('shop-item-pack').checked ? 'pack' : null,
            active: true,
            createdBy: user.uid,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            document.getElementById('add-shop-item-form').reset();
            document.getElementById('add-shop-item-modal').style.display = 'none';
            showToast(`"${name}" est en boutique !`, 'success');
        }).catch(err => showToast('Erreur : ' + err.message, 'error'));
    });


    /* ======================================================================
       LA COLLECTION
       Un jeu de cartes dont le set est frappé par le vote : les jeux que les
       joueurs ont demandés deviennent les cartes, et leur rareté est leur
       score. La rareté ne raconte donc pas une invention, elle raconte la
       soirée.

       Comme pour les points, rien de ce qui a de la valeur n'est stocké :
       la collection se REJOUE (core.js) depuis les paquets ouverts et les
       échanges acceptés. Le contenu d'un paquet ne l'est pas davantage — il
       se recalcule depuis son sceau, l'horodatage écrit par le serveur au
       moment de l'achat. C'est la seule valeur de cette application que le
       client ne choisit pas : le tirage est donc à la fois imprévisible et
       vérifiable par tout le monde, sans serveur de tirage à écrire.
       ====================================================================== */

    // Le rejeu parcourt tous les paquets : on ne le refait pas huit fois par
    // rendu. Invalidé dès que lan/tcg change.
    let tcgViewCache = null;

    function tcgView() {
        if (tcgViewCache) return tcgViewCache;
        const set = tcgCurrentSet(globalTcg);
        const replay = tcgReplay(globalTcg);
        tcgViewCache = {
            cards: replay.cards,
            applied: replay.applied,
            set: set,
            setCards: (set && set.cards) || {},
            uid: (auth.currentUser && auth.currentUser.uid) || ''
        };
        return tcgViewCache;
    }

    // Un échange se lit à l'échelle de la soirée, pas du calendrier :
    // formatAge() compte en jours, ce qui dirait « aujourd'hui » toute la nuit.
    function timeSince(ts) {
        if (!ts) return '';
        const minutes = Math.floor((Date.now() - ts) / 60000);
        if (minutes < 1) return "à l'instant";
        if (minutes < 60) return `il y a ${minutes} min`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `il y a ${hours} h`;
        return `il y a ${Math.floor(hours / 24)} j`;
    }

    /* Les illustrations générées pour les Signature, chargées à la demande.
       Elles vivent sous `lan/cardArt`, à côté de `lan/tcg` et non dedans : ce
       sont des images en base64, et les faire transiter dans la synchro
       permanente de tous les clients coûterait des mégaoctets par connexion.
       Huit cartes par set : on les lit une par une, et on retient. */
    const generatedArt = {};
    const generatedArtNames = {};
    const generatedArtPending = new Set();

    function ensureGeneratedArt(gameKey) {
        if (!gameKey || generatedArt[gameKey] !== undefined || generatedArtPending.has(gameKey)) return;
        generatedArtPending.add(gameKey);
        db.ref('lan/cardArt/' + gameKey).once('value')
            .then(snapshot => {
                const node = snapshot.val();
                generatedArt[gameKey] = (node && node.data) || null;
                generatedArtNames[gameKey] = (node && node.name) || '';
                if (node && node.data) renderCollection();
            })
            .catch(() => { generatedArt[gameKey] = null; })
            .finally(() => generatedArtPending.delete(gameKey));
    }

    /* Repli pour les sets composés avant que les cartes portent un appId : on
       retombe sur la résolution par nom, à l'ancienne. Sans lui, un set créé
       par une version précédente n'affiche plus une seule illustration —
       c'est exactement ce qui est arrivé. Chargé à l'approche de l'écran. */
    const legacyArtObserver = ('IntersectionObserver' in window)
        ? new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                observer.unobserve(entry.target);
                const img = entry.target;
                getGameImage(img.dataset.game || '').then(url => { if (url) img.src = url; });
            });
        }, { rootMargin: '320px' })
        : null;

    /* Illustration d'une carte. Quand la carte porte son appId — tous les sets
       composés à partir de maintenant — l'adresse de la jaquette Steam s'en
       déduit et le set entier ne déclenche pas une seule requête.

       La jaquette d'une carte se déduit de l'appId, sans le moindre appel
       réseau : c'est ce qui rend le set instantané. Mais tous les appId n'ont
       pas de `header.jpg` — un jeu retiré du magasin, un DLC, une entrée de
       bibliothèque sans fiche, un identifiant d'une autre boutique. Sans
       repli, ces cartes-là affichaient un cadre vide, au hasard des sets.

       Trois marches, de la moins chère à la plus chère : l'autre CDN de Steam,
       puis la recherche par nom (qui passe par l'API et tente Wikipédia), puis
       l'icône générique. Chaque image ne descend l'escalier qu'une fois. */
    function armCardArtFallback(imgEl, card) {
        if (imgEl.dataset.artFallback) return;
        imgEl.dataset.artFallback = '1';

        imgEl.addEventListener('error', () => {
            const step = imgEl.dataset.artStep || '';
            const label = card.name || card.gameKey;

            if (!step && card.appId) {
                imgEl.dataset.artStep = 'mirror';
                imgEl.src = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/'
                    + encodeURIComponent(card.appId) + '/header.jpg';
                return;
            }

            if (step !== 'search') {
                imgEl.dataset.artStep = 'search';
                getGameImage(label)
                    .then(url => { imgEl.src = url || DEFAULT_GAME_ICON; })
                    .catch(() => { imgEl.src = DEFAULT_GAME_ICON; });
                return;
            }

            // Dernière marche : une icône en data: URI, qui ne peut pas échouer
            // à son tour et donc pas boucler.
            imgEl.dataset.artStep = 'done';
            imgEl.src = DEFAULT_GAME_ICON;
        });
    }

    function paintCardArt(imgEl, card) {
        if (card.rarity === 'signature') ensureGeneratedArt(card.gameKey);
        armCardArtFallback(imgEl, card);

        const known = cardImage(card, generatedArt);
        if (known) { imgEl.src = known; return; }

        const label = card.name || card.gameKey;
        const cached = getCachedGameImage(label);
        if (cached) { imgEl.src = cached; return; }

        imgEl.src = DEFAULT_GAME_ICON;
        imgEl.dataset.game = label;
        if (legacyArtObserver) legacyArtObserver.observe(imgEl);
        else getGameImage(label).then(url => { if (url) imgEl.src = url; });
    }

    /* Une seule fabrique de carte pour la grille, les doubles, l'échange et la
       révélation : une carte doit se ressembler partout. */
    function buildCard(card, options) {
        const opts = options || {};
        const rarity = rarityMeta(card.rarity);
        const node = document.createElement('article');
        node.className = `tcard tcard--${rarity.key}`;
        if (card.foil) node.classList.add('is-foil');
        if (opts.missing) node.classList.add('is-missing');
        if (opts.selected) node.classList.add('is-picked');

        // Le reflet couvre la carte entière et se pose en dernier, donc au-dessus
        // de tout le reste. Il reste invisible tant qu'aucun pointeur ne la touche.
        node.innerHTML = `
            <div class="tcard__art">
                <img class="tcard__img" alt="" loading="lazy">
                ${card.foil ? '<span class="tcard__foil"></span>' : ''}
            </div>
            <h4 class="tcard__name">${escapeHtml(card.name || card.gameKey)}</h4>
            <div class="tcard__foot">
                <span class="tcard__rarity">${escapeHtml(card.foil ? rarity.short + ' ✦' : rarity.short)}</span>
                <span class="tcard__badge">${escapeHtml(opts.badge || '')}</span>
            </div>
            <span class="tcard__glare"></span>
        `;
        paintCardArt(node.querySelector('.tcard__img'), card);

        if (opts.onClick) {
            node.setAttribute('role', 'button');
            node.tabIndex = 0;
            node.addEventListener('click', opts.onClick);
        }
        return node;
    }

    /* --- Le brillant vivant -----------------------------------------------
       Une carte brillante doit donner envie de la bouger. À la souris, le
       pointeur pilote deux choses : la position du reflet (--px / --py, plus
       --pfc pour son intensité) et le décalage du voile arc-en-ciel
       (--pxn / --pyn), le tout sur une carte légèrement inclinée vers le
       curseur (--rx / --ry). C'est la même mécanique que les cartes
       holographiques de Simon Goellner : une couche de couleur en color-dodge,
       une couche de lumière en overlay, les deux suivant le pointeur.

       On passe par Pointer Events plutôt que mousemove : le même code sert au
       doigt et au stylet, sans branche tactile séparée. */

    const REDUCED_MOTION = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Les brillantes partout, et la carte mise en scène (révélation, fiche)
    // même ordinaire — c'est là qu'on la regarde vraiment.
    const LIVE_CARD_SELECTOR = '.tcard.is-foil, .tcard--reveal, .card-solo .tcard';

    let liveCard = null;
    let livePointer = null;
    // Un booléen posé AVANT la demande d'image, et levé dans le rappel : dans
    // cet ordre, le drapeau ne peut pas rester coincé à « en attente » et figer
    // le reflet pour le reste de la session.
    let liveScheduled = false;

    function paintLiveCard() {
        const card = liveCard;
        const event = livePointer;
        if (!card || !event) return;

        const box = card.getBoundingClientRect();
        if (!box.width || !box.height) return;

        const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
        const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
        const dx = x - 0.5;
        const dy = y - 0.5;

        card.style.setProperty('--px', `${(x * 100).toFixed(2)}%`);
        card.style.setProperty('--py', `${(y * 100).toFixed(2)}%`);
        card.style.setProperty('--pxn', dx.toFixed(3));
        card.style.setProperty('--pyn', dy.toFixed(3));
        card.style.setProperty('--pfc', Math.min(1, Math.hypot(dx, dy) * 2).toFixed(3));
        card.style.setProperty('--rx', `${(dy * -12).toFixed(2)}deg`);
        card.style.setProperty('--ry', `${(dx * 12).toFixed(2)}deg`);
    }

    function releaseLiveCard() {
        if (!liveCard) return;
        liveCard.classList.remove('is-live');
        ['--px', '--py', '--pxn', '--pyn', '--pfc', '--rx', '--ry']
            .forEach(name => liveCard.style.removeProperty(name));
        liveCard = null;
        livePointer = null;
    }

    /* Un seul écouteur pour toute la page, et un rendu par image : la grille
       peut afficher cinquante cartes, et cinquante écouteurs qui écrivent du
       style à chaque pixel parcouru coûteraient plus cher que le reflet. */
    document.addEventListener('pointermove', (e) => {
        if (REDUCED_MOTION) return;
        const card = e.target.closest ? e.target.closest(LIVE_CARD_SELECTOR) : null;
        if (card !== liveCard) {
            releaseLiveCard();
            if (card) {
                liveCard = card;
                card.classList.add('is-live');
            }
        }
        if (!liveCard) return;
        livePointer = e;
        if (liveScheduled) return;
        liveScheduled = true;
        requestAnimationFrame(() => { liveScheduled = false; paintLiveCard(); });
    }, { passive: true });

    document.addEventListener('pointerup', releaseLiveCard, { passive: true });
    document.addEventListener('pointercancel', releaseLiveCard, { passive: true });
    window.addEventListener('blur', releaseLiveCard);

    /* --- La fiche d'une carte -------------------------------------------- */

    /* Ce qui rend une carte irremplaçable n'est pas son jeu, c'est sa
       provenance : qui l'a sortie du paquet, quand, et par combien de mains
       elle est passée depuis. C'est le souvenir de soirée, pas l'inventaire. */
    function openCardModal(card) {
        const modal = document.getElementById('card-modal');
        const stage = document.getElementById('card-modal-stage');
        const body = document.getElementById('card-modal-body');
        if (!modal) return;

        stage.innerHTML = '';
        stage.appendChild(buildCard(card, {}));

        const rarity = rarityMeta(card.rarity);
        const setCard = tcgView().setCards[card.gameKey];
        const hands = (card.lineage || []).length - 1;
        const lines = [`<p class="shop-card__meta">${escapeHtml(rarity.label)}${card.foil ? ' · brillante ✦' : ''}</p>`];
        // Pourquoi cette carte est rare : c'est tout l'intérêt d'une rareté
        // tirée du groupe plutôt qu'inventée — elle s'explique, et c'est vrai.
        if (setCard) {
            lines.push(`<p class="shop-card__meta">${escapeHtml(rarityReason(setCard, tcgView().set))}</p>`);
        }
        if (card.mintedBy) {
            const when = card.mintedAt ? ` · ${new Date(card.mintedAt).toLocaleString('fr-FR')}` : '';
            lines.push(`<p class="shop-card__meta">Sortie du paquet par ${escapeHtml(playerLabel(card.mintedBy))}${escapeHtml(when)}</p>`);
        }
        if (hands > 0) {
            lines.push(`<p class="shop-card__meta">Échangée ${hands} fois : ${escapeHtml(card.lineage.map(playerLabel).join(' → '))}</p>`);
        }
        body.innerHTML = lines.join('');
        modal.style.display = 'flex';
    }

    document.getElementById('card-modal-close')?.addEventListener('click', () => {
        document.getElementById('card-modal').style.display = 'none';
    });

    /* --- Le rendu global -------------------------------------------------- */

    function renderCollection() {
        const user = auth.currentUser;
        const panel = document.getElementById('lan-tcg');
        if (!user || !panel) return;
        /* Redessiner trois cents cartes à chaque mise à jour Firebase coûte
           cher pour rien : hors de l'onglet Collection, personne ne regarde.
           Le badge du menu, lui, se met à jour dans tous les cas. */
        const visible = panel.offsetParent !== null;
        const view = tcgView();
        if (!visible) { renderTcgBadge(view); return; }

        renderSetBanner(view);
        renderTcgGmPanel(view);
        renderMyPacks(view);
        renderTradesIn(view);
        renderSetGrid(view);
        renderDupes(view);
        renderTradesOut(view);
        renderTcgLeaderboard(view);
        renderTradeFeed(view);
        renderTcgBadge(view);
    }

    function renderSetBanner(view) {
        const name = document.getElementById('tcg-set-name');
        const value = document.getElementById('tcg-progress');
        const fill = document.getElementById('tcg-progress-fill');
        const hint = document.getElementById('tcg-hint');
        if (!name) return;

        if (!view.set) {
            name.textContent = 'Pas encore de set';
            value.textContent = '—';
            fill.style.width = '0%';
            hint.textContent = 'Les cartes viennent du vote : elles apparaîtront quand le maître du jeu aura créé le set de la LAN.';
            return;
        }

        const progress = setProgress(view.setCards, view.cards, view.uid);
        name.textContent = view.set.name;
        value.textContent = `${progress.owned} / ${progress.total}`;
        fill.style.width = `${progress.percent}%`;
        hint.textContent = `${progress.percent} % du set`
            + (progress.foils ? ` · ${progress.foils} brillante${progress.foils > 1 ? 's' : ''}` : '')
            + (progress.complete ? ' · set complet 🏆' : '');
    }

    function renderTcgBadge(view) {
        const badge = document.getElementById('tcg-nav-badge');
        if (!badge) return;
        // Ce qui demande une action : un booster fermé, une proposition reçue.
        const waiting = sealedPacksOf(globalTcg, view.uid).length
            + pendingTradesFor(globalTcg, view.uid).length;
        badge.style.display = waiting ? 'inline-flex' : 'none';
        badge.textContent = waiting;
    }

    /* --- Composer le set (maître du jeu) ---------------------------------- */

    /* Tous les jeux qui peuvent devenir des cartes : les votés, plus tout ce
       que les bibliothèques Steam du groupe et les soirées passées nous ont
       appris. Sans elles, un set de trente cartes se complète en trois
       boosters. */
    function setPool() {
        return knownGames({ libraries: groupLibraries });
    }

    function renderTcgGmPanel(view) {
        const panel = document.getElementById('tcg-gm-panel');
        if (!panel) return;
        const isGm = !!window.currentUserIsGamemaster;
        panel.style.display = isGm ? 'block' : 'none';
        // Composer le set est une opération de début de soirée : le tiroir
        // reste replié le reste du temps.
        const tools = document.getElementById('tcg-gm-tools');
        if (tools) tools.style.display = isGm ? 'block' : 'none';
        const badge = document.getElementById('tcg-gm-tools-badge');
        if (badge) badge.textContent = (isGm && !view.set) ? '!' : '';
        if (!isGm) return;

        const pool = Object.keys(buildCardSet(calculateScores(globalVotes), setPool())).length;
        const state = document.getElementById('tcg-mint-state');
        if (!view.set) {
            state.textContent = pool
                ? `Aucun set. ${pool} jeux connus (votes + bibliothèques Steam) attendent de devenir des cartes.`
                : 'Aucun set, et aucun jeu connu pour en composer un.';
        } else {
            state.textContent = `Set en cours : « ${view.set.name} », ${Object.keys(view.setCards).length} cartes. `
                + `${pool} jeux connus aujourd'hui.`;
        }
        /* Le set existe déjà : le bouton principal disparaît au profit d'un
           second, explicite. Recréer sans le vouloir repartirait sur un set
           neuf alors que la soirée est lancée. */
        document.getElementById('btn-mint-set').style.display = view.set ? 'none' : 'inline-block';
        document.getElementById('btn-mint-set').disabled = !pool;
        // La soirée close, les collections sont archivées : on ne propose plus
        // de tout jeter pour recomposer.
        document.getElementById('btn-remint-set').style.display =
            (view.set && !globalSettings.lanFinished) ? 'inline-block' : 'none';
        document.getElementById('btn-debug-pack').disabled = !view.set;

        const select = document.getElementById('tcg-gift-user');
        const previous = select.value;
        select.innerHTML = '<option value="">Offrir un booster à...</option>';
        economyPlayers()
            .map(uid => ({ uid, name: playerLabel(uid) }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(player => {
                const option = document.createElement('option');
                option.value = player.uid;
                option.textContent = player.name;
                select.appendChild(option);
            });
        if (previous) select.value = previous;
    }

    /* On ne remplace jamais un set : on en compose un nouveau et on pointe
       dessus. Les cartes déjà ouvertes gardent le leur, et donc leur sens. */
    /* Recomposer un set pendant la soirée, c'est repartir de zéro pour de bon :
       on efface TOUS les anciens sets, TOUS les paquets et TOUS les échanges —
       pas seulement ceux du set remplacé. N'effacer que le set courant laissait
       dans les collections les cartes venues d'un set encore plus ancien, et le
       « nouveau départ » n'en était pas un.

       Tant que la LAN n'est pas terminée, une collection est un brouillon :
       elle ne devient un souvenir qu'à la clôture de la soirée. C'est ce qui
       autorise à tout jeter ici sans rien perdre qui compte.

       Les illustrations (`lan/cardArt`) survivent : elles sont attachées au jeu
       et non au set, et les regénérer coûterait pour rien. */
    function discardCards(keepSetId) {
        const doomed = Object.keys(globalTcg.sets || {}).filter(id => id !== keepSetId);
        return Promise.all(doomed.map(id => db.ref('lan/tcg/sets/' + id).remove()))
            .then(() => Promise.all([
                db.ref('lan/tcg/packs').remove(),
                db.ref('lan/tcg/trades').remove()
            ]));
    }

    /* Une écriture refusée par les règles ne dit rien d'utile telle quelle. Ici
       on sait pourquoi ça arrive presque toujours : les règles Firebase n'ont
       pas été republiées depuis que la carte porte `owners` et `appId`. */
    function tcgWriteError(error) {
        const code = (error && (error.code || error.message)) || '';
        if (/permission/i.test(code)) {
            return 'Écriture refusée par la base. Les règles Firebase doivent être republiées (voir SECURITY.md).';
        }
        return 'Erreur : ' + ((error && error.message) || code);
    }

    async function mintSet(force) {
        const user = auth.currentUser;
        if (!user) return;

        const previous = tcgCurrentSetId(globalTcg);
        if (!force && previous) {
            showToast('Le set de la LAN existe déjà !', 'error');
            return;
        }
        /* La soirée close, les collections sont archivées : ce ne sont plus des
           brouillons, et on ne les jette pas pour recomposer un set. */
        if (force && globalSettings.lanFinished) {
            showToast('La LAN est terminée : les cartes sont archivées. Rouvre la LAN pour recomposer un set.', 'error');
            return;
        }

        const pool = setPool();
        const preview = Object.keys(buildCardSet(calculateScores(globalVotes), pool)).length;

        const doomedPacks = Object.keys(globalTcg.packs || {}).length;
        const doomedCards = tcgCards(globalTcg).length;

        const ok = await askConfirm(
            force
                ? `Recomposer le set : environ ${preview} cartes. Tout repart de zéro — les anciens sets, les boosters et les échanges sont EFFACÉS`
                  + (doomedCards
                      ? `, soit ${doomedCards} carte${doomedCards > 1 ? 's' : ''} dans ${doomedPacks} booster${doomedPacks > 1 ? 's' : ''}, pour tout le monde.`
                      : '.')
                  + ' Tant que la soirée n\'est pas close, une collection est un brouillon. Les illustrations déjà faites sont conservées.'
                : `Créer le set de la LAN « ${globalSettings.lanName || 'LAN Demain'} » : environ ${preview} cartes, du vote au fond des bibliothèques Steam. `
                  + `Les ${TCG.SIGNATURE_COUNT} cartes du sommet recevront une illustration.`,
            { title: '🎴 Les cartes', danger: force, confirmLabel: force ? 'Tout effacer et recréer' : 'Créer le set' });
        if (!ok) return;

        showToast('Composition du set…', 'success');
        const appIds = await resolveVotedArt(pool);
        const cards = buildCardSet(calculateScores(globalVotes), Object.assign({}, pool, { appIds }));
        const count = Object.keys(cards).length;
        if (!count) { showToast('Aucun jeu illustrable : rien à composer.', 'error'); return; }

        const ref = db.ref('lan/tcg/sets').push();
        ref.set({
            name: `Set de la LAN ${globalSettings.lanName || 'LAN Demain'}`,
            ts: firebase.database.ServerValue.TIMESTAMP,
            by: user.uid,
            // Combien de bibliothèques comptaient ce jour-là : sans ce nombre,
            // « possédé par 4 joueurs » ne veut plus rien dire six mois après.
            libraries: pool.libraries,
            cards: cards
        })
            .then(() => db.ref('lan/tcg/currentSet').set(ref.key))
            // Le ménage n'a lieu qu'une fois le nouveau set en place : si
            // l'écriture échoue, on n'a rien détruit.
            .then(() => discardCards(ref.key))
            .then(() => {
                showToast(`Set créé : ${count} cartes !`, 'success');
                return openSignatureArtModal(cards);
            })
            .catch(err => showToast(tcgWriteError(err), 'error'));
    }

    /* Les jeux votés à la main n'ont pas d'appId : ils ne sont dans aucune
       bibliothèque, on ne connaît que le nom tapé par le joueur. Sans appId,
       pas d'illustration, donc pas de carte — or ce sont justement les jeux les
       plus réclamés. On les résout donc une fois, à la création du set. C'est
       borné : quelques dizaines de noms, contre plusieurs centaines de jeux de
       bibliothèque qui, eux, arrivent déjà avec leur appId. */
    function resolveVotedArt(pool) {
        const known = new Set(pool.games.map(game => cardKey(game.name)));
        const missing = calculateScores(globalVotes)
            .map(game => ({ key: cardKey(game.name), name: game.name }))
            .filter(game => game.key && !known.has(game.key));

        if (!missing.length) return Promise.resolve({});

        return Promise.all(missing.map(game =>
            fetch(`/api/get-game-image?name=${encodeURIComponent(game.name)}&fuzzy=1`)
                .then(res => (res.ok ? res.json() : null))
                .then(data => (data && data.appId ? [game.key, data.appId] : null))
                .catch(() => null)
        )).then(found => Object.fromEntries(found.filter(Boolean)));
    }

    /* Le choix des illustrations des Signature : importer les siennes, ou
       laisser le modèle dessiner ce qui manque. Importer d'abord puis générer
       ne regénère que le reste — c'est ce qui permet de n'utiliser l'API que
       pour ce qu'on n'a pas déjà fait soi-même. */
    let signatureArtCards = [];

    function openSignatureArtModal(setCards) {
        signatureArtCards = signatureCards(setCards);
        if (!signatureArtCards.length) return Promise.resolve();

        document.getElementById('signature-art-hint').textContent =
            `Ces ${signatureArtCards.length} cartes sont le sommet du set. Importe tes propres `
            + 'illustrations pour les distinguer des cartes ordinaires.';
        document.getElementById('signature-art-modal').style.display = 'flex';

        // On sait déjà lesquelles existent : on les lit avant de dessiner.
        const keys = signatureArtCards.map(card => card.gameKey).concat([PACK_ART_KEY]);
        return Promise.all(keys.map(key =>
            db.ref('lan/cardArt/' + key).once('value')
                .then(snapshot => {
                    const node = snapshot.val();
                    generatedArt[key] = (node && node.data) || null;
                    generatedArtNames[key] = (node && node.name) || '';
                })
                .catch(() => { generatedArt[key] = null; })
        )).then(() => {
            document.getElementById('pack-art-name').value = generatedArtNames[PACK_ART_KEY] || '';
            paintPackArtRow();
            paintSignatureArtList();
        });
    }

    function paintPackArtRow() {
        const mount = document.getElementById('pack-art-row');
        const art = generatedArt[PACK_ART_KEY];
        mount.innerHTML = `
            <div class="art-row">
                <img class="art-row__thumb" alt="" src="${art ? escapeHtml(art) : DEFAULT_GAME_ICON}">
                <span class="art-row__name">${escapeHtml(packLabel({ name: generatedArtNames[PACK_ART_KEY] }, globalSettings.lanName))}</span>
                <label class="art-row__pick">${art ? 'Remplacer' : 'Importer'}<input type="file" accept="image/*"></label>
            </div>
        `;
        mount.querySelector('input').addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const label = document.getElementById('pack-art-name').value.trim();
            importArt(PACK_ART_KEY, label, file).then(paintPackArtRow);
        });
    }

    document.getElementById('pack-art-name')?.addEventListener('change', (e) => {
        savePackName(e.target.value).then(paintPackArtRow);
    });

    /* Renommer l'emballage sans forcément lui donner une image : le nom seul
       suffit déjà à ce qu'un booster ne s'appelle plus « Booster de test ». */
    function savePackName(name) {
        const label = String(name || '').trim();
        if (!generatedArt[PACK_ART_KEY]) {
            // Les règles exigent `data` : sans illustration, le nom attend.
            generatedArtNames[PACK_ART_KEY] = label;
            showToast('Nom retenu. Il sera enregistré avec l\'illustration.', 'success');
            return Promise.resolve();
        }
        return db.ref('lan/cardArt/' + PACK_ART_KEY).set({
            data: generatedArt[PACK_ART_KEY],
            name: label,
            by: auth.currentUser ? auth.currentUser.uid : null,
            ts: firebase.database.ServerValue.TIMESTAMP
        })
            .then(() => {
                generatedArtNames[PACK_ART_KEY] = label;
                showToast('Booster renommé.', 'success');
            })
            .catch(err => showToast(tcgWriteError(err), 'error'));
    }

    function paintSignatureArtList() {
        const list = document.getElementById('signature-art-list');
        const generate = document.getElementById('signature-art-generate');
        list.innerHTML = '';
        let missing = 0;

        signatureArtCards.forEach(card => {
            const art = generatedArt[card.gameKey];
            if (!art) missing++;

            const row = document.createElement('div');
            row.className = 'art-row';
            row.innerHTML = `
                <img class="art-row__thumb" alt="" src="${art ? escapeHtml(art) : DEFAULT_GAME_ICON}">
                <span class="art-row__name">${escapeHtml(card.name)}</span>
                <label class="art-row__pick">${art ? 'Remplacer' : 'Importer'}<input type="file" accept="image/*"></label>
            `;
            row.querySelector('input').addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) importCardArt(card, file).then(paintSignatureArtList);
            });
            list.appendChild(row);
        });

        generate.textContent = missing ? `Générer les ${missing} manquantes` : 'Toutes illustrées';
        generate.disabled = !missing;
    }

    /* Le son se coupe et se retient : une LAN se joue souvent en vocal, et un
       booster qui claque dans le micro de tout le monde n'amuse personne. */
    document.getElementById('reveal-mute')?.addEventListener('click', () => {
        const on = Sfx.toggle();
        const button = document.getElementById('reveal-mute');
        button.textContent = on ? '🔊' : '🔇';
        button.setAttribute('aria-label', on ? 'Couper le son' : 'Remettre le son');
    });

    document.getElementById('signature-art-close')?.addEventListener('click', () => {
        document.getElementById('signature-art-modal').style.display = 'none';
        renderCollection();
    });

    /* Une photo pèse plusieurs mégaoctets : on la redimensionne avant de
       l'envoyer. La fenêtre d'illustration d'une carte fait 300 px de large au
       plus, donc 1024 px suffisent, et les règles refusent au-delà de 4 Mo. */
    const ART_MAX_WIDTH = 1024;

    function shrinkImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('Fichier illisible'));
            reader.onload = () => {
                const image = new Image();
                image.onerror = () => reject(new Error('Image illisible'));
                image.onload = () => {
                    const scale = Math.min(1, ART_MAX_WIDTH / (image.width || ART_MAX_WIDTH));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(image.width * scale);
                    canvas.height = Math.round(image.height * scale);
                    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', 0.85));
                };
                image.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    /* Une illustration importée, qu'il s'agisse d'une carte ou de l'emballage :
       même stockage, même redimensionnement, même clé de nommage. */
    function importArt(key, label, file) {
        return shrinkImage(file)
            .then(dataUrl => db.ref('lan/cardArt/' + key).set({
                data: dataUrl,
                name: label || generatedArtNames[key] || '',
                by: auth.currentUser ? auth.currentUser.uid : null,
                ts: firebase.database.ServerValue.TIMESTAMP
            }).then(() => {
                generatedArt[key] = dataUrl;
                generatedArtNames[key] = label || generatedArtNames[key] || '';
                showToast('Illustration importée.', 'success');
            }))
            .catch(err => showToast(tcgWriteError(err), 'error'));
    }

    function importCardArt(card, file) {
        return importArt(card.gameKey, card.name, file);
    }

    document.getElementById('btn-mint-set')?.addEventListener('click', () => mintSet(false));
    document.getElementById('btn-remint-set')?.addEventListener('click', () => mintSet(true));

    /* Débogage : en attendant la boutique, le maître du jeu ouvre autant de
       boosters qu'il veut. Le paquet est scellé puis ouvert dans la foulée —
       même chemin qu'un booster acheté, même sceau serveur, même tirage. */
    document.getElementById('btn-debug-pack')?.addEventListener('click', () => {
        const user = auth.currentUser;
        const setId = tcgCurrentSetId(globalTcg);
        if (!user) return;
        if (!setId) { showToast('Crée d\'abord le set de la LAN.', 'error'); return; }

        const ref = db.ref('lan/tcg/packs').push();
        ref.set({
            uid: user.uid,
            setId: setId,
            status: 'sealed',
            sealedAt: firebase.database.ServerValue.TIMESTAMP,
            origin: 'debug'
            // Pas de `label` : l'emballage porte le nom de la soirée, pas celui
            // du bouton qui l'a créé. Personne n'ouvre un « booster de test ».
        })
            .then(() => ref.once('value'))
            .then(snapshot => {
                const pack = snapshot.val();
                if (pack) openPack(Object.assign({ id: ref.key }, pack));
            })
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    });

    document.getElementById('btn-gift-pack')?.addEventListener('click', () => {
        const uid = document.getElementById('tcg-gift-user').value;
        const setId = tcgCurrentSetId(globalTcg);
        if (!uid) { showToast('Choisis un joueur.', 'error'); return; }
        if (!setId) { showToast('Crée d\'abord le set de la LAN.', 'error'); return; }

        db.ref('lan/tcg/packs').push().set({
            uid: uid,
            setId: setId,
            status: 'sealed',
            sealedAt: firebase.database.ServerValue.TIMESTAMP,
            origin: 'gift'
        })
            .then(() => showToast(`Booster offert à ${playerLabel(uid)} !`, 'success'))
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    });

    /* --- Sceller ce qui a été acheté --------------------------------------
       Une demande de booster validée donne droit à un paquet dont
       l'identifiant EST celui de la demande : un achat ne peut donc pas donner
       deux paquets, même à un client bricolé. Le sceau, lui, est l'horodatage
       du serveur — c'est lui seul qui décide du contenu. */
    let sealingPack = false;
    // Un sceau refusé (règle, set changé, autre appareil plus rapide) ne se
    // retente pas en boucle : on l'oublie jusqu'au prochain chargement.
    const sealFailures = new Set();
    /* Les achats faits dans cette session ont déjà dit ce qu'il fallait dire au
       moment du clic. Les sceller ne doit pas produire un second message :
       acheter cinq boosters donnait dix bulles à la suite. Un paquet qui arrive
       SANS avoir été acheté ici — depuis le téléphone, ou offert — mérite au
       contraire d'être annoncé. */
    const sealedQuietly = new Set();

    function sealBoughtPacks() {
        const user = auth.currentUser;
        const setId = tcgCurrentSetId(globalTcg);
        if (!user || !setId || sealingPack) return;

        const waiting = unsealedPurchases(globalEconomy, globalTcg, user.uid)
            .filter(purchase => !sealFailures.has(purchase.id));
        if (!waiting.length) return;

        sealingPack = true;
        const purchase = waiting[0];
        const quiet = sealedQuietly.has(purchase.id);
        db.ref('lan/tcg/packs/' + purchase.id).set({
            uid: user.uid,
            setId: setId,
            status: 'sealed',
            sealedAt: firebase.database.ServerValue.TIMESTAMP,
            origin: 'shop',
            label: purchase.itemName || 'Booster'
        })
            .then(() => { if (!quiet) showToast('Un booster vous attend !', 'success'); })
            .catch(() => { sealFailures.add(purchase.id); })
            .finally(() => {
                sealingPack = false;
                sealedQuietly.delete(purchase.id);
                // On enchaîne : trois boosters achetés d'affilée doivent donner
                // trois paquets, pas un seul.
                sealBoughtPacks();
            });
    }

    /* --- Mes paquets ------------------------------------------------------ */

    function renderMyPacks(view) {
        const panel = document.getElementById('tcg-packs-panel');
        const mount = document.getElementById('tcg-packs');
        if (!panel) return;

        const sealed = sealedPacksOf(globalTcg, view.uid);
        const waiting = unsealedPurchases(globalEconomy, globalTcg, view.uid).length;
        if (!sealed.length && !waiting) { panel.style.display = 'none'; return; }

        panel.style.display = 'block';
        mount.innerHTML = '';
        sealed.forEach(pack => {
            const row = document.createElement('div');
            row.className = 'shop-card shop-card--pack';
            row.innerHTML = `
                <div class="shop-card__head">
                    <h4 class="shop-card__name">${escapeHtml(pack.label || packLabel({ name: generatedArtNames[PACK_ART_KEY] }, globalSettings.lanName))}</h4>
                    <span class="shop-card__price">${TCG.PACK_SIZE} cartes</span>
                </div>
                <p class="shop-card__meta">Scellé le ${escapeHtml(new Date(pack.sealedAt).toLocaleString('fr-FR'))}. Personne ne sait encore ce qu'il y a dedans.</p>
            `;
            const open = document.createElement('button');
            open.className = 'gold-btn';
            open.style.padding = '8px 18px';
            open.textContent = 'Ouvrir';
            open.addEventListener('click', () => openPack(pack));
            const actions = document.createElement('div');
            actions.className = 'shop-card__actions';
            actions.appendChild(open);
            row.appendChild(actions);
            mount.appendChild(row);
        });

        if (waiting) {
            const note = document.createElement('p');
            note.className = 'shop-card__meta';
            note.textContent = `${waiting} booster${waiting > 1 ? 's' : ''} en cours de scellage…`;
            mount.appendChild(note);
        }
    }

    /* --- L'ouverture ------------------------------------------------------ */

    let revealQueue = [];
    let revealDone = [];
    // Ce que le joueur possédait AVANT d'ouvrir : c'est ce qui distingue une
    // nouvelle carte d'un double. Relevé avant l'écriture, parce qu'aussitôt
    // le paquet marqué ouvert, le rejeu compte déjà ses cartes comme acquises.
    let revealOwned = new Set();
    let openingPack = false;

    function openPack(pack) {
        if (openingPack) return;
        openingPack = true;

        const view = tcgView();
        const setCards = tcgSetCards(globalTcg, pack.setId);
        const due = pityCount(globalTcg, pack.uid) >= TCG.PITY;

        if (!Object.keys(setCards).length) {
            openingPack = false;
            showToast('Ce booster appartient à un set introuvable.', 'error');
            return;
        }

        const ownedBefore = new Set(view.cards
            .filter(card => card.owner === pack.uid)
            .map(card => card.gameKey));

        /* Le tirage vient APRÈS l'écriture, et relit le nœud : depuis que la
           graine contient `openedAt`, elle n'existe qu'une fois l'horodatage
           posé par le serveur. Tirer avant donnerait à celui qui ouvre des
           cartes que personne d'autre ne recalculerait. */
        const packRef = db.ref('lan/tcg/packs/' + pack.id);
        packRef.update({
            status: 'opened',
            openedAt: firebase.database.ServerValue.TIMESTAMP
        })
            .then(() => packRef.once('value'))
            .then(snapshot => {
                const opened = Object.assign({}, pack, snapshot.val() || {});
                const drawn = drawPack(setCards, packSeed(pack.id, opened), { pity: due });
                if (!drawn.length) throw new Error('Ce booster appartient à un set introuvable.');
                return startReveal(pack, drawn.map(card => Object.assign({}, card, {
                    name: (setCards[card.gameKey] && setCards[card.gameKey].name) || card.gameKey,
                    owner: pack.uid,
                    mintedBy: pack.uid,
                    mintedAt: Date.now(),
                    lineage: [pack.uid]
                })), ownedBefore);
            })
            .catch(err => showToast('Erreur : ' + err.message, 'error'))
            .finally(() => { openingPack = false; });
    }

    /* L'ouverture se joue en trois temps : le paquet scellé qu'on déchire, les
       cartes une à une, puis la planche complète. Du plus commun au plus rare,
       et le brillant en dernier à rareté égale — la tension doit monter,
       jamais retomber. */
    let revealPhase = 'pack';   // 'pack' → 'cards' → 'spread'
    let revealFlipping = false;
    /* Un clic arrivé pendant le demi-tour n'est pas perdu, il est mis de côté :
       quatorze cartes s'enchaînent au rythme du joueur, pas à celui de
       l'animation. */
    let revealPending = false;

    function startReveal(pack, cards, ownedBefore) {
        revealQueue = cards.slice().sort((a, b) =>
            rarityIndex(b.rarity) - rarityIndex(a.rarity)
            || (a.foil ? 1 : 0) - (b.foil ? 1 : 0));
        revealDone = [];
        revealOwned = ownedBefore;
        revealPhase = 'pack';
        revealFlipping = false;
        revealPending = false;

        document.getElementById('reveal-seal').textContent =
            `Sceau ${new Date(pack.sealedAt).toLocaleTimeString('fr-FR')}`;
        /* Le nom et l'illustration du booster ne viennent pas du paquet mais de
           la soirée : un paquet créé pour un test ne doit pas s'appeler
           « test » aux yeux de celui qui l'ouvre. */
        const packArt = generatedArt[PACK_ART_KEY];
        document.getElementById('reveal-packname').textContent =
            packLabel({ name: generatedArtNames[PACK_ART_KEY] }, globalSettings.lanName);
        document.getElementById('reveal-wrap').classList.toggle('has-art', !!packArt);
        if (packArt) document.getElementById('reveal-packart').src = packArt;
        document.getElementById('reveal-mute').textContent = Sfx.isEnabled() ? '🔊' : '🔇';
        document.getElementById('reveal-flip').innerHTML = '';
        document.getElementById('reveal-spread').className = 'reveal-spread';
        document.getElementById('reveal-spread').innerHTML = '';
        document.getElementById('reveal-sparks').innerHTML = '';
        document.getElementById('reveal-pack').className = 'reveal-pack';
        document.getElementById('reveal-wrap').style.setProperty('--cut', '0');
        document.getElementById('reveal-hint').textContent = CUT_HINT;
        cutFrom = null;
        cutReached = 0;

        const overlay = document.getElementById('pack-reveal-overlay');
        overlay.className = 'reveal-overlay is-pack';
        overlay.style.display = 'flex';
        paintRevealFoot();
    }

    /* Les pastilles disent où on en est sans qu'on ait à lire un compteur, et
       se colorent à la rareté déjà sortie : la planche se dessine au fur et à
       mesure. */
    function paintRevealFoot() {
        const dots = document.getElementById('reveal-dots');
        const next = document.getElementById('reveal-next');
        const all = document.getElementById('reveal-all');
        dots.innerHTML = '';

        if (revealPhase !== 'cards') {
            all.style.display = 'none';
            next.textContent = revealPhase === 'pack' ? 'Ouvrir' : 'Ranger dans ma collection';
            return;
        }

        revealDone.concat(revealQueue).forEach((card, i) => {
            const dot = document.createElement('span');
            dot.className = i < revealDone.length
                ? `reveal-dot is-done is-${card.rarity}` : 'reveal-dot';
            dots.appendChild(dot);
        });
        all.style.display = revealQueue.length > 1 ? 'inline-block' : 'none';
        next.textContent = revealQueue.length ? 'Carte suivante' : 'Voir le paquet';
    }

    /* Le retournement, sans preserve-3d : la carte pivote jusqu'à la tranche,
       son contenu est échangé à mi-parcours, puis elle revient. Deux animations
       plates valent mieux qu'une scène 3D, qui se brouille avec les modes de
       fusion du brillant. */
    /* Ce que chaque rareté déclenche à la révélation. Tout ne secoue pas
       l'écran : si la commune fait le même bruit que la prestige, plus rien ne
       compte. */
    const RARITY_FX = {
        signature: { sparks: 30, rays: true, shake: true, flash: true },
        common: { sparks: 0, rays: false, shake: false, flash: false },
        uncommon: { sparks: 0, rays: false, shake: false, flash: false },
        rare: { sparks: 8, rays: false, shake: false, flash: false },
        epic: { sparks: 14, rays: true, shake: true, flash: true },
        showcase: { sparks: 22, rays: true, shake: true, flash: true }
    };

    const SPARK_COLORS = { rare: '#b79dff', epic: '#e6a2ff', showcase: '#ffd76a', signature: '#ffb066' };

    /* Les éclats qui giclent du centre. Ils partent en couronne, avec assez de
       désordre pour ne pas ressembler à une horloge. */
    function fireSparks(rarity, count) {
        const box = document.getElementById('reveal-sparks');
        box.innerHTML = '';
        if (!count || REDUCED_MOTION) return;

        const color = SPARK_COLORS[rarity] || '#ffd76a';
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
            const distance = 140 + Math.random() * 190;
            const spark = document.createElement('span');
            spark.className = 'reveal-spark';
            spark.style.setProperty('--sx', `${Math.cos(angle) * distance}px`);
            spark.style.setProperty('--sy', `${Math.sin(angle) * distance}px`);
            spark.style.setProperty('--spark', color);
            spark.style.animationDelay = `${Math.random() * 90}ms`;
            box.appendChild(spark);
        }
        setTimeout(() => { box.innerHTML = ''; }, 1100);
    }

    function flipToCard(card, isNew) {
        const flip = document.getElementById('reveal-flip');
        const burst = document.getElementById('reveal-burst');
        const rays = document.getElementById('reveal-rays');
        const overlay = document.getElementById('pack-reveal-overlay');
        const fx = RARITY_FX[card.rarity] || RARITY_FX.common;

        revealFlipping = true;
        Sfx.flip();
        flip.className = 'reveal-flip is-out';

        setTimeout(() => {
            const node = buildCard(card, { badge: isNew ? 'NOUVELLE' : 'double' });
            node.classList.add('tcard--reveal');
            flip.innerHTML = '';
            flip.appendChild(node);
            // Le retour est d'autant plus ample que la carte est rare.
            flip.className = `reveal-flip is-in is-${card.rarity}`;

            // L'éclat derrière la carte porte la couleur de sa rareté : on sait
            // ce qu'on a sorti avant même d'avoir lu le nom.
            burst.className = `reveal-burst is-firing is-${card.rarity}`;
            void burst.offsetWidth;

            rays.className = fx.rays ? `reveal-rays is-firing is-${card.rarity}` : 'reveal-rays';
            if (fx.rays) void rays.offsetWidth;

            fireSparks(card.rarity, fx.sparks);
            Sfx.reveal(card.rarity);

            overlay.classList.remove('is-shake', 'is-flash', 'is-flash-epic', 'is-flash-showcase');
            void overlay.offsetWidth;
            if (fx.shake && !REDUCED_MOTION) overlay.classList.add('is-shake');
            if (fx.flash && !REDUCED_MOTION) overlay.classList.add('is-flash', `is-flash-${card.rarity}`);

            /* Rendu dès que la carte est posée, sans attendre la fin du
               retour : quatorze cartes, ça s'enchaîne vite, et un verrou d'une
               demi-seconde avalerait un clic sur deux. Seul le demi-tour aller
               est protégé, parce que c'est là que le contenu s'échange. */
            revealFlipping = false;
            if (revealPending) { revealPending = false; revealNextCard(); }
        }, 170);
    }

    function revealNextCard() {
        if (!revealQueue.length) return;
        if (revealFlipping) { revealPending = true; return; }
        const card = revealQueue.shift();
        const isNew = !revealOwned.has(card.gameKey);
        revealOwned.add(card.gameKey);
        revealDone.push(card);
        flipToCard(card, isNew);

        if (rarityIndex(card.rarity) <= rarityIndex('epic')) {
            showToast(`${rarityMeta(card.rarity).label} ! ${card.name}`, 'success');
        }
        paintRevealFoot();
    }

    /* La planche : les quatorze cartes d'un coup d'œil, dans l'ordre où on les
       a sorties, avec ce que le paquet a vraiment apporté. */
    function showRevealSpread() {
        revealPhase = 'spread';
        const spread = document.getElementById('reveal-spread');
        spread.innerHTML = '';

        const fresh = revealDone.filter((card, i) =>
            revealDone.findIndex(other => other.gameKey === card.gameKey) === i).length;

        revealDone.forEach((card, i) => {
            const node = buildCard(card, { onClick: () => openCardModal(card) });
            node.style.animationDelay = `${i * 35}ms`;
            // Chaque carte se pose de travers, d'un côté ou de l'autre : une
            // main qui étale des cartes ne les aligne pas au millimètre.
            node.style.setProperty('--deal-tilt', `${(i % 2 ? 1 : -1) * (3 + (i % 3))}deg`);
            node.classList.add('tcard--dealt');
            spread.appendChild(node);
        });

        const best = revealDone.slice().sort((a, b) => rarityIndex(a.rarity) - rarityIndex(b.rarity))[0];
        document.getElementById('reveal-seal').textContent =
            `${revealDone.length} cartes · ${fresh} jeu${fresh > 1 ? 'x' : ''} différent${fresh > 1 ? 's' : ''}`
            + (best ? ` · meilleure : ${rarityMeta(best.rarity).label}` : '');

        document.getElementById('pack-reveal-overlay').className = 'reveal-overlay is-spread';
        paintRevealFoot();
    }

    /* « Ranger dans ma collection » ne fait pas que fermer : les quatorze
       cartes se rassemblent pour de bon. Chacune file vers le bas de l'écran en
       tournant, d'après sa position réelle — c'est le geste de ramasser un
       paquet étalé sur la table. */
    function gatherAndClose() {
        const spread = document.getElementById('reveal-spread');
        const cards = Array.from(spread.querySelectorAll('.tcard'));

        if (REDUCED_MOTION || !cards.length) { closeReveal(); return; }

        const target = { x: window.innerWidth / 2, y: window.innerHeight - 60 };
        cards.forEach((card, i) => {
            const box = card.getBoundingClientRect();
            card.style.setProperty('--gx', `${Math.round(target.x - (box.left + box.width / 2))}px`);
            card.style.setProperty('--gy', `${Math.round(target.y - (box.top + box.height / 2))}px`);
            card.style.setProperty('--gr', `${(i % 2 ? 1 : -1) * (8 + i * 2)}deg`);
            // Les dernières partent en premier : la pile se referme du bas.
            card.style.animationDelay = `${(cards.length - i) * 14}ms`;
        });

        spread.classList.add('is-gathering');
        Sfx.gather();
        setTimeout(closeReveal, 420 + cards.length * 14);
    }

    function closeReveal() {
        const overlay = document.getElementById('pack-reveal-overlay');
        overlay.className = 'reveal-overlay';
        overlay.style.display = 'none';
        document.getElementById('reveal-flip').innerHTML = '';
        document.getElementById('reveal-spread').className = 'reveal-spread';
        document.getElementById('reveal-spread').innerHTML = '';
        document.getElementById('reveal-sparks').innerHTML = '';
        revealQueue = [];
        revealDone = [];
        renderCollection();
    }

    /* Déchirer le paquet : on peut tirer la souris vers le bas (la fente suit,
       et au-delà de la moitié le paquet cède) ou simplement cliquer. */
    function tearPack() {
        if (revealPhase !== 'pack') return;
        revealPhase = 'cards';
        const pack = document.getElementById('reveal-pack');
        pack.classList.remove('is-tearing');
        pack.classList.add('is-torn');
        // L'entaille file jusqu'au bord : c'est elle qui déclenche tout le reste.
        setCut(1);
        Sfx.packOpen();
        paintRevealFoot();

        /* Le paquet reste à l'écran le temps de s'ouvrir en entier — la bande
           s'envole, la lumière explose, les cartes montent. Basculer tout de
           suite sur la scène des cartes masquerait le seul moment où l'on voit
           le paquet céder, c'est-à-dire tout l'intérêt du geste. */
        setTimeout(() => {
            document.getElementById('pack-reveal-overlay').className = 'reveal-overlay is-cards';
            revealNextCard();
        }, 560);
    }

    /* Un seul geste fait tout avancer : le paquet s'ouvre, les cartes défilent,
       la planche s'affiche, la collection se range. Le bouton, la scène et la
       barre d'espace font exactement la même chose, pour qu'on puisse enchaîner
       les boosters sans jamais viser.

       Le piège d'avant : la scène ne réagissait que s'il RESTAIT des cartes. Sur
       la dernière, cliquer ne faisait plus rien et il fallait aller chercher le
       bouton — on avançait quatorze fois d'un geste, puis on butait. */
    function advanceReveal() {
        if (revealPhase === 'pack') { tearPack(); return; }
        if (revealPhase === 'cards') {
            if (revealQueue.length) revealNextCard();
            else if (!revealFlipping) showRevealSpread();
            return;
        }
        gatherAndClose();
    }

    document.getElementById('reveal-next')?.addEventListener('click', advanceReveal);

    /* Espace et entrée avancent d'un cran, comme le bouton. C'est ce qui permet
       d'enchaîner dix boosters sans lâcher la main. Jamais pendant une saisie,
       et jamais sur un bouton — la barre d'espace y déclenche déjà le clic, et
       réagir en plus ferait sauter deux cartes. */
    document.addEventListener('keydown', (e) => {
        if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
        const scene = document.getElementById('reveal');
        if (!scene || !scene.classList.contains('is-open')) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
        e.preventDefault();
        advanceReveal();
    });

    /* Le tiré qui déchire. On mesure la course du pointeur sur la hauteur du
       paquet : la fente s'ouvre en proportion, et passé 55 % l'emballage cède.
       Un simple clic (course quasi nulle) ouvre aussi — il ne faut pas obliger
       quelqu'un à découvrir un geste pour ouvrir son booster. */
    /* Le glissement qui tranche. Le geste est LATÉRAL, comme sur un vrai
       paquet : on entaille la bande du haut d'un bord à l'autre. La course est
       mesurée une fois, au premier contact — relire la géométrie à chaque
       déplacement forcerait un recalcul de mise en page par pixel parcouru. */
    let cutFrom = null;
    let cutSpan = 0;
    let cutReached = 0;
    /* Le dernier cran sonore franchi. L'entaille craque par paliers plutôt qu'à
       chaque pixel : c'est ce qui lui donne son grain de fermeture éclair, et ça
       évite de lancer cinquante sons par glissement. */
    let cutHeard = 0;

    const CUT_HINT = 'Glisse en travers pour ouvrir';

    function setCut(value) {
        cutReached = value;
        document.getElementById('reveal-wrap').style.setProperty('--cut', value.toFixed(3));
    }

    document.getElementById('reveal-pack')?.addEventListener('pointerdown', (e) => {
        if (revealPhase !== 'pack') return;
        cutFrom = e.clientX;
        cutHeard = 0;
        // La largeur du paquet : trancher, c'est le traverser.
        cutSpan = Math.max(60, document.getElementById('reveal-wrap').getBoundingClientRect().width * 0.8);
        document.getElementById('reveal-pack').classList.add('is-tearing');
        // Premier contact : c'est le geste qui autorise le son.
        Sfx.wake();
    });

    document.getElementById('reveal-pack')?.addEventListener('pointermove', (e) => {
        if (cutFrom === null) return;
        // La valeur absolue : on tranche de gauche à droite ou l'inverse.
        const progress = Math.max(0, Math.min(1, Math.abs(e.clientX - cutFrom) / cutSpan));
        setCut(progress);
        if (progress - cutHeard >= 0.07) { cutHeard = progress; Sfx.cut(progress); }
        document.getElementById('reveal-hint').textContent = progress > 0.25 ? 'Encore…' : CUT_HINT;
        if (progress >= 0.75) { cutFrom = null; tearPack(); }
    }, { passive: true });

    document.getElementById('reveal-pack')?.addEventListener('pointerup', () => {
        if (cutFrom === null) return;
        cutFrom = null;
        // Course trop courte : c'était un simple clic, on ouvre quand même.
        if (cutReached < 0.12) { tearPack(); return; }
        // Relâché à mi-chemin : l'entaille se referme.
        document.getElementById('reveal-pack').classList.remove('is-tearing');
        setCut(0);
        document.getElementById('reveal-hint').textContent = CUT_HINT;
    });

    document.getElementById('reveal-pack')?.addEventListener('pointercancel', () => {
        cutFrom = null;
        document.getElementById('reveal-pack').classList.remove('is-tearing');
        setCut(0);
    });

    /* Le paquet entier d'un coup, pour qui a déjà ouvert dix boosters. */
    document.getElementById('reveal-all')?.addEventListener('click', () => {
        while (revealQueue.length) {
            const card = revealQueue.shift();
            revealOwned.add(card.gameKey);
            revealDone.push(card);
        }
        revealFlipping = false;
        revealPending = false;
        showRevealSpread();
    });

    // Cliquer la scène avance aussi : on ne vise pas un bouton quatorze fois.
    document.getElementById('reveal-stage')?.addEventListener('click', advanceReveal);
    document.getElementById('reveal-pack')?.addEventListener('click', () => {
        if (revealPhase === 'pack') document.getElementById('reveal-next').click();
    });

    /* --- La grille du set ------------------------------------------------- */

    let tcgFilter = 'all';
    /* Les raretés dépliées. Les deux plus gros groupes restent fermés : personne
       ne veut faire défiler trois cents silhouettes pour trouver ses Signature. */
    const openRarities = new Set(['signature', 'showcase', 'epic', 'rare']);
    const TCG_FILTERS = [
        { key: 'all', label: 'Tout le set' },
        { key: 'missing', label: 'Ce qui manque' },
        { key: 'owned', label: 'Ce que j\'ai' }
    ];

    function renderSetGrid(view) {
        const filters = document.getElementById('tcg-filters');
        const mount = document.getElementById('tcg-set-grid');
        if (!mount) return;

        filters.innerHTML = '';
        TCG_FILTERS.forEach(filter => {
            const btn = document.createElement('button');
            btn.className = tcgFilter === filter.key ? 'filter-chip active' : 'filter-chip';
            btn.textContent = filter.label;
            btn.addEventListener('click', () => { tcgFilter = filter.key; renderSetGrid(view); });
            filters.appendChild(btn);
        });

        mount.innerHTML = '';
        if (!view.set) {
            mount.innerHTML = '<p class="tcg-empty">Le set de la LAN n\'a pas encore été créé.</p>';
            return;
        }

        const rows = collectionBySet(view.setCards, view.cards, view.uid)
            .filter(row => tcgFilter === 'all'
                || (tcgFilter === 'missing' && !row.owned)
                || (tcgFilter === 'owned' && row.owned));

        if (!rows.length) {
            mount.innerHTML = tcgFilter === 'missing'
                ? '<p class="tcg-empty">Rien ne manque. Set complet.</p>'
                : '<p class="tcg-empty">Aucune carte pour l\'instant. Un booster, et ça commence.</p>';
            return;
        }

        /* Rangé par rareté. Cinq cents cartes à plat, c'est un annuaire : on ne
           voit ni où on en est, ni ce qui vaut la peine. Groupé, chaque rareté
           annonce sa complétion et les cartes de chasse sont en tête, là où on
           les cherche. Les deux plus gros groupes restent repliés. */
        TCG.RARITIES.forEach(rarity => {
            const group = rows.filter(row => row.rarity === rarity.key);
            if (!group.length) return;

            const owned = group.filter(row => row.owned).length;
            const head = document.createElement('button');
            head.className = `rarity-bar rarity-bar--${rarity.key}`;
            head.innerHTML = `
                <span class="rarity-bar__gem"></span>
                <span class="rarity-bar__label">${escapeHtml(rarity.label)}</span>
                <span class="rarity-bar__count">${owned} / ${group.length}</span>
                <span class="rarity-bar__chev">${openRarities.has(rarity.key) ? '▾' : '▸'}</span>
            `;
            head.addEventListener('click', () => {
                if (openRarities.has(rarity.key)) openRarities.delete(rarity.key);
                else openRarities.add(rarity.key);
                renderSetGrid(view);
            });
            mount.appendChild(head);

            if (!openRarities.has(rarity.key)) return;

            const grid = document.createElement('div');
            grid.className = 'card-grid';
            group.forEach(row => appendSetCard(grid, row));
            mount.appendChild(grid);
        });
    }

    function appendSetCard(grid, row) {
        const best = row.copies.find(copy => copy.foil) || row.copies[0];
        /* La silhouette d'une carte manquante porte quand même son appId :
           sans lui, elle n'aurait aucune illustration à griser. */
        const card = best || {
            gameKey: row.gameKey, name: row.name, rarity: row.rarity,
            appId: row.appId, foil: false
        };
        grid.appendChild(buildCard(card, {
            missing: !row.owned,
            badge: row.copies.length > 1 ? `×${row.copies.length}` : '',
            onClick: () => (best
                ? openCardModal(best)
                : showToast(`${row.name} — pas encore dans ta collection.`, 'error'))
        }));
    }

    /* --- Les doubles ------------------------------------------------------ */

    function renderDupes(view) {
        const panel = document.getElementById('tcg-dupes-panel');
        const mount = document.getElementById('tcg-dupes');
        if (!panel) return;

        const dupes = duplicatesOf(view.cards, view.uid);
        if (!dupes.length) { panel.style.display = 'none'; return; }
        panel.style.display = 'block';
        mount.innerHTML = '';
        dupes.forEach(card => mount.appendChild(buildCard(card, { onClick: () => openCardModal(card) })));
    }

    /* --- Les échanges -----------------------------------------------------
       Rien n'est vérifié à l'écriture : les règles Firebase ne savent pas dire
       qui possède quoi. C'est le rejeu qui tranche, et un échange malhonnête
       n'est pas refusé — il est sans effet, à la vue de tous. */

    let tradeTarget = '';
    const tradeOffer = new Set();
    const tradeRequest = new Set();

    document.getElementById('btn-new-trade')?.addEventListener('click', () => {
        const view = tcgView();
        const others = economyPlayers().filter(uid => uid !== view.uid
            && view.cards.some(card => card.owner === uid));
        if (!others.length) { showToast('Personne d\'autre n\'a encore de cartes.', 'error'); return; }

        tradeOffer.clear();
        tradeRequest.clear();
        tradeTarget = others[0];

        const select = document.getElementById('trade-target');
        select.innerHTML = '';
        others.forEach(uid => {
            const option = document.createElement('option');
            option.value = uid;
            option.textContent = playerLabel(uid);
            select.appendChild(option);
        });
        select.value = tradeTarget;

        document.getElementById('trade-modal').style.display = 'flex';
        paintTradePickers();
    });

    document.getElementById('trade-target')?.addEventListener('change', (e) => {
        tradeTarget = e.target.value;
        tradeRequest.clear();
        paintTradePickers();
    });

    function paintTradePickers() {
        const view = tcgView();
        const mine = document.getElementById('trade-mine');
        const theirs = document.getElementById('trade-theirs');
        mine.innerHTML = '';
        theirs.innerHTML = '';

        // Les doubles d'abord : c'est le surplus qu'on troque, pas la pièce
        // du souvenir.
        const dupes = duplicatesOf(view.cards, view.uid);
        const dupeIds = new Set(dupes.map(card => card.id));
        const ordered = dupes.concat(collectionOf(view.cards, view.uid).filter(card => !dupeIds.has(card.id)));

        if (!ordered.length) mine.innerHTML = '<p class="tcg-empty">Tu n\'as aucune carte à offrir.</p>';
        ordered.forEach(card => mine.appendChild(buildCard(card, {
            selected: tradeOffer.has(card.id),
            badge: dupeIds.has(card.id) ? 'double' : '',
            onClick: () => { toggleTradePick(tradeOffer, card.id); paintTradePickers(); }
        })));

        const theirCards = collectionOf(view.cards, tradeTarget);
        if (!theirCards.length) theirs.innerHTML = '<p class="tcg-empty">Ce joueur n\'a aucune carte.</p>';
        theirCards.forEach(card => theirs.appendChild(buildCard(card, {
            selected: tradeRequest.has(card.id),
            onClick: () => { toggleTradePick(tradeRequest, card.id); paintTradePickers(); }
        })));

        const send = document.getElementById('trade-send');
        send.disabled = !tradeOffer.size && !tradeRequest.size;
        send.textContent = (tradeOffer.size || tradeRequest.size)
            ? `Proposer ${tradeOffer.size} contre ${tradeRequest.size}`
            : 'Choisis au moins une carte';
    }

    function toggleTradePick(set, id) {
        if (set.has(id)) { set.delete(id); return; }
        if (set.size >= TCG.TRADE_MAX) {
            showToast(`${TCG.TRADE_MAX} cartes par côté, pas plus.`, 'error');
            return;
        }
        set.add(id);
    }

    document.getElementById('trade-cancel')?.addEventListener('click', () => {
        document.getElementById('trade-modal').style.display = 'none';
    });

    document.getElementById('trade-send')?.addEventListener('click', () => {
        const user = auth.currentUser;
        if (!user || !tradeTarget) return;
        db.ref('lan/tcg/trades').push().set({
            fromUid: user.uid,
            fromName: user.displayName || 'Un joueur',
            toUid: tradeTarget,
            toName: playerLabel(tradeTarget),
            offer: serializeCardList(Array.from(tradeOffer)),
            request: serializeCardList(Array.from(tradeRequest)),
            status: 'pending',
            ts: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            document.getElementById('trade-modal').style.display = 'none';
            showToast(`Proposition envoyée à ${playerLabel(tradeTarget)}.`, 'success');
        }).catch(err => showToast('Erreur : ' + err.message, 'error'));
    });

    function resolveTrade(trade, status) {
        db.ref('lan/tcg/trades/' + trade.id).update({
            status: status,
            resolvedAt: firebase.database.ServerValue.TIMESTAMP
        })
            .then(() => showToast(status === 'accepted' ? 'Échange conclu !' : 'C\'est noté.', 'success'))
            .catch(err => showToast('Erreur : ' + err.message, 'error'));
    }

    function buildTradeRow(trade, view, mine) {
        const byId = new Map(view.cards.map(card => [card.id, card]));
        const row = document.createElement('div');
        row.className = 'trade-row';
        row.innerHTML = `
            <div class="shop-card__head">
                <h4 class="shop-card__name">${escapeHtml(mine ? 'À ' + playerLabel(trade.toUid) : 'De ' + playerLabel(trade.fromUid))}</h4>
                <span class="shop-card__meta">${escapeHtml(timeSince(trade.ts))}</span>
            </div>
        `;

        const side = (label, ids) => {
            const title = document.createElement('p');
            title.className = 'shop-cat-title';
            title.textContent = label;
            row.appendChild(title);
            const grid = document.createElement('div');
            grid.className = 'card-grid card-grid--sm';
            if (!ids.length) grid.innerHTML = '<p class="tcg-empty">Rien</p>';
            ids.forEach(id => {
                const card = byId.get(id);
                if (card) grid.appendChild(buildCard(card, { onClick: () => openCardModal(card) }));
                else grid.insertAdjacentHTML('beforeend', '<p class="tcg-empty">Carte introuvable</p>');
            });
            row.appendChild(grid);
        };

        side(mine ? 'Je donne' : `${playerLabel(trade.fromUid)} donne`, trade.offer);
        side(mine ? 'Je demande' : 'En échange de', trade.request);

        if (!tradeStillValid(view.cards, trade)) {
            const warn = document.createElement('p');
            warn.className = 'shop-request__warn';
            warn.textContent = '⚠️ Caduque : une des cartes a changé de mains depuis. L\'accepter n\'aurait aucun effet.';
            row.appendChild(warn);
        }
        return row;
    }

    function renderTradesIn(view) {
        const panel = document.getElementById('tcg-trade-in-panel');
        const mount = document.getElementById('tcg-trade-in');
        if (!panel) return;

        const trades = pendingTradesFor(globalTcg, view.uid);
        if (!trades.length) { panel.style.display = 'none'; return; }
        panel.style.display = 'block';
        mount.innerHTML = '';

        trades.forEach(trade => {
            const row = buildTradeRow(trade, view, false);
            const actions = document.createElement('div');
            actions.className = 'shop-card__actions';

            const accept = document.createElement('button');
            accept.className = 'gold-btn';
            accept.style.padding = '8px 18px';
            accept.textContent = 'Accepter';
            accept.disabled = !tradeStillValid(view.cards, trade);
            accept.addEventListener('click', () => resolveTrade(trade, 'accepted'));
            actions.appendChild(accept);

            const decline = document.createElement('button');
            decline.className = 'gold-link-btn';
            decline.textContent = 'Refuser';
            decline.addEventListener('click', () => resolveTrade(trade, 'declined'));
            actions.appendChild(decline);

            row.appendChild(actions);
            mount.appendChild(row);
        });
    }

    function renderTradesOut(view) {
        const panel = document.getElementById('tcg-trade-out-panel');
        const mount = document.getElementById('tcg-trade-out');
        if (!panel) return;

        const trades = pendingTradesFrom(globalTcg, view.uid);
        if (!trades.length) { panel.style.display = 'none'; return; }
        panel.style.display = 'block';
        mount.innerHTML = '';

        trades.forEach(trade => {
            const row = buildTradeRow(trade, view, true);
            const cancel = document.createElement('button');
            cancel.className = 'gold-link-btn';
            cancel.textContent = 'Annuler la proposition';
            cancel.addEventListener('click', () => resolveTrade(trade, 'cancelled'));
            const actions = document.createElement('div');
            actions.className = 'shop-card__actions';
            actions.appendChild(cancel);
            row.appendChild(actions);
            mount.appendChild(row);
        });
    }

    function renderTcgLeaderboard(view) {
        const mount = document.getElementById('tcg-leaderboard');
        if (!mount) return;
        mount.innerHTML = '';

        const board = tcgLeaderboard(view.setCards, view.cards, economyPlayers());
        if (!board.length) {
            mount.innerHTML = '<p class="tcg-empty">Personne n\'a encore ouvert de booster.</p>';
            return;
        }
        board.slice(0, 10).forEach((entry, i) => {
            const row = document.createElement('div');
            row.className = `rank-row rank-row--${i + 1}`;
            row.innerHTML = `
                <span class="rank-row__pos">${i + 1}</span>
                <span class="rank-row__name">${escapeHtml(playerLabel(entry.uid))}</span>
                <span class="shop-card__price">${entry.owned}/${entry.total}${entry.foils ? ` ✦${entry.foils}` : ''}</span>
            `;
            mount.appendChild(row);
        });
    }

    function renderTradeFeed(view) {
        const mount = document.getElementById('tcg-trade-feed');
        if (!mount) return;
        mount.innerHTML = '';

        const feed = tcgTrades(globalTcg).filter(trade => trade.status !== 'pending').slice(0, 30);
        if (!feed.length) {
            mount.innerHTML = '<p class="tcg-empty">Aucun échange pour le moment.</p>';
            return;
        }
        const words = { accepted: 'conclu', declined: 'refusé', cancelled: 'annulé' };
        feed.forEach(trade => {
            // « Sans effet » se lit dans le rejeu, jamais dans l'état actuel :
            // une fois l'échange conclu les cartes ne sont plus chez leur
            // émetteur, et les recompter dirait le contraire de la vérité.
            const effective = view.applied.has(trade.id);
            const row = document.createElement('div');
            row.className = 'shop-move';
            row.innerHTML = `
                <span class="shop-move__text">${escapeHtml(playerLabel(trade.fromUid))} → ${escapeHtml(playerLabel(trade.toUid))}
                    <span class="shop-move__why">${trade.offer.length} contre ${trade.request.length} · ${escapeHtml(words[trade.status] || trade.status)}${trade.status === 'accepted' && !effective ? ' (sans effet)' : ''} · ${escapeHtml(timeSince(trade.resolvedAt || trade.ts))}</span>
                </span>
            `;
            mount.appendChild(row);
        });
    }
});
