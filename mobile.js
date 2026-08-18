/* ==========================================================================
   LAN Demain - interface téléphone
   Couche d'affichage autonome. Elle partage avec l'interface bureau
   la logique de comptage (core.js), les fonctions serverless (api/) et la
   base Firebase, mais aucun code d'affichage : les deux interfaces peuvent
   évoluer sans se casser mutuellement.
   ========================================================================== */

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();
const googleProvider = new firebase.auth.GoogleAuthProvider();

const state = {
    user: null,
    isAdmin: false,
    isMixologist: false,
    settings: { isVotingOpen: false, isLanActive: false, lanFinished: false, lanName: 'LAN Demain', topGamesCount: 10 },
    votes: {},
    roles: {},
    status: {},
    profiles: {},
    polls: {},
    foodRuns: {},
    events: {},
    cocktails: {},
    notifs: {},
    libraries: {},
    history: {},
    scores: [],
    ready: false
};

/* Brouillon de vote : le vote en cours de saisie vit ici et non dans la base,
   sinon la moindre mise à jour temps réel effacerait ce que le joueur tape. */
let voteDraft = null;
let currentScreen = 'soiree';
/* Notre entrée dans /status : une par session ouverte, pas une par joueur. */
let myConnectionRef = null;
/* La LAN terminée, on amène le joueur au bilan une seule fois : ensuite il
   navigue où il veut sans qu'on le ramène de force à chaque mise à jour. */
let recapShown = false;
const refs = [];

const PRIORITIES = [
    { key: 'p1', tag: 'P1', label: 'Mon jeu de la soirée', pts: '5 pts' },
    { key: 'p2', tag: 'P2', label: 'Très envie', pts: '3 pts' },
    { key: 'p3', tag: 'P3', label: 'Pourquoi pas', pts: '2 pts' },
    { key: 'p_other', tag: '+', label: 'Les autres', pts: '1 pt' }
];

const DEFAULT_THUMB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 54 33'%3E%3Crect width='54' height='33' fill='%231a1a1a'/%3E%3C/svg%3E";

/* ==========================================================================
   Petits utilitaires
   ========================================================================== */

const $ = (id) => document.getElementById(id);

function showToast(message, type = 'success') {
    const box = $('m-toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `m-toast ${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.classList.add('is-shown'), 10);
    setTimeout(() => {
        el.classList.remove('is-shown');
        el.addEventListener('transitionend', () => el.remove());
    }, 3600);
}

function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

/* Avatar de repli : une pastille avec l'initiale, teintée d'après le nom.
   Évite un aller-retour réseau quand un joueur n'a pas de photo Google. */
function fallbackAvatar(name) {
    const seed = (name || '?').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const hue = seed % 360;
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='hsl(${hue}%2C30%25%2C32%25)'/%3E%3Ctext x='20' y='27' font-family='Georgia' font-size='19' text-anchor='middle' fill='%23f4f0ec'%3E${initials(name)}%3C/text%3E%3C/svg%3E`;
}

function playerName(uid) {
    if (state.votes[uid] && state.votes[uid].name) return state.votes[uid].name;
    const identity = statusIdentity(state.status[uid]);
    if (identity && identity.name) return identity.name;
    if (state.profiles[uid] && state.profiles[uid].name) return state.profiles[uid].name;
    if (uid === (state.user && state.user.uid)) return state.user.displayName || 'Moi';
    return 'Un joueur';
}

function playerPhoto(uid) {
    const identity = statusIdentity(state.status[uid]);
    if (identity && (identity.photo || identity.avatar)) return identity.photo || identity.avatar;
    /* Fiche durable : elle survit à la déconnexion, contrairement à /status. */
    const profile = state.profiles[uid];
    if (profile && profile.avatar) return profile.avatar;
    if (uid === (state.user && state.user.uid) && state.user.photoURL) return state.user.photoURL;
    return fallbackAvatar(playerName(uid));
}

function money(value) {
    const n = Number(value) || 0;
    return n.toFixed(2).replace('.', ',') + ' €';
}

/* Compte à rebours lisible : on ne montre pas les secondes au-delà d'une
   minute, personne ne les regarde et ça ferait clignoter la page. */
function remaining(closesAt) {
    if (!closesAt) return null;
    const ms = closesAt - Date.now();
    if (ms <= 0) return null;
    const min = Math.floor(ms / 60000);
    if (min >= 60) {
        const h = Math.floor(min / 60);
        return `${h} h ${String(min % 60).padStart(2, '0')}`;
    }
    if (min >= 1) return `${min} min`;
    return `${Math.ceil(ms / 1000)} s`;
}

function timeAgo(ts) {
    if (!ts) return '';
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `il y a ${h} h`;
    return `il y a ${Math.floor(h / 24)} j`;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function emptyState(message) {
    return el('div', 'm-empty', message);
}

/* ==========================================================================
   Vignettes de jeux
   Même endpoint et même cache que l'interface bureau : un jeu déjà résolu
   sur PC s'affiche instantanément sur téléphone.
   ========================================================================== */

const thumbCache = new Map();
const thumbPending = new Map();
const THUMB_STORE = 'lan-demain:thumbs:v2';
const THUMB_TTL = 7 * 24 * 60 * 60 * 1000;

function loadThumbStore() {
    try {
        const raw = localStorage.getItem(THUMB_STORE);
        if (!raw) return;
        const data = JSON.parse(raw);
        const now = Date.now();
        Object.entries(data).forEach(([name, entry]) => {
            if (entry && entry.url && (now - entry.ts) < THUMB_TTL) thumbCache.set(name, entry.url);
        });
    } catch (error) {
        console.debug('Cache vignettes illisible:', error);
    }
}

let thumbStoreTimer = null;
function persistThumbStore() {
    clearTimeout(thumbStoreTimer);
    thumbStoreTimer = setTimeout(() => {
        try {
            const now = Date.now();
            const data = {};
            thumbCache.forEach((url, name) => { if (url) data[name] = { url, ts: now }; });
            localStorage.setItem(THUMB_STORE, JSON.stringify(data));
        } catch (error) {
            console.debug('Cache vignettes non enregistré:', error);
        }
    }, 500);
}

function thumbFor(gameName, imgEl) {
    const key = normalizeGameName(gameName);
    if (thumbCache.has(key)) {
        imgEl.src = thumbCache.get(key);
        return;
    }
    imgEl.src = DEFAULT_THUMB;
    if (thumbPending.has(key)) {
        thumbPending.get(key).then(url => { if (url) imgEl.src = url; });
        return;
    }
    const promise = fetch(`/api/get-game-image?name=${encodeURIComponent(key)}&v=2`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
            const url = data && data.imageUrl;
            if (url) {
                thumbCache.set(key, url);
                persistThumbStore();
                return url;
            }
            return null;
        })
        .catch(() => null);
    thumbPending.set(key, promise);
    promise.then(url => { if (url) imgEl.src = url; });
}

const detailsCache = new Map();
function gameDetails(gameName) {
    const key = normalizeGameName(gameName);
    if (detailsCache.has(key)) return detailsCache.get(key);
    const promise = fetch(`/api/game-details?name=${encodeURIComponent(key)}`)
        .then(res => (res.ok ? res.json() : null))
        .catch(() => null);
    detailsCache.set(key, promise);
    return promise;
}

/* ==========================================================================
   Navigation
   ========================================================================== */

const TABS = ['soiree', 'jeux', 'miam', 'sondages', 'plus'];

const SCREEN_TITLES = {
    vote: 'Mon vote',
    evenements: 'Événements',
    kocktails: 'Kocktails',
    biblio: 'Bibliothèques',
    historique: 'Historique',
    admin: 'Administration',
    bilan: 'Bilan de la soirée'
};

/* ==========================================================================
   Phases de la soirée
   On vote d'abord, on joue ensuite, on fait le bilan à la fin. Une
   fonctionnalité qui n'appartient pas à la phase en cours reste visible mais
   verrouillée : cachée, le joueur la croirait disparue.
   ========================================================================== */

function phase() {
    if (state.settings.lanFinished) return 'finished';
    if (state.settings.isLanActive) return 'lan';
    if (state.settings.isVotingOpen) return 'vote';
    return 'waiting';
}

/* Ce qui appartient à la soirée elle-même : sans LAN lancée, pas de commande
   groupée, pas de sondage, pas d'événement, pas de bar. */
const LAN_SCREENS = ['miam', 'sondages', 'evenements', 'kocktails'];

function screenAvailable(screen) {
    const p = phase();
    if (LAN_SCREENS.includes(screen)) return p === 'lan';
    if (screen === 'vote') return p === 'vote';
    if (screen === 'bilan') return p === 'finished';
    return true; // soiree, jeux, plus, biblio, historique, admin
}

function lockReason(screen) {
    const p = phase();
    if (screen === 'vote') {
        if (p === 'lan') return 'Le vote est clos, la LAN a commencé.';
        if (p === 'finished') return 'La LAN est terminée.';
        return 'Le vote n\'est pas encore ouvert.';
    }
    if (LAN_SCREENS.includes(screen)) {
        if (p === 'vote') return 'Ça ouvrira quand la LAN démarrera. Pour l\'instant, on vote.';
        if (p === 'finished') return 'La LAN est terminée.';
        return 'La LAN n\'a pas encore démarré.';
    }
    if (screen === 'bilan') return 'Le bilan s\'affichera à la fin de la soirée.';
    return '';
}

function goto(screen, options) {
    const opts = options || {};

    if (!screenAvailable(screen)) {
        const reason = lockReason(screen);
        if (reason && !opts.silent) showToast(reason, 'error');
        return;
    }

    const isTab = TABS.includes(screen);
    if (!opts.fromHistory) {
        /* Les onglets sont des racines : ils se remplacent. Les écrans
           internes s'empilent, pour que le retour du téléphone les dépile. */
        const entry = { screen };
        if (isTab) history.replaceState(entry, '');
        else if (screen !== currentScreen) history.pushState(entry, '');
    }

    currentScreen = screen;
    document.querySelectorAll('.m-screen').forEach(s => {
        s.classList.toggle('is-active', s.dataset.screen === screen);
    });
    document.querySelectorAll('.m-tab').forEach(t => {
        /* Les écrans hors onglets laissent "Plus" allumé : le joueur voit
           d'où il vient. */
        const target = t.dataset.goto;
        const active = target === screen || (!isTab && target === 'plus');
        t.classList.toggle('is-active', active);
    });

    /* En-tête : sur un écran interne, le nom de la LAN cède la place au titre
       de l'écran et la flèche de retour apparaît. */
    $('m-back').classList.toggle('is-shown', !isTab);
    $('m-lan-name').textContent = isTab
        ? (state.settings.lanName || 'LAN Demain')
        : (SCREEN_TITLES[screen] || '');

    const content = $('m-content');
    if (content) content.scrollTop = 0;
    if (screen === 'jeux') renderGames();
    if (screen === 'vote') renderVote();
    if (screen === 'biblio') renderLibraries();
    if (screen === 'admin') renderAdmin();
}

$('m-back').addEventListener('click', () => history.back());

window.addEventListener('popstate', (e) => {
    const screen = (e.state && e.state.screen) || 'soiree';
    goto(screen, { fromHistory: true, silent: true });
});

/* ==========================================================================
   Feuille glissante
   ========================================================================== */

function openSheet(heading, buildBody) {
    const sheet = $('m-sheet');
    const body = $('m-sheet-body');
    const head = $('m-sheet-head');
    body.innerHTML = '';
    if (heading) {
        head.style.display = 'flex';
        $('m-sheet-heading').textContent = heading;
    } else {
        head.style.display = 'none';
    }
    buildBody(body);
    sheet.classList.add('is-open');
}

function closeSheet() {
    $('m-sheet').classList.remove('is-open');
}

/* ==========================================================================
   Authentification et présence
   ========================================================================== */

auth.onAuthStateChanged(user => {
    if (user) {
        state.user = user;
        $('m-auth').style.display = 'none';
        $('m-app').style.display = 'flex';
        const avatar = $('m-avatar');
        avatar.src = user.photoURL || fallbackAvatar(user.displayName || user.email);
        avatar.alt = user.displayName || '';
        $('m-plus-name').textContent = user.displayName || user.email;
        boot(user);
    } else {
        state.user = null;
        refs.forEach(ref => ref.off());
        refs.length = 0;
        $('m-auth').style.display = 'flex';
        $('m-app').style.display = 'none';
    }
});

$('m-login').addEventListener('click', () => {
    $('m-auth-error').textContent = '';
    $('m-login').disabled = true;
    $('m-login-text').style.display = 'none';
    $('m-login-spinner').style.display = 'block';
    auth.signInWithPopup(googleProvider)
        .catch(error => { $('m-auth-error').textContent = error.message; })
        .finally(() => {
            $('m-login').disabled = false;
            $('m-login-text').style.display = 'inline';
            $('m-login-spinner').style.display = 'none';
        });
});

$('m-logout').addEventListener('click', () => {
    const user = auth.currentUser;
    /* Seulement cette session : le PC du même joueur reste connecté. */
    if (myConnectionRef) {
        myConnectionRef.remove();
        myConnectionRef = null;
    } else if (user) {
        db.ref('/status/' + user.uid).remove();
    }
    auth.signOut();
});

/* Le choix de version est un cookie et non un localStorage : c'est Vercel qui
   le lit pour servir la bonne page, et il ne voit pas le localStorage. */
$('m-goto-desktop').addEventListener('click', () => {
    document.cookie = 'lan_vue=bureau; path=/; max-age=31536000; samesite=lax';
    location.reload();
});

function watch(path, handler) {
    const ref = db.ref(path);
    ref.on('value', snapshot => {
        handler(snapshot.val());
        if (state.ready) renderAll();
    });
    refs.push(ref);
    return ref;
}

function boot(user) {
    /* Une clé par session : le même joueur ouvre souvent le téléphone en plus
       du PC, et fermer l'un effaçait la présence de l'autre. */
    myConnectionRef = db.ref('/status/' + user.uid).push();
    db.ref('.info/connected').on('value', snap => {
        if (snap.val() === false) return;
        myConnectionRef.onDisconnect().remove();
        myConnectionRef.set({
            state: 'online',
            name: user.displayName || user.email,
            photo: user.photoURL || null,
            device: 'téléphone'
        });
        /* Fiche durable : /status s'efface en partant, mais le bureau affiche
           les votants absents et a besoin de leur photo. */
        db.ref('lan/users/' + user.uid).update({
            name: user.displayName || user.email || '',
            avatar: user.photoURL || '',
            lastSeen: Date.now()
        }).catch(() => { /* profil non critique */ });
    });

    watch('lan/settings', value => {
        state.settings = Object.assign({ isVotingOpen: false, isLanActive: false, lanFinished: false, lanName: 'LAN Demain', topGamesCount: 10 }, value || {});
    });
    watch('lan/votes', value => {
        state.votes = value || {};
        state.scores = calculateScores(state.votes);
        /* Premier chargement seulement : on ne réécrit pas par-dessus une
           saisie en cours si un autre joueur vote au même moment. */
        if (voteDraft === null) voteDraft = readMyVote();
    });
    watch('lan/roles', value => {
        state.roles = value || {};
        const myRole = state.roles[user.uid];
        state.isAdmin = myRole === 'admin' || user.uid === ADMIN_UID;
        state.isMixologist = myRole === 'mixologist';
        $('m-plus-role').textContent = state.isAdmin ? 'Admin' : (state.isMixologist ? 'Mixologue' : '');
    });
    watch('/status', value => { state.status = value || {}; });
    watch('lan/users', value => { state.profiles = value || {}; });
    watch('lan/polls', value => { state.polls = value || {}; });
    watch('lan/foodRuns', value => { state.foodRuns = value || {}; });
    watch('lan/events', value => { state.events = value || {}; });
    watch('lan/cocktails', value => { state.cocktails = value || {}; });
    watch('lan/steamLibraries', value => { state.libraries = value || {}; });
    watch('lan/history', value => { state.history = value || {}; });
    watch(`lan/notifications/${user.uid}`, value => { state.notifs = value || {}; });

    state.ready = true;
    /* Racine de l'historique de navigation : sans elle, le premier retour du
       téléphone quitterait l'application au lieu de revenir à Soirée. */
    history.replaceState({ screen: 'soiree' }, '');
    renderAll();

    /* Un seul minuteur pour toute la page : les comptes à rebours des sondages
       et des commandes se rafraîchissent ensemble. */
    setInterval(() => {
        if (currentScreen === 'soiree' || currentScreen === 'sondages' || currentScreen === 'miam') renderAll();
    }, 30000);
}

/* ==========================================================================
   Rendu global
   ========================================================================== */

function renderAll() {
    renderHeader();
    renderPresence();
    renderSoiree();
    renderPolls();
    renderFood();
    renderEvents();
    renderKocktails();
    renderLibraries();
    renderHistory();
    renderAdmin();
    renderPlus();
    renderBadges();
    renderLocks();
    if (currentScreen === 'jeux') renderGames();
    if (currentScreen === 'vote') renderVote();
    if (state.settings.lanFinished) {
        renderRecap();
        if (!recapShown) {
            recapShown = true;
            goto('bilan');
        }
    }
}

function renderHeader() {
    /* Sur un écran interne, l'en-tête porte le titre de l'écran : on ne le
       remplace pas par le nom de la LAN à chaque mise à jour temps réel. */
    if (TABS.includes(currentScreen)) {
        $('m-lan-name').textContent = state.settings.lanName || 'LAN Demain';
    }
    const pill = $('m-phase');
    const label = $('m-phase-label');
    pill.style.display = 'inline-flex';
    pill.classList.remove('m-live--vote');
    if (state.settings.lanFinished) {
        label.textContent = 'Terminée';
        pill.style.display = 'none';
    } else if (state.settings.isLanActive) {
        label.textContent = 'En cours';
    } else if (state.settings.isVotingOpen) {
        pill.classList.add('m-live--vote');
        label.textContent = 'Vote ouvert';
    } else {
        pill.style.display = 'none';
    }
}

function renderPresence() {
    const stack = $('m-presence-stack');
    const label = $('m-presence-label');
    stack.innerHTML = '';
    /* Le nœud d'un joueur n'existe que tant qu'il lui reste une session ouverte :
       sa seule présence vaut « en ligne ». L'ancien test sur state === 'online'
       ne voyait plus personne depuis que les sessions sont imbriquées. */
    const online = Object.keys(state.status).filter(uid => statusIdentity(state.status[uid]));
    online.slice(0, 5).forEach(uid => {
        const img = el('img');
        img.src = playerPhoto(uid);
        img.alt = '';
        stack.appendChild(img);
    });
    if (!online.length) {
        label.textContent = 'Personne d\'autre en ligne';
        return;
    }
    const names = online.map(playerName);
    if (names.length === 1) {
        label.textContent = `${names[0]} est là`;
        return;
    }
    const extra = names.length - 3;
    const tail = extra > 0 ? ` et ${extra} autre${extra > 1 ? 's' : ''}` : '';
    label.textContent = `${names.slice(0, 3).join(', ')}${tail} sont là`;
}

function renderBadges() {
    const unread = Object.values(state.notifs).filter(n => n && !n.read).length;
    const badge = $('m-notif-badge');
    badge.style.display = unread ? 'grid' : 'none';
    badge.textContent = unread;

    /* Une pastille sur un onglet verrouillé promettrait quelque chose
       d'inaccessible : on ne compte que ce qui est ouvert. */
    const openRuns = screenAvailable('miam')
        ? Object.entries(state.foodRuns).filter(([, run]) => !isRunClosed(run)).length : 0;
    const foodDot = $('m-tab-food');
    foodDot.style.display = openRuns ? 'grid' : 'none';
    foodDot.textContent = openRuns;

    const openPolls = screenAvailable('sondages')
        ? visiblePolls().filter(([, poll]) => !isPollClosed(poll)).length : 0;
    const pollDot = $('m-tab-polls');
    pollDot.style.display = openPolls ? 'grid' : 'none';
    pollDot.textContent = openPolls;
}

/* Grise les destinations qui n'appartiennent pas à la phase en cours, dans
   la barre du bas comme dans la liste "Plus". */
function renderLocks() {
    document.querySelectorAll('.m-tab').forEach(tab => {
        tab.classList.toggle('is-locked', !screenAvailable(tab.dataset.goto));
    });
    document.querySelectorAll('.m-list__row[data-goto]').forEach(row => {
        const target = row.dataset.goto;
        const locked = !screenAvailable(target);
        row.classList.toggle('is-locked', locked);
        const hint = row.querySelector('.m-list__hint');
        if (hint && locked) hint.textContent = 'plus tard';
    });

    /* Si la phase change pendant qu'on est sur un écran devenu interdit
       (un admin clôt le vote), on ramène le joueur là où ça a du sens. */
    if (!screenAvailable(currentScreen)) {
        goto(phase() === 'finished' ? 'bilan' : 'soiree', { silent: true });
    }
}

/* ==========================================================================
   Écran Soirée
   ========================================================================== */

function renderSoiree() {
    const now = $('m-now');
    now.innerHTML = '';

    /* Pendant la phase de vote, la soirée n'a pas commencé : ni sondage ni
       commande à afficher, la seule action qui compte est de voter. */
    const evening = phase() === 'lan';

    const livePolls = evening ? visiblePolls().filter(([, poll]) => !isPollClosed(poll)) : [];
    livePolls.slice(0, 2).forEach(([id, poll]) => now.appendChild(buildPollCard(id, poll, true)));

    const openRuns = evening
        ? Object.entries(state.foodRuns).filter(([, run]) => !isRunClosed(run))
        : [];
    openRuns.slice(0, 2).forEach(([id, run]) => {
        const items = Object.values(run.items || {});
        const total = items.reduce((sum, it) => sum + (Number(it.price) || 0), 0);
        const card = el('article', 'm-card');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title', run.place || 'Commande'));
        const left = remaining(run.closesAt);
        if (left) top.appendChild(el('span', 'm-chip m-chip--live', `ferme dans ${left}`));
        card.appendChild(top);
        card.appendChild(el('p', 'm-card__meta', `Ouverte par ${run.createdByName || 'un joueur'} · ${items.length} article${items.length > 1 ? 's' : ''} · ${money(total)}`));
        const btn = el('button', 'm-btn m-btn--solid m-btn--full', 'Ajouter ma commande');
        btn.addEventListener('click', () => goto('miam'));
        card.appendChild(btn);
        now.appendChild(card);
    });

    if (state.settings.isVotingOpen) {
        const card = el('article', 'm-card');
        card.appendChild(el('h3', 'm-card__title', 'Le vote est ouvert'));
        card.appendChild(el('p', 'm-card__meta', `${Object.keys(state.votes).length} joueur${Object.keys(state.votes).length > 1 ? 's' : ''} ont déjà voté`));
        const btn = el('button', 'm-btn m-btn--solid m-btn--full', 'Voter maintenant');
        btn.addEventListener('click', () => goto('vote'));
        card.appendChild(btn);
        now.appendChild(card);
    }

    $('m-now-section').style.display = now.children.length ? 'flex' : 'none';

    /* Prochain événement : lui aussi appartient à la soirée */
    const upcoming = evening ? sortedEvents() : [];
    const nextBox = $('m-next-event');
    nextBox.innerHTML = '';
    if (upcoming.length) {
        nextBox.appendChild(buildEventCard(upcoming[0][0], upcoming[0][1]));
        $('m-next-section').style.display = 'flex';
        $('m-events-count').textContent = `${upcoming.length} au programme`;
    } else {
        $('m-next-section').style.display = 'none';
    }

    /* Podium */
    const podium = $('m-podium');
    podium.innerHTML = '';
    if (!state.scores.length) {
        podium.appendChild(emptyState('Aucun vote pour le moment.'));
    } else {
        podium.appendChild(buildRankList(state.scores.slice(0, 3)));
    }
}

/* ==========================================================================
   Classement
   ========================================================================== */

function voterCount(gameName) {
    const key = normalizeGameName(gameName);
    let count = 0;
    Object.values(state.votes).forEach(voteData => {
        if (!voteData || !voteData.votes) return;
        const all = Object.values(voteData.votes).flat().map(normalizeGameName);
        if (all.includes(key)) count += 1;
    });
    return count;
}

function buildRankList(games) {
    const card = el('div', 'm-card m-card--flush');
    const list = el('div', 'm-rank');
    const max = games.length ? games[0].score : 1;
    games.forEach((game, index) => {
        const position = index + 1;
        const row = el('button', `m-rank__row${position <= 3 ? ' m-rank__row--' + position : ''}`);
        const bar = el('span', 'm-rank__bar');
        bar.style.width = `${Math.max(6, Math.round((game.score / max) * 100))}%`;
        row.appendChild(bar);
        row.appendChild(el('span', 'm-rank__pos', String(position)));
        const thumb = el('img', 'm-rank__thumb');
        thumb.alt = '';
        thumbFor(game.name, thumb);
        row.appendChild(thumb);
        const main = el('span', 'm-rank__main');
        main.appendChild(el('span', 'm-rank__name', game.name));
        const n = voterCount(game.name);
        main.appendChild(el('span', 'm-rank__sub', `${n} votant${n > 1 ? 's' : ''}`));
        row.appendChild(main);
        row.appendChild(el('span', 'm-rank__score', String(game.score)));
        row.addEventListener('click', () => openGameSheet(game.name));
        list.appendChild(row);
    });
    card.appendChild(list);
    return card;
}

/* ==========================================================================
   Écran Jeux
   ========================================================================== */

let gameFilter = null;
let gameQuery = '';
const gameTags = new Map();

function renderGames() {
    const mount = $('m-games');
    mount.innerHTML = '';
    if (!state.scores.length) {
        mount.appendChild(emptyState('Aucun jeu proposé pour le moment.'));
        renderGameFilters();
        return;
    }

    let list = state.scores;
    if (gameQuery) {
        const q = normalizeGameName(gameQuery);
        list = list.filter(g => normalizeGameName(g.name).includes(q));
    }
    if (gameFilter) {
        list = list.filter(g => {
            const tags = gameTags.get(normalizeGameName(g.name));
            return tags && tags.includes(gameFilter);
        });
    }

    if (!list.length) {
        mount.appendChild(emptyState('Aucun jeu ne correspond.'));
    } else {
        mount.appendChild(buildRankList(list));
    }
    renderGameFilters();
    loadGameTags();
}

/* Les étiquettes viennent des fiches Steam : on les charge une fois, puis on
   redessine la barre de filtres quand tout est arrivé. */
let tagsLoading = false;
function loadGameTags() {
    if (tagsLoading) return;
    const missing = state.scores.filter(g => !gameTags.has(normalizeGameName(g.name)));
    if (!missing.length) return;
    tagsLoading = true;
    Promise.all(missing.map(g => gameDetails(g.name).then(details => {
        const tags = details ? [...(details.genres || []), ...(details.categories || [])] : [];
        gameTags.set(normalizeGameName(g.name), tags);
    }))).then(() => {
        tagsLoading = false;
        if (currentScreen === 'jeux') renderGames();
    });
}

function renderGameFilters() {
    const bar = $('m-game-filters');
    bar.innerHTML = '';
    const counts = new Map();
    state.scores.forEach(g => {
        (gameTags.get(normalizeGameName(g.name)) || []).forEach(tag => {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        });
    });

    const all = el('button', null, '');
    all.setAttribute('aria-pressed', gameFilter ? 'false' : 'true');
    all.appendChild(document.createTextNode('Tous '));
    all.appendChild(el('span', 'm-n', String(state.scores.length)));
    all.addEventListener('click', () => { gameFilter = null; renderGames(); });
    bar.appendChild(all);

    [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .forEach(([tag, count]) => {
            const btn = el('button');
            btn.setAttribute('aria-pressed', gameFilter === tag ? 'true' : 'false');
            btn.appendChild(document.createTextNode(tag + ' '));
            btn.appendChild(el('span', 'm-n', String(count)));
            btn.addEventListener('click', () => {
                gameFilter = gameFilter === tag ? null : tag;
                renderGames();
            });
            bar.appendChild(btn);
        });
}

$('m-game-search').addEventListener('input', (e) => {
    gameQuery = e.target.value;
    renderGames();
});

/* ==========================================================================
   Fiche de jeu
   ========================================================================== */

function openGameSheet(gameName) {
    openSheet(null, (body) => {
        body.appendChild(el('div', 'm-loading', 'Chargement de la fiche…'));
        gameDetails(gameName).then(details => {
            body.innerHTML = '';
            const hero = el('img', 'm-sheet__hero');
            hero.alt = '';
            hero.src = (details && details.headerImage) || DEFAULT_THUMB;
            body.appendChild(hero);
            body.appendChild(el('h2', 'm-sheet__title', (details && details.name) || gameName));

            const tags = details ? [...(details.genres || []), ...(details.categories || [])].slice(0, 6) : [];
            if (tags.length) {
                const box = el('div', 'm-tags');
                tags.forEach(t => box.appendChild(el('span', 'm-chip', t)));
                body.appendChild(box);
            }

            if (details && details.shortDescription) {
                body.appendChild(el('p', 'm-card__body', details.shortDescription));
            }

            if (details && details.price) {
                const price = el('div', 'm-price');
                if (details.price.free) {
                    price.appendChild(el('span', 'm-price__now', 'Gratuit'));
                } else {
                    price.appendChild(el('span', 'm-price__now', details.price.formatted || ''));
                    if (details.price.discountPercent > 0) {
                        if (details.price.initialFormatted) price.appendChild(el('span', 'm-price__was', details.price.initialFormatted));
                        price.appendChild(el('span', 'm-price__cut', `-${details.price.discountPercent} %`));
                    }
                }
                body.appendChild(price);
            }

            const score = state.scores.find(g => normalizeGameName(g.name) === normalizeGameName(gameName));
            if (score) {
                const n = voterCount(gameName);
                body.appendChild(el('p', 'm-card__meta', `${score.score} points · ${n} votant${n > 1 ? 's' : ''}`));
            }

            const actions = el('div', 'm-sheet__actions');
            const close = el('button', 'm-btn m-btn--quiet', 'Fermer');
            close.addEventListener('click', closeSheet);
            actions.appendChild(close);
            if (state.settings.isVotingOpen) {
                const add = el('button', 'm-btn m-btn--solid', 'Ajouter à mon vote');
                add.addEventListener('click', () => {
                    addToDraft((details && details.name) || gameName, 'p_other');
                    closeSheet();
                    goto('vote');
                });
                actions.appendChild(add);
            }
            body.appendChild(actions);
        });
    });
}

/* ==========================================================================
   Écran Vote
   ========================================================================== */

function readMyVote() {
    const mine = state.user && state.votes[state.user.uid];
    const draft = { p1: [], p2: [], p3: [], p_other: [] };
    if (mine && mine.votes) {
        PRIORITIES.forEach(p => {
            draft[p.key] = Array.isArray(mine.votes[p.key]) ? [...mine.votes[p.key]] : [];
        });
    }
    return draft;
}

function draftTotal() {
    if (!voteDraft) return 0;
    return PRIORITIES.reduce((sum, p) => sum + voteDraft[p.key].length, 0);
}

/* Seule P1 est limitée à un jeu, comme sur l'interface bureau où elle est la
   seule priorité sans bouton "+". P2, P3 et les autres en acceptent autant
   qu'on veut. */
function isFull(priority) {
    return priority === 'p1' && voteDraft.p1.length >= 1;
}

function addToDraft(gameName, priority) {
    if (voteDraft === null) voteDraft = readMyVote();
    const clean = String(gameName || '').trim().replace(/\s+/g, ' ');
    if (!clean) return false;
    const key = normalizeGameName(clean);
    /* Un même jeu ne peut pas occuper deux priorités : il cumulerait les
       points et fausserait le classement. */
    const already = PRIORITIES.some(p => voteDraft[p.key].some(g => normalizeGameName(g) === key));
    if (already) {
        showToast(`"${clean}" est déjà dans ton vote.`, 'error');
        return false;
    }
    const target = isFull(priority) ? 'p_other' : priority;
    if (target !== priority) {
        showToast('P1 ne porte qu\'un jeu. Ajouté aux autres.', 'error');
    }
    voteDraft[target].push(clean);
    renderVote();
    return true;
}

function renderVote() {
    if (voteDraft === null) voteDraft = readMyVote();
    const mount = $('m-vote-groups');
    const open = !!state.settings.isVotingOpen;

    /* Ce qui est en cours de frappe survit au redessin : un autre joueur qui
       vote au même moment ne doit pas vider le champ sous les doigts. */
    const typing = {};
    let focused = null;
    mount.querySelectorAll('[data-prio-input]').forEach(input => {
        typing[input.dataset.prioInput] = input.value;
        if (document.activeElement === input) focused = input.dataset.prioInput;
    });

    mount.innerHTML = '';

    PRIORITIES.forEach(p => {
        const box = el('div', 'm-prio');
        const head = el('div', 'm-prio__head');
        head.appendChild(el('span', `m-prio__tag${p.key === 'p_other' ? ' m-prio__tag--other' : ''}`, p.tag));
        head.appendChild(el('span', 'm-prio__label', p.label));
        head.appendChild(el('span', 'm-prio__pts', p.pts));
        box.appendChild(head);

        const list = el('div', 'm-prio__list');
        if (!voteDraft[p.key].length) {
            list.appendChild(el('div', 'm-prio__empty', 'Vide'));
        } else {
            voteDraft[p.key].forEach((game, index) => {
                const item = el('div', 'm-prio__item');
                item.appendChild(el('span', 'm-prio__name', game));
                if (open) {
                    const del = el('button', 'm-del');
                    del.setAttribute('aria-label', `Retirer ${game}`);
                    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
                    del.addEventListener('click', () => {
                        voteDraft[p.key].splice(index, 1);
                        renderVote();
                    });
                    item.appendChild(del);
                }
                list.appendChild(item);
            });
        }
        box.appendChild(list);

        /* P1 pleine : plus de champ d'ajout, comme le bureau qui ne lui donne
           pas de bouton "+". */
        if (open && !isFull(p.key)) {
            const add = el('div', 'm-prio__add');
            const input = el('input', 'm-input');
            input.placeholder = p.key === 'p1' ? 'Le jeu que tu veux absolument' : 'Ajouter un jeu';
            input.setAttribute('aria-label', `Ajouter un jeu en ${p.label}`);
            input.dataset.prioInput = p.key;
            if (typing[p.key]) input.value = typing[p.key];

            const commit = () => {
                if (!input.value.trim()) return;
                if (addToDraft(input.value, p.key)) {
                    /* renderVote a déjà redessiné : on rouvre la saisie du même
                       groupe pour enchaîner plusieurs jeux d'affilée. */
                    const next = mount.querySelector(`[data-prio-input="${p.key}"]`);
                    if (next) { next.value = ''; next.focus(); }
                }
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
            });

            const btn = el('button', 'm-btn m-btn--sm', '+');
            btn.setAttribute('aria-label', `Ajouter en ${p.label}`);
            btn.addEventListener('click', commit);

            add.appendChild(input);
            add.appendChild(btn);
            box.appendChild(add);
        }

        mount.appendChild(box);
    });

    if (focused) {
        const restore = mount.querySelector(`[data-prio-input="${focused}"]`);
        if (restore) {
            restore.focus();
            restore.setSelectionRange(restore.value.length, restore.value.length);
        }
    }

    const total = draftTotal();
    $('m-vote-count').textContent = `${total} jeu${total > 1 ? 'x' : ''}`;
    $('m-vote-submit').disabled = !open;
    $('m-vote-submit').textContent = open ? 'Enregistrer mon vote' : 'Le vote est clos';
    $('m-vote-hint').textContent = open
        ? 'Un seul jeu en P1, autant que tu veux dans les autres.'
        : 'Le vote est clos, voici ce que tu avais choisi.';
}

$('m-vote-submit').addEventListener('click', () => {
    const user = auth.currentUser;
    if (!user) return;
    const error = $('m-vote-error');
    error.style.display = 'none';

    if (!draftTotal()) {
        error.textContent = 'Ajoute au moins un jeu avant d\'enregistrer.';
        error.style.display = 'block';
        return;
    }

    const flat = PRIORITIES.flatMap(p => voteDraft[p.key]).map(normalizeGameName);
    const otherVotes = Object.fromEntries(Object.entries(state.votes).filter(([uid]) => uid !== user.uid));
    const typos = checkTypos(flat, otherVotes);

    if (typos.length) {
        openSheet('Une faute de frappe ?', (body) => {
            body.appendChild(el('p', 'm-card__body', 'Ces jeux ressemblent à des jeux déjà proposés. Les fusionner évite de diviser les scores.'));
            typos.forEach(t => {
                body.appendChild(el('p', 'm-card__meta', `"${t.original}" ressemble à "${t.suggestion}"`));
            });
            const actions = el('div', 'm-sheet__actions');
            const ignore = el('button', 'm-btn m-btn--quiet', 'Garder tel quel');
            ignore.addEventListener('click', () => { closeSheet(); saveVote(voteDraft); });
            const merge = el('button', 'm-btn m-btn--solid', 'Fusionner');
            merge.addEventListener('click', () => {
                const map = new Map(typos.map(t => [t.original, t.suggestion]));
                const merged = {};
                PRIORITIES.forEach(p => {
                    merged[p.key] = voteDraft[p.key].map(g => map.get(normalizeGameName(g)) || g);
                });
                voteDraft = merged;
                closeSheet();
                saveVote(merged);
            });
            actions.appendChild(ignore);
            actions.appendChild(merge);
            body.appendChild(actions);
        });
        return;
    }

    saveVote(voteDraft);
});

function saveVote(draft) {
    const user = auth.currentUser;
    if (!user) return;
    db.ref(`lan/votes/${user.uid}`)
        .set({ name: user.displayName || user.email, votes: draft })
        .then(() => showToast('Vote enregistré !', 'success'))
        .catch(error => showToast('Erreur : ' + error.message, 'error'));
}

/* ==========================================================================
   Écran Sondages
   ========================================================================== */

function isPollClosed(poll) {
    if (!poll) return true;
    if (poll.closed) return true;
    return !!(poll.closesAt && poll.closesAt <= Date.now());
}

function visiblePolls() {
    const uid = state.user && state.user.uid;
    return Object.entries(state.polls)
        .filter(([, poll]) => {
            if (!poll) return false;
            /* Un sondage ciblé ne s'affiche que pour ses destinataires, plus
               son auteur et les admins qui doivent pouvoir le clore. */
            if (!poll.audience) return true;
            if (poll.audience[uid]) return true;
            return poll.createdBy === uid || state.isAdmin;
        })
        .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
}

function pollTally(poll) {
    const votes = poll.votes || {};
    const tally = {};
    Object.keys(poll.options || {}).forEach(id => { tally[id] = 0; });
    Object.values(votes).forEach(optionId => {
        if (tally[optionId] !== undefined) tally[optionId] += 1;
    });
    return tally;
}

function buildPollCard(id, poll, compact) {
    const uid = state.user && state.user.uid;
    const closed = isPollClosed(poll);
    const tally = pollTally(poll);
    const totalVotes = Object.values(tally).reduce((a, b) => a + b, 0);
    const myVote = (poll.votes || {})[uid];

    const card = el('article', 'm-card');
    const top = el('div', 'm-card__top');
    top.appendChild(el('h3', 'm-card__title', poll.question || 'Sondage'));
    if (closed) {
        top.appendChild(el('span', 'm-chip m-chip--closed', 'clos'));
    } else {
        const left = remaining(poll.closesAt);
        if (left) top.appendChild(el('span', 'm-chip m-chip--live', left));
        else if (poll.audience) top.appendChild(el('span', 'm-chip m-chip--gold', 'pour toi'));
    }
    card.appendChild(top);

    const audienceNote = poll.audience ? ` · ${Object.keys(poll.audience).length} personne${Object.keys(poll.audience).length > 1 ? 's' : ''} concernée${Object.keys(poll.audience).length > 1 ? 's' : ''}` : '';
    card.appendChild(el('p', 'm-card__meta', `${poll.createdByName || 'Un joueur'} · ${totalVotes} vote${totalVotes > 1 ? 's' : ''}${audienceNote}`));

    if (closed) {
        const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
        if (best && best[1] > 0) {
            const winner = el('div', 'm-winner');
            winner.appendChild(el('span', 'm-winner__label', 'Résultat'));
            winner.appendChild(el('span', 'm-winner__value', poll.options[best[0]]));
            winner.appendChild(el('span', 'm-opt__n', `${best[1]} vote${best[1] > 1 ? 's' : ''}`));
            card.appendChild(winner);
        } else {
            card.appendChild(el('p', 'm-card__meta', 'Personne n\'a voté.'));
        }
        return card;
    }

    const options = Object.entries(poll.options || {});
    const shown = compact ? options.slice(0, 2) : options;
    shown.forEach(([optId, label]) => {
        const btn = el('button', 'm-opt');
        btn.setAttribute('aria-pressed', myVote === optId ? 'true' : 'false');
        const fill = el('span', 'm-opt__fill');
        fill.style.width = totalVotes ? `${Math.round((tally[optId] / totalVotes) * 100)}%` : '0%';
        btn.appendChild(fill);
        btn.appendChild(el('span', 'm-opt__label', label));
        btn.appendChild(el('span', 'm-opt__n', String(tally[optId])));
        const tick = document.createElement('span');
        tick.className = 'm-opt__tick';
        tick.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12 6 6L20 6"/></svg>';
        btn.appendChild(tick);
        btn.addEventListener('click', () => votePoll(id, optId, myVote === optId));
        card.appendChild(btn);
    });

    if (compact && options.length > shown.length) {
        const more = el('button', 'm-btn m-btn--quiet m-btn--sm', `Voir les ${options.length} options`);
        more.addEventListener('click', () => goto('sondages'));
        card.appendChild(more);
    }

    if (!compact && (poll.createdBy === uid || state.isAdmin)) {
        const close = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Clore le sondage');
        close.addEventListener('click', () => {
            db.ref(`lan/polls/${id}/closed`).set(true)
                .then(() => showToast('Sondage clos.', 'success'))
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        card.appendChild(close);
    }

    return card;
}

function votePoll(pollId, optionId, isUnvote) {
    const user = auth.currentUser;
    if (!user) return;
    const ref = db.ref(`lan/polls/${pollId}/votes/${user.uid}`);
    const action = isUnvote ? ref.remove() : ref.set(optionId);
    action.catch(error => showToast('Erreur : ' + error.message, 'error'));
}

function renderPolls() {
    const mount = $('m-polls');
    mount.innerHTML = '';
    const polls = visiblePolls();
    const open = polls.filter(([, p]) => !isPollClosed(p));
    const closed = polls.filter(([, p]) => isPollClosed(p));

    if (!open.length) {
        mount.appendChild(emptyState('Aucun sondage en cours.'));
    } else {
        open.forEach(([id, poll]) => mount.appendChild(buildPollCard(id, poll, false)));
    }

    if (closed.length) {
        const section = el('div', 'm-section');
        const head = el('div', 'm-section__head');
        head.appendChild(el('h2', 'm-section__title', 'Clos'));
        section.appendChild(head);
        closed.slice(0, 5).forEach(([id, poll]) => section.appendChild(buildPollCard(id, poll, false)));
        mount.appendChild(section);
    }
}

$('m-poll-new').addEventListener('click', () => {
    openSheet('Lancer un sondage', (body) => {
        const question = el('input', 'm-input');
        question.placeholder = 'La question';
        body.appendChild(question);

        const optionsBox = el('div', 'm-section');
        const optionInputs = [];
        function addOption(value) {
            const input = el('input', 'm-input');
            input.placeholder = `Option ${optionInputs.length + 1}`;
            if (value) input.value = value;
            optionInputs.push(input);
            optionsBox.appendChild(input);
        }
        addOption();
        addOption();
        body.appendChild(optionsBox);

        const addBtn = el('button', 'm-btn m-btn--quiet m-btn--sm', '+ Option');
        addBtn.addEventListener('click', () => { if (optionInputs.length < 6) addOption(); });
        body.appendChild(addBtn);

        const durationRow = el('div', 'm-formrow');
        durationRow.appendChild(el('span', 'm-label', 'Durée'));
        const duration = el('select', 'm-input');
        [['5', '5 minutes'], ['10', '10 minutes'], ['30', '30 minutes'], ['0', 'Sans limite']].forEach(([v, label]) => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = label;
            duration.appendChild(opt);
        });
        duration.value = '10';
        durationRow.appendChild(duration);
        body.appendChild(durationRow);

        const submit = el('button', 'm-btn m-btn--solid m-btn--full', 'Lancer');
        submit.addEventListener('click', () => {
            const user = auth.currentUser;
            if (!user) return;
            const q = question.value.trim();
            const labels = optionInputs.map(i => i.value.trim()).filter(Boolean);
            if (!q) { showToast('Il manque la question.', 'error'); return; }
            if (labels.length < 2) { showToast('Il faut au moins deux options.', 'error'); return; }

            const optionMap = {};
            labels.forEach((label, i) => { optionMap['o' + (i + 1)] = label; });
            const minutes = parseInt(duration.value, 10) || 0;

            db.ref('lan/polls').push().set({
                question: q,
                options: optionMap,
                audience: null,
                createdBy: user.uid,
                createdByName: user.displayName || 'Un joueur',
                createdAt: firebase.database.ServerValue.TIMESTAMP,
                closesAt: minutes > 0 ? Date.now() + minutes * 60000 : null,
                closed: false
            }).then(() => {
                closeSheet();
                showToast('Sondage lancé !', 'success');
                goto('sondages');
            }).catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        body.appendChild(submit);
    });
});

/* ==========================================================================
   Écran Miam
   ========================================================================== */

function isRunClosed(run) {
    if (!run) return true;
    if (run.closed) return true;
    return !!(run.closesAt && run.closesAt <= Date.now());
}

function renderFood() {
    const mount = $('m-food-runs');
    /* On mémorise ce qui est en train d'être tapé : sans ça, une commande
       ajoutée par un autre joueur viderait le champ sous les doigts. */
    const drafts = {};
    mount.querySelectorAll('[data-run-label]').forEach(input => { drafts[input.dataset.runLabel] = input.value; });
    mount.querySelectorAll('[data-run-price]').forEach(input => { drafts['price:' + input.dataset.runPrice] = input.value; });

    mount.innerHTML = '';
    const runs = Object.entries(state.foodRuns).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    const open = runs.filter(([, r]) => !isRunClosed(r));
    const closed = runs.filter(([, r]) => isRunClosed(r));

    if (!open.length) {
        mount.appendChild(emptyState('Aucune commande ouverte.'));
    } else {
        open.forEach(([id, run]) => mount.appendChild(buildRunCard(id, run, drafts)));
    }

    if (closed.length) {
        const section = el('div', 'm-section');
        const head = el('div', 'm-section__head');
        head.appendChild(el('h2', 'm-section__title', 'Terminées'));
        section.appendChild(head);
        closed.slice(0, 4).forEach(([id, run]) => section.appendChild(buildRunCard(id, run, drafts)));
        mount.appendChild(section);
    }
}

function buildRunCard(id, run, drafts) {
    const uid = state.user && state.user.uid;
    const closed = isRunClosed(run);
    const items = Object.entries(run.items || {});
    const total = items.reduce((sum, [, it]) => sum + (Number(it.price) || 0), 0);

    const card = el('article', 'm-card');
    const top = el('div', 'm-card__top');
    top.appendChild(el('h3', 'm-card__title', run.place || 'Commande'));
    if (closed) {
        top.appendChild(el('span', 'm-chip m-chip--closed', 'fermée'));
    } else {
        const left = remaining(run.closesAt);
        if (left) top.appendChild(el('span', 'm-chip m-chip--live', left));
    }
    card.appendChild(top);
    card.appendChild(el('p', 'm-card__meta', `Ouverte par ${run.createdByName || 'un joueur'} · ${items.length} article${items.length > 1 ? 's' : ''}`));

    if (!closed) {
        const field = el('div', 'm-field');
        const label = el('input', 'm-input');
        label.placeholder = 'Ce que je prends';
        label.dataset.runLabel = id;
        if (drafts[id]) label.value = drafts[id];
        const price = el('input', 'm-input m-field__price');
        price.placeholder = '€';
        price.inputMode = 'decimal';
        price.dataset.runPrice = id;
        if (drafts['price:' + id]) price.value = drafts['price:' + id];
        field.appendChild(label);
        field.appendChild(price);
        card.appendChild(field);

        const add = el('button', 'm-btn m-btn--full', 'Ajouter à la commande');
        add.addEventListener('click', () => {
            const text = label.value.trim();
            if (!text) { showToast('Il manque ce que tu prends.', 'error'); return; }
            const value = parseFloat(String(price.value).replace(',', '.')) || 0;
            db.ref(`lan/foodRuns/${id}/items`).push().set({
                userId: uid,
                userName: (state.user && state.user.displayName) || 'Joueur',
                label: text,
                price: value
            }).then(() => {
                label.value = '';
                price.value = '';
                showToast('Ajouté à la commande.', 'success');
            }).catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        card.appendChild(add);
    }

    /* Mes articles, avec la possibilité de les retirer un à un */
    const mine = items.filter(([, it]) => it.userId === uid);
    if (mine.length && !closed) {
        const box = el('div', 'm-myitems');
        mine.forEach(([itemId, it]) => {
            const row = el('div', 'm-myitem');
            row.appendChild(el('span', 'm-myitem__label', it.label));
            row.appendChild(el('span', 'm-myitem__price', money(it.price)));
            const del = el('button', 'm-del');
            del.setAttribute('aria-label', `Retirer ${it.label}`);
            del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
            del.addEventListener('click', () => {
                db.ref(`lan/foodRuns/${id}/items/${itemId}`).remove()
                    .catch(e => showToast('Erreur : ' + e.message, 'error'));
            });
            row.appendChild(del);
            box.appendChild(row);
        });
        card.appendChild(box);
    }

    /* Total par personne : c'est ce qu'on regarde au moment de rembourser */
    if (items.length) {
        const byPerson = new Map();
        items.forEach(([, it]) => {
            const key = it.userId || 'inconnu';
            if (!byPerson.has(key)) byPerson.set(key, { name: it.userName || playerName(key), labels: [], sum: 0 });
            const entry = byPerson.get(key);
            entry.labels.push(it.label);
            entry.sum += Number(it.price) || 0;
        });

        const tally = el('div', 'm-tally');
        byPerson.forEach((entry, key) => {
            const row = el('div', 'm-tally__person');
            const img = el('img', 'm-tally__av');
            img.src = playerPhoto(key);
            img.alt = '';
            row.appendChild(img);
            const who = el('span', 'm-tally__who');
            const nameRow = el('span', 'm-tally__name');
            nameRow.appendChild(document.createTextNode(entry.name));
            if (key === uid) nameRow.appendChild(el('span', 'm-chip m-chip--gold', 'moi'));
            who.appendChild(nameRow);
            who.appendChild(el('span', 'm-tally__items', entry.labels.join(', ')));
            row.appendChild(who);
            row.appendChild(el('span', 'm-tally__sum', money(entry.sum)));
            tally.appendChild(row);
        });
        card.appendChild(tally);

        const totalRow = el('div', 'm-total');
        totalRow.appendChild(el('span', 'm-total__label', 'Total commande'));
        totalRow.appendChild(el('span', 'm-total__value', money(total)));
        card.appendChild(totalRow);
    }

    if (!closed && (run.createdBy === uid || state.isAdmin)) {
        const close = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Fermer la commande');
        close.addEventListener('click', () => {
            db.ref(`lan/foodRuns/${id}/closed`).set(true)
                .then(() => showToast('Commande fermée.', 'success'))
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        card.appendChild(close);
    }

    return card;
}

$('m-food-open').addEventListener('click', () => {
    openSheet('Ouvrir une commande', (body) => {
        const place = el('input', 'm-input');
        place.placeholder = 'Où on commande ?';
        body.appendChild(place);

        const row = el('div', 'm-formrow');
        row.appendChild(el('span', 'm-label', 'Ferme dans'));
        const duration = el('select', 'm-input');
        [['10', '10 minutes'], ['20', '20 minutes'], ['30', '30 minutes'], ['0', 'Sans limite']].forEach(([v, label]) => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = label;
            duration.appendChild(opt);
        });
        duration.value = '20';
        row.appendChild(duration);
        body.appendChild(row);

        const submit = el('button', 'm-btn m-btn--solid m-btn--full', 'Ouvrir');
        submit.addEventListener('click', () => {
            const user = auth.currentUser;
            if (!user) return;
            const value = place.value.trim();
            if (!value) { showToast('Il manque le lieu.', 'error'); return; }
            const minutes = parseInt(duration.value, 10) || 0;
            db.ref('lan/foodRuns').push().set({
                place: value,
                createdBy: user.uid,
                createdByName: user.displayName || 'Un joueur',
                createdAt: firebase.database.ServerValue.TIMESTAMP,
                closesAt: minutes > 0 ? Date.now() + minutes * 60000 : null,
                closed: false
            }).then(() => {
                closeSheet();
                showToast('Commande ouverte !', 'success');
                goto('miam');
            }).catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        body.appendChild(submit);
    });
});

/* ==========================================================================
   Écran Événements
   ========================================================================== */

/* Une LAN passe minuit : trier les heures en texte mettrait "00:00" avant
   "21:00" et annoncerait les shots de minuit comme prochain événement à 21 h.
   Tout ce qui tombe avant 6 h du matin compte donc pour le lendemain. */
function eventOrder(time) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
    if (!match) return Number.MAX_SAFE_INTEGER;
    const minutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    return minutes < 6 * 60 ? minutes + 24 * 60 : minutes;
}

function sortedEvents() {
    return Object.entries(state.events)
        .filter(([, evt]) => !!evt)
        .sort((a, b) => eventOrder(a[1].time) - eventOrder(b[1].time));
}

function buildEventCard(id, evt) {
    const uid = state.user && state.user.uid;
    const rsvps = evt.rsvps || {};
    const accepted = Object.values(rsvps).filter(v => v === 'accepted').length;
    const mine = rsvps[uid];

    const card = el('article', 'm-card');
    const top = el('div', 'm-card__top');
    top.appendChild(el('h3', 'm-card__title', evt.title || 'Événement'));
    if (evt.time) top.appendChild(el('span', 'm-chip m-chip--gold', evt.time));
    card.appendChild(top);

    if (evt.description) card.appendChild(el('p', 'm-card__body', evt.description));
    if (evt.isAlcohol && evt.alcoholRules) {
        card.appendChild(el('p', 'm-card__meta', `🍻 ${evt.alcoholRules}`));
    }

    const slots = evt.slots ? ` sur ${evt.slots} place${evt.slots > 1 ? 's' : ''}` : '';
    const meta = [`${accepted} inscrit${accepted > 1 ? 's' : ''}${slots}`];
    if (evt.game) meta.push(evt.game);
    if (evt.creatorName) meta.push(`proposé par ${evt.creatorName}`);
    card.appendChild(el('p', 'm-card__meta', meta.join(' · ')));

    const actions = el('div', 'm-field');
    const yes = el('button', `m-btn m-btn--sm${mine === 'accepted' ? ' m-btn--solid' : ''}`, mine === 'accepted' ? 'Je suis inscrit' : 'Je viens');
    yes.style.flex = '1';
    yes.addEventListener('click', () => setRsvp(id, mine === 'accepted' ? null : 'accepted'));
    const no = el('button', `m-btn m-btn--sm${mine === 'declined' ? '' : ' m-btn--quiet'}`, 'Sans moi');
    no.style.flex = '1';
    no.addEventListener('click', () => setRsvp(id, mine === 'declined' ? null : 'declined'));
    actions.appendChild(yes);
    actions.appendChild(no);
    card.appendChild(actions);

    if (evt.creatorId === uid || state.isAdmin) {
        const del = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Supprimer');
        del.addEventListener('click', () => {
            db.ref(`lan/events/${id}`).remove()
                .then(() => showToast('Événement supprimé.', 'success'))
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        card.appendChild(del);
    }

    return card;
}

function setRsvp(eventId, value) {
    const user = auth.currentUser;
    if (!user) return;
    const ref = db.ref(`lan/events/${eventId}/rsvps/${user.uid}`);
    const action = value === null ? ref.remove() : ref.set(value);
    action.catch(error => showToast('Erreur : ' + error.message, 'error'));
}

function renderEvents() {
    const mount = $('m-events');
    mount.innerHTML = '';
    const events = sortedEvents();
    if (!events.length) {
        mount.appendChild(emptyState('Aucun événement au programme.'));
        return;
    }
    events.forEach(([id, evt]) => mount.appendChild(buildEventCard(id, evt)));
}

$('m-event-new').addEventListener('click', () => {
    openSheet('Créer un événement', (body) => {
        const title = el('input', 'm-input');
        title.placeholder = 'Titre (ex: Tournoi Rocket League)';
        body.appendChild(title);

        const desc = el('textarea', 'm-input');
        desc.placeholder = 'Les règles, le format, ce qu\'il faut savoir';
        body.appendChild(desc);

        const game = el('input', 'm-input');
        game.placeholder = 'Jeu (optionnel)';
        body.appendChild(game);

        const timeRow = el('div', 'm-field');
        const time = el('input', 'm-input');
        time.type = 'time';
        time.setAttribute('aria-label', 'Heure');
        const slots = el('input', 'm-input m-field__price');
        slots.type = 'number';
        slots.min = '0';
        slots.placeholder = 'Places';
        timeRow.appendChild(time);
        timeRow.appendChild(slots);
        body.appendChild(timeRow);

        const alcoholWrap = el('label', 'm-check');
        const alcohol = document.createElement('input');
        alcohol.type = 'checkbox';
        alcoholWrap.appendChild(alcohol);
        alcoholWrap.appendChild(el('span', null, 'Ça implique de boire'));
        body.appendChild(alcoholWrap);

        const rules = el('input', 'm-input');
        rules.placeholder = 'Les règles du jeu à boire';
        rules.style.display = 'none';
        alcohol.addEventListener('change', () => {
            rules.style.display = alcohol.checked ? 'block' : 'none';
        });
        body.appendChild(rules);

        const submit = el('button', 'm-btn m-btn--solid m-btn--full', 'Créer');
        submit.addEventListener('click', () => {
            const user = auth.currentUser;
            if (!user) return;
            const value = title.value.trim();
            if (!value) { showToast('Il manque le titre.', 'error'); return; }
            const newEvent = {
                title: value,
                description: desc.value.trim(),
                game: game.value.trim(),
                time: time.value || '',
                slots: parseInt(slots.value, 10) || 0,
                creatorId: user.uid,
                creatorName: user.displayName || 'Un joueur',
                isGlobal: false,
                isAlcohol: alcohol.checked,
                alcoholRules: alcohol.checked ? rules.value.trim() : '',
                rsvps: { [user.uid]: 'accepted' },
                createdAt: firebase.database.ServerValue.TIMESTAMP
            };
            db.ref('lan/events').push().set(newEvent)
                .then(() => {
                    closeSheet();
                    showToast('Événement créé !', 'success');
                    goto('evenements');
                })
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        body.appendChild(submit);
    });
});

/* ==========================================================================
   Écran Kocktails
   ========================================================================== */

function renderKocktails() {
    const uid = state.user && state.user.uid;
    const master = state.cocktails.masterList || {};
    const oneshot = state.cocktails.oneshot || {};
    const orders = state.cocktails.orders || {};

    /* File du bar : réservée au mixologue et aux admins, c'est leur écran de travail */
    const barSection = $('m-bar-section');
    const queue = $('m-bar-queue');
    queue.innerHTML = '';
    const orderList = Object.entries(orders).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
    if (state.isAdmin || state.isMixologist) {
        barSection.style.display = 'flex';
        if (!orderList.length) {
            queue.appendChild(emptyState('Aucune commande au bar.'));
        } else {
            orderList.forEach(([id, order]) => {
                const card = el('article', 'm-card');
                const top = el('div', 'm-card__top');
                top.appendChild(el('h3', 'm-card__title', order.cocktailName || 'Kocktail'));
                top.appendChild(el('span', 'm-chip', timeAgo(order.timestamp)));
                card.appendChild(top);
                card.appendChild(el('p', 'm-card__meta', `pour ${order.userName || playerName(order.userId)}`));
                const served = el('button', 'm-btn m-btn--sm m-btn--full', 'Servi');
                served.addEventListener('click', () => {
                    db.ref(`lan/cocktails/orders/${id}`).remove()
                        .then(() => showToast('Servi !', 'success'))
                        .catch(e => showToast('Erreur : ' + e.message, 'error'));
                });
                card.appendChild(served);
                queue.appendChild(card);
            });
        }
    } else {
        barSection.style.display = 'none';
    }

    const masterMount = $('m-kocktails-master');
    masterMount.innerHTML = '';
    const masterList = Object.entries(master);
    if (!masterList.length) {
        masterMount.appendChild(emptyState('La carte est vide.'));
    } else {
        masterList.forEach(([id, k]) => masterMount.appendChild(buildKocktailCard(id, k, 'masterList')));
    }

    const oneshotMount = $('m-kocktails-oneshot');
    oneshotMount.innerHTML = '';
    const oneshotList = Object.entries(oneshot);
    if (!oneshotList.length) {
        oneshotMount.appendChild(emptyState('Aucune invention pour le moment.'));
    } else {
        oneshotList.forEach(([id, k]) => oneshotMount.appendChild(buildKocktailCard(id, k, 'oneshot')));
    }
}

function buildKocktailCard(id, k, kind) {
    const uid = state.user && state.user.uid;
    const card = el('article', 'm-card');
    const top = el('div', 'm-card__top');
    top.appendChild(el('h3', 'm-card__title', k.name || 'Kocktail'));
    card.appendChild(top);

    const recipe = k.ingredients || k.recipe;
    if (recipe) card.appendChild(el('p', 'm-card__body', recipe));
    if (k.creatorName) card.appendChild(el('p', 'm-card__meta', `inventé par ${k.creatorName}`));

    const order = el('button', 'm-btn m-btn--full', 'Commander au bar');
    order.addEventListener('click', () => {
        const user = auth.currentUser;
        if (!user) return;
        db.ref('lan/cocktails/orders').push().set({
            cocktailName: k.name,
            userId: user.uid,
            userName: user.displayName || 'Un joueur',
            timestamp: firebase.database.ServerValue.TIMESTAMP
        }).then(() => showToast('Commande envoyée au bar !', 'success'))
            .catch(e => showToast('Erreur : ' + e.message, 'error'));
    });
    card.appendChild(order);

    const canDelete = state.isAdmin || (kind === 'oneshot' && k.creatorId === uid) || (kind === 'masterList' && state.isMixologist);
    if (canDelete) {
        const del = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Supprimer');
        del.addEventListener('click', () => {
            db.ref(`lan/cocktails/${kind}/${id}`).remove()
                .then(() => showToast('Supprimé.', 'success'))
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        card.appendChild(del);
    }

    return card;
}

$('m-kocktail-new').addEventListener('click', () => {
    openSheet('Inventer un one-shot', (body) => {
        const name = el('input', 'm-input');
        name.placeholder = 'Le nom de ta création';
        body.appendChild(name);
        const recipe = el('textarea', 'm-input');
        recipe.placeholder = 'Ex: Rhum blanc, menthe fraîche, citron vert, sucre de canne';
        body.appendChild(recipe);
        const submit = el('button', 'm-btn m-btn--solid m-btn--full', 'Ajouter aux one-shots');
        submit.addEventListener('click', () => {
            const user = auth.currentUser;
            if (!user) return;
            const value = name.value.trim();
            if (!value) { showToast('Il manque le nom.', 'error'); return; }
            db.ref('lan/cocktails/oneshot').push().set({
                name: value,
                recipe: recipe.value.trim(),
                creatorId: user.uid,
                creatorName: user.displayName || 'Un joueur',
                createdAt: firebase.database.ServerValue.TIMESTAMP
            }).then(() => {
                closeSheet();
                showToast(`"${value}" ajouté !`, 'success');
            }).catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        body.appendChild(submit);
    });
});

/* ==========================================================================
   Écran Plus
   ========================================================================== */

function renderPlus() {
    const events = sortedEvents().length;
    $('m-plus-events').textContent = events ? String(events) : '';
    const orders = Object.keys(state.cocktails.orders || {}).length;
    $('m-plus-kocktails').textContent = orders ? `${orders} en attente` : '';
    const total = draftTotal();
    $('m-plus-vote').textContent = total ? `${total} jeu${total > 1 ? 'x' : ''}` : '';
    const libs = Object.keys(state.libraries).length;
    $('m-plus-biblio').textContent = libs ? `${libs} liée${libs > 1 ? 's' : ''}` : '';
    const lans = Object.keys(state.history).length;
    $('m-plus-historique').textContent = lans ? String(lans) : '';
    $('m-plus-admin-row').style.display = state.isAdmin ? 'flex' : 'none';
}

/* ==========================================================================
   Écran Bibliothèques Steam
   ========================================================================== */

/* Catalogue Game Pass : API non officielle, donc une panne ne doit rien
   casser. Même clé de cache que l'interface bureau, valable 24 h. */
const GAMEPASS_STORE = 'lan-demain:gamepass:v1';
const GAMEPASS_TTL = 24 * 60 * 60 * 1000;
let gamepassCatalog = null;
let gamepassPromise = null;

function loadGamepass() {
    if (gamepassCatalog) return Promise.resolve(gamepassCatalog);
    if (gamepassPromise) return gamepassPromise;
    try {
        const raw = localStorage.getItem(GAMEPASS_STORE);
        if (raw) {
            const data = JSON.parse(raw);
            if (data && Date.now() - data.ts < GAMEPASS_TTL && Array.isArray(data.games)) {
                gamepassCatalog = data.games.map(normalizeGameName);
                return Promise.resolve(gamepassCatalog);
            }
        }
    } catch (error) {
        console.debug('Cache Game Pass illisible:', error);
    }
    gamepassPromise = fetch('/api/gamepass-catalog')
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
            const games = (data && data.games) ? data.games : [];
            try {
                localStorage.setItem(GAMEPASS_STORE, JSON.stringify({ ts: Date.now(), games }));
            } catch (error) {
                console.debug('Catalogue Game Pass non mis en cache:', error);
            }
            gamepassCatalog = games.map(normalizeGameName);
            return gamepassCatalog;
        })
        .catch(error => {
            console.debug('Catalogue Game Pass indisponible:', error);
            gamepassCatalog = [];
            return gamepassCatalog;
        });
    return gamepassPromise;
}

let biblioQuery = '';

function renderLibraries() {
    const libs = Object.entries(state.libraries).filter(([, lib]) => !!lib);

    /* Comptes liés */
    const linked = $('m-steam-libs');
    linked.innerHTML = '';
    if (!libs.length) {
        linked.appendChild(emptyState('Aucun compte lié. Colle une URL de profil Steam ci-dessus.'));
    } else {
        libs.forEach(([id, lib]) => {
            const card = el('article', 'm-card');
            const top = el('div', 'm-card__top');
            const avatar = el('img', 'm-tally__av');
            avatar.src = lib.avatar || fallbackAvatar(lib.personaName);
            avatar.alt = '';
            top.appendChild(avatar);
            top.appendChild(el('h3', 'm-card__title', lib.personaName || `Steam ${id}`));
            card.appendChild(top);
            const count = Array.isArray(lib.games) ? lib.games.length : 0;
            card.appendChild(el('p', 'm-card__meta', `${count} jeu${count > 1 ? 'x' : ''}${lib.addedByName ? ` · ajouté par ${lib.addedByName}` : ''}`));

            const gpWrap = el('label', 'm-check');
            const gp = document.createElement('input');
            gp.type = 'checkbox';
            gp.checked = !!lib.gamepass;
            gp.addEventListener('change', () => {
                db.ref(`lan/steamLibraries/${id}/gamepass`).set(gp.checked)
                    .catch(e => showToast('Erreur : ' + e.message, 'error'));
            });
            gpWrap.appendChild(gp);
            gpWrap.appendChild(el('span', null, 'Abonné au PC Game Pass'));
            card.appendChild(gpWrap);

            const del = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Retirer cette bibliothèque');
            del.addEventListener('click', () => {
                db.ref(`lan/steamLibraries/${id}`).remove()
                    .then(() => showToast('Bibliothèque retirée.', 'success'))
                    .catch(e => showToast('Erreur : ' + e.message, 'error'));
            });
            card.appendChild(del);
            linked.appendChild(card);
        });
    }

    /* Bibliothèque commune : un jeu, et qui le possède */
    const owners = libs.map(([, lib]) => ({
        name: lib.personaName || 'Steam',
        gamepass: !!lib.gamepass,
        games: Array.isArray(lib.games) ? lib.games : []
    }));

    const byGame = new Map();
    owners.forEach(owner => {
        owner.games.forEach(game => {
            const label = typeof game === 'string' ? game : game.name;
            if (!label) return;
            const key = normalizeGameName(label);
            if (!byGame.has(key)) byGame.set(key, { name: label, owners: [] });
            byGame.get(key).owners.push(owner.name);
        });
    });

    const anyGamepass = owners.some(o => o.gamepass);
    const catalog = gamepassCatalog || [];

    let list = [...byGame.values()].sort((a, b) => {
        if (b.owners.length !== a.owners.length) return b.owners.length - a.owners.length;
        return a.name.localeCompare(b.name);
    });

    if (biblioQuery) {
        const q = normalizeGameName(biblioQuery);
        list = list.filter(g => normalizeGameName(g.name).includes(q));
    }

    $('m-biblio-count').textContent = byGame.size ? `${byGame.size} jeu${byGame.size > 1 ? 'x' : ''}` : '';

    const mount = $('m-biblio-list');
    mount.innerHTML = '';
    if (!list.length) {
        mount.appendChild(emptyState(byGame.size ? 'Aucun jeu ne correspond.' : 'Lie un compte Steam pour voir ce que vous avez en commun.'));
        loadGamepass().then(() => { if (currentScreen === 'biblio') renderLibraries(); });
        return;
    }

    const card = el('div', 'm-card m-card--flush');
    const rank = el('div', 'm-rank');
    list.slice(0, 60).forEach(game => {
        const row = el('button', 'm-rank__row');
        const bar = el('span', 'm-rank__bar');
        bar.style.width = owners.length ? `${Math.round((game.owners.length / owners.length) * 100)}%` : '0%';
        row.appendChild(bar);
        const thumb = el('img', 'm-rank__thumb');
        thumb.alt = '';
        thumbFor(game.name, thumb);
        row.appendChild(thumb);
        const main = el('span', 'm-rank__main');
        main.appendChild(el('span', 'm-rank__name', game.name));
        const inGamepass = anyGamepass && catalog.includes(normalizeGameName(game.name));
        const sub = `${game.owners.length}/${owners.length} · ${game.owners.join(', ')}${inGamepass ? ' · Game Pass' : ''}`;
        main.appendChild(el('span', 'm-rank__sub', sub));
        row.appendChild(main);
        row.appendChild(el('span', 'm-rank__score', String(game.owners.length)));
        row.addEventListener('click', () => openGameSheet(game.name));
        rank.appendChild(row);
    });
    card.appendChild(rank);
    mount.appendChild(card);

    loadGamepass().then(cat => {
        /* Le catalogue arrive après coup : on redessine une fois pour poser
           les pastilles Game Pass, sans boucler. */
        if (cat && cat.length && currentScreen === 'biblio' && !renderLibraries.gamepassDone) {
            renderLibraries.gamepassDone = true;
            renderLibraries();
        }
    });
}

$('m-biblio-search').addEventListener('input', (e) => {
    biblioQuery = e.target.value;
    renderLibraries();
});

$('m-steam-link').addEventListener('click', async () => {
    const input = $('m-steam-input');
    const status = $('m-steam-status');
    const user = auth.currentUser;
    if (!user) return;
    const profile = input.value.trim();
    if (!profile) { showToast('Colle une URL de profil Steam.', 'error'); return; }

    status.textContent = 'Récupération de la bibliothèque…';
    try {
        const res = await fetch(`/api/steam-library?profile=${encodeURIComponent(profile)}`);
        const data = await res.json();

        if (data.missingKey) {
            status.textContent = 'La clé API Steam n\'est pas configurée côté serveur.';
            showToast('STEAM_API_KEY manquante sur Vercel.', 'error');
            return;
        }
        if (!res.ok) {
            status.textContent = 'Profil introuvable. Vérifie l\'URL ou le pseudo.';
            showToast('Profil Steam introuvable.', 'error');
            return;
        }
        if (data.privateProfile) {
            status.textContent = 'Profil trouvé, mais ses détails de jeu sont privés. Passe « Détails du jeu » en Public dans Steam puis réessaie.';
            showToast('Bibliothèque Steam privée.', 'error');
            return;
        }

        const label = data.personaName || `Steam ${data.steamId}`;
        await db.ref(`lan/steamLibraries/${data.steamId}`).set({
            steamId: data.steamId,
            personaName: label,
            avatar: data.avatar || null,
            profileUrl: data.profileUrl || null,
            games: (data.games || []).slice(0, 500),
            addedBy: user.uid,
            addedByName: user.displayName || null,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });

        status.textContent = `${data.gameCount} jeux importés pour ${label}.`;
        showToast(`${data.gameCount} jeux importés pour ${label} !`, 'success');
        input.value = '';
    } catch (error) {
        status.textContent = 'Impossible de récupérer la bibliothèque.';
        showToast('Erreur : ' + error.message, 'error');
    }
});

/* ==========================================================================
   Écran Historique
   ========================================================================== */

function renderHistory() {
    const mount = $('m-history');
    mount.innerHTML = '';
    const entries = Object.entries(state.history)
        .filter(([, entry]) => !!entry)
        .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

    if (!entries.length) {
        mount.appendChild(emptyState('Aucune LAN archivée pour le moment.'));
        return;
    }

    entries.forEach(([id, entry]) => {
        const card = el('article', 'm-card');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title', entry.name || 'LAN'));
        if (entry.date) top.appendChild(el('span', 'm-chip', entry.date));
        card.appendChild(top);

        const games = Array.isArray(entry.topGames) ? entry.topGames : [];
        const players = entry.votes ? Object.keys(entry.votes).length : 0;
        const meta = [];
        if (players) meta.push(`${players} joueur${players > 1 ? 's' : ''}`);
        if (games.length) meta.push(`${games.length} jeu${games.length > 1 ? 'x' : ''}`);
        if (meta.length) card.appendChild(el('p', 'm-card__meta', meta.join(' · ')));

        if (games.length) {
            const winner = el('div', 'm-winner');
            winner.appendChild(el('span', 'm-winner__label', 'Vainqueur'));
            winner.appendChild(el('span', 'm-winner__value', games[0].name));
            winner.appendChild(el('span', 'm-opt__n', String(games[0].score)));
            card.appendChild(winner);

            if (games.length > 1) {
                const rest = el('div', 'm-myitems');
                games.slice(1, 6).forEach((game, index) => {
                    const row = el('div', 'm-myitem');
                    row.appendChild(el('span', 'm-myitem__label', `${index + 2}. ${game.name}`));
                    row.appendChild(el('span', 'm-myitem__price', String(game.score)));
                    rest.appendChild(row);
                });
                card.appendChild(rest);
            }
        }

        if (state.isAdmin) {
            const del = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Supprimer de l\'historique');
            del.addEventListener('click', () => {
                confirmSheet('Supprimer cette LAN de l\'historique ?', 'Supprimer', () => {
                    db.ref(`lan/history/${id}`).remove()
                        .then(() => showToast('Supprimé de l\'historique.', 'success'))
                        .catch(e => showToast('Erreur : ' + e.message, 'error'));
                });
            });
            card.appendChild(del);
        }

        mount.appendChild(card);
    });
}

/* ==========================================================================
   Écran Administration
   ========================================================================== */

/* Confirmation en feuille glissante : window.confirm est bloqué par certains
   navigateurs mobiles et sort complètement de l'habillage de l'application. */
function confirmSheet(question, confirmLabel, onConfirm, danger) {
    openSheet(null, (body) => {
        body.appendChild(el('p', 'm-card__body', question));
        const actions = el('div', 'm-sheet__actions');
        const cancel = el('button', 'm-btn m-btn--quiet', 'Annuler');
        cancel.addEventListener('click', closeSheet);
        const ok = el('button', `m-btn ${danger ? 'm-btn--danger' : 'm-btn--solid'}`, confirmLabel);
        ok.addEventListener('click', () => { closeSheet(); onConfirm(); });
        actions.appendChild(cancel);
        actions.appendChild(ok);
        body.appendChild(actions);
    });
}

function knownPlayers() {
    const uids = new Set([...Object.keys(state.votes), ...Object.keys(state.status)]);
    return [...uids].map(uid => ({ uid, name: playerName(uid) }));
}

function sendNotification(targetUid, message, type = 'info') {
    return db.ref(`lan/notifications/${targetUid}`).push().set({
        message,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        read: false,
        type
    });
}

function renderAdmin() {
    if (!state.isAdmin) return;

    /* Liste des joueurs : on préserve la sélection en cours, sinon chaque
       mise à jour temps réel remettrait le menu sur le premier nom. */
    const select = $('m-role-user');
    const previous = select.value;
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choisir un joueur';
    select.appendChild(placeholder);
    knownPlayers().forEach(player => {
        const option = document.createElement('option');
        option.value = player.uid;
        const role = state.roles[player.uid];
        option.textContent = player.name + (role ? ` (${role})` : '');
        select.appendChild(option);
    });
    if (previous) select.value = previous;

    $('m-toggle-voting').textContent = state.settings.isVotingOpen ? 'Clore le vote' : 'Ouvrir le vote';
    $('m-finish-lan').style.display = state.settings.lanFinished ? 'none' : 'inline-flex';
    $('m-reopen-lan').style.display = state.settings.lanFinished ? 'inline-flex' : 'none';
}

$('m-broadcast-send').addEventListener('click', () => {
    const input = $('m-broadcast');
    const message = input.value.trim();
    if (!message) { showToast('Écris un message d\'abord.', 'error'); return; }
    const targets = knownPlayers();
    Promise.all(targets.map(p => sendNotification(p.uid, `🍊 Admin: ${message}`, 'alert')))
        .then(() => {
            showToast(`Message envoyé à ${targets.length} joueur${targets.length > 1 ? 's' : ''} !`, 'success');
            input.value = '';
        })
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
});

$('m-role-assign').addEventListener('click', () => {
    const uid = $('m-role-user').value;
    const role = $('m-role-type').value;
    if (!uid) { showToast('Choisis un joueur.', 'error'); return; }
    db.ref('lan/roles/' + uid).set(role)
        .then(() => showToast('Rôle mis à jour !', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
});

$('m-toggle-voting').addEventListener('click', () => {
    const opening = !state.settings.isVotingOpen;
    db.ref('lan/settings').update({ isVotingOpen: opening })
        .then(() => showToast(opening ? 'Le vote est ouvert.' : 'Le vote est clos.', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
});

$('m-finish-lan').addEventListener('click', () => {
    confirmSheet(
        'Terminer la soirée et afficher le bilan à tout le monde ? Aucune donnée n\'est effacée.',
        'Clôturer',
        () => {
            db.ref('lan/settings').update({
                isLanActive: false,
                lanFinished: true,
                lanClosedAt: firebase.database.ServerValue.TIMESTAMP
            }).then(() => {
                showToast('La LAN est terminée.', 'success');
                knownPlayers()
                    .filter(p => p.uid !== (state.user && state.user.uid))
                    .forEach(p => sendNotification(p.uid, '🏁 La LAN est terminée, le bilan est affiché !', 'alert'));
            }).catch(e => showToast('Erreur : ' + e.message, 'error'));
        }
    );
});

$('m-reopen-lan').addEventListener('click', () => {
    confirmSheet('Rouvrir cette LAN ? Tout le monde repasse en mode soirée.', 'Rouvrir', () => {
        recapShown = false;
        db.ref('lan/settings').update({ isLanActive: true, lanFinished: false })
            .then(() => { showToast('La LAN est rouverte.', 'success'); goto('soiree'); })
            .catch(e => showToast('Erreur : ' + e.message, 'error'));
    });
});

$('m-new-lan').addEventListener('click', () => {
    const newName = $('m-new-lan-name').value.trim();
    confirmSheet(
        'Archiver la soirée en cours puis repartir de zéro ? Les votes, événements, sondages, commandes, one-shots et bibliothèques sont effacés. Seule la carte des kocktails est conservée.',
        'Démarrer',
        () => startNewLan(newName),
        true
    );
});

/* Miroir de startNewLan de l'interface bureau : la soirée est archivée
   entière, puis tout ce qui lui appartient est effacé. */
async function startNewLan(newName) {
    try {
        const previousName = state.settings.lanName || 'LAN Demain';
        const sortedGames = calculateScores(state.votes);
        const events = state.events;
        const oneshot = (state.cocktails && state.cocktails.oneshot) || null;
        const hadContent = sortedGames.length > 0 || Object.keys(events).length > 0 || (oneshot && Object.keys(oneshot).length > 0);

        if (hadContent) {
            await db.ref('lan/history').push().set({
                name: previousName,
                date: new Date().toLocaleDateString('fr-FR'),
                timestamp: firebase.database.ServerValue.TIMESTAMP,
                topGames: sortedGames.slice(0, state.settings.topGamesCount || 10),
                votes: state.votes,
                events: Object.keys(events).length ? events : null,
                oneshotCocktails: oneshot
            });
        }

        await Promise.all([
            db.ref('lan/votes').remove(),
            db.ref('lan/events').remove(),
            db.ref('lan/cocktails/oneshot').remove(),
            db.ref('lan/cocktails/orders').remove(),
            db.ref('lan/polls').remove(),
            db.ref('lan/foodRuns').remove(),
            db.ref('lan/steamLibraries').remove()
        ]);

        const settings = { isVotingOpen: true, isLanActive: false, lanFinished: false };
        if (newName) settings.lanName = newName;
        await db.ref('lan/settings').update(settings);

        /* Le brouillon de vote appartenait à la soirée précédente. */
        voteDraft = null;
        recapShown = false;
        $('m-new-lan-name').value = '';
        showToast(sortedGames.length > 0
            ? `Nouvelle LAN lancée ! ${sortedGames.length} jeux archivés.`
            : 'Nouvelle LAN lancée ! Les votes sont ouverts.', 'success');
        goto('soiree');
    } catch (error) {
        showToast('Impossible de démarrer : ' + error.message, 'error');
    }
}

/* ==========================================================================
   Notifications
   ========================================================================== */

$('m-btn-notifs').addEventListener('click', () => {
    openSheet('Notifications', (body) => {
        const list = Object.entries(state.notifs)
            .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
        if (!list.length) {
            body.appendChild(emptyState('Aucune notification.'));
            return;
        }
        list.slice(0, 20).forEach(([, notif]) => {
            const row = el('div', 'm-notif');
            row.appendChild(el('p', `m-notif__msg${notif.read ? ' m-notif__msg--read' : ''}`, notif.message || ''));
            row.appendChild(el('span', 'm-notif__time', timeAgo(notif.timestamp)));
            body.appendChild(row);
        });

        const user = auth.currentUser;
        if (user) {
            const updates = {};
            Object.keys(state.notifs).forEach(id => {
                if (!state.notifs[id].read) updates[`${id}/read`] = true;
            });
            if (Object.keys(updates).length) {
                db.ref(`lan/notifications/${user.uid}`).update(updates).catch(() => { });
            }
        }
    });
});

/* ==========================================================================
   Bilan de fin de LAN
   ========================================================================== */

function renderRecap() {
    const mount = $('m-recap');
    mount.innerHTML = '';
    const box = el('div', 'm-recap');

    const hero = el('div', 'm-recap__hero');
    hero.appendChild(el('h2', 'm-recap__title', state.settings.lanName || 'LAN Demain'));
    hero.appendChild(el('p', 'm-recap__sub', state.settings.lanClosedAt ? `Terminée ${timeAgo(state.settings.lanClosedAt)}` : 'C\'est terminé.'));
    box.appendChild(hero);

    if (state.scores.length) {
        const section = el('div', 'm-section');
        const head = el('div', 'm-section__head');
        head.appendChild(el('h2', 'm-section__title', 'Le podium'));
        section.appendChild(head);
        section.appendChild(buildRankList(state.scores.slice(0, 3)));
        box.appendChild(section);
    }

    const stats = el('div', 'm-card');
    const rows = [
        ['Joueurs', Object.keys(state.votes).length],
        ['Jeux proposés', state.scores.length],
        ['Événements', sortedEvents().length],
        ['Sondages', Object.keys(state.polls).length],
        ['Commandes', Object.keys(state.foodRuns).length]
    ];
    rows.forEach(([label, value]) => {
        const row = el('div', 'm-stat');
        row.appendChild(el('span', 'm-stat__label', label));
        row.appendChild(el('span', 'm-stat__value', String(value)));
        stats.appendChild(row);
    });
    box.appendChild(stats);
    mount.appendChild(box);
}

/* ==========================================================================
   Câblage final
   ========================================================================== */

document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-goto]');
    if (nav) { goto(nav.dataset.goto); return; }
    if (e.target.closest('[data-sheet-close]')) closeSheet();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
});

loadThumbStore();
