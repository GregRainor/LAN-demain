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

/* L'interface est désormais choisie uniquement d'après l'appareil. Cette
   suppression répare aussi les téléphones restés prisonniers d'un ancien
   cookie « version bureau ». */
document.cookie = 'lan_vue=; path=/; max-age=0; samesite=lax';

const state = {
    user: null,
    isAdmin: false,
    isMixologist: false,
    isGamemaster: false,
    settings: { isVotingOpen: false, isLanActive: false, lanFinished: false, lanName: 'LAN Demain', topGamesCount: 10 },
    votes: {},
    roles: {},
    status: {},
    profiles: {},
    polls: {},
    foodRuns: {},
    events: {},
    cocktails: {},
    economy: {},
    /* Le set, les paquets et les échanges. Aucune collection n'y est stockée :
       elle se rejoue depuis les paquets ouverts (core.js). */
    tcg: {},
    /* Expérience et hauts faits. Ce nœud ne repart JAMAIS à zéro : c'est ce
       qui distingue l'assiduité de la fortune. */
    xp: {},
    /* Défis, réclamations et boîte à idées. Un défi ne se calcule pas : c'est
       un humain qui tranche, et c'est la seule source d'XP qui se rejoue. */
    quests: { challenges: {}, claims: {}, suggestions: {} },
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
let myConnectionKey = null;
let firebaseConnected = false;
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

/* Le nom d'un joueur, par ordre d'autorité. `lan/users` passe devant tout le
   reste depuis qu'il est éditable : c'est le nom que le joueur a choisi, et il
   doit l'emporter sur celui que Google lui donne. */
function playerName(uid) {
    if (state.profiles[uid] && state.profiles[uid].name) return state.profiles[uid].name;
    if (state.votes[uid] && state.votes[uid].name) return state.votes[uid].name;
    const identity = statusIdentity(state.status[uid]);
    if (identity && identity.name) return identity.name;
    if (uid === (state.user && state.user.uid)) return state.user.displayName || 'Moi';
    return 'Un joueur';
}

function playerPhoto(uid) {
    /* Toutes ces URL viennent de la base, donc d'un autre joueur : elles
       passent par safeAvatarUrl, qui n'accepte que les hôtes de photos de
       profil. Voir core.js. */
    const fallback = fallbackAvatar(playerName(uid));
    const identity = statusIdentity(state.status[uid]);
    if (identity && (identity.photo || identity.avatar)) {
        return safeAvatarUrl(identity.photo || identity.avatar, fallback);
    }
    /* Fiche durable : elle survit à la déconnexion, contrairement à /status. */
    const profile = state.profiles[uid];
    if (profile && profile.avatar) return safeAvatarUrl(profile.avatar, fallback);
    if (uid === (state.user && state.user.uid) && state.user.photoURL) return state.user.photoURL;
    return fallback;
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

const TABS = ['soiree', 'jeux', 'boutique', 'cartes', 'plus'];

const SCREEN_TITLES = {
    vote: 'Mon vote',
    cartes: 'Mes cartes',
    'hauts-faits': 'Hauts faits',
    defis: 'Défis',
    miam: 'Les Fins Gourmets',
    sondages: 'Sondages',
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
const LAN_SCREENS = ['miam', 'sondages', 'evenements', 'kocktails', 'boutique'];

function screenAvailable(screen) {
    const p = phase();
    if (LAN_SCREENS.includes(screen)) return p === 'lan';
    if (screen === 'vote') return p === 'vote';
    if (screen === 'bilan') return p === 'finished';
    /* Les cartes restent consultables hors soirée : une collection qui
       disparaît entre deux LAN ne se collectionne pas. */
    return true; // soiree, jeux, plus, cartes, biblio, historique, admin
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

/* Une destination peut devenir indisponible pendant que son entrée existe
   encore dans l'historique du navigateur. Le repli doit toujours être une
   vraie racine accessible, jamais un écran interne qui ajouterait une seconde
   impasse au bouton Retour. */
function phaseFallbackScreen() {
    return phase() === 'finished' ? 'bilan' : 'soiree';
}

function repairUnavailableNavigation() {
    const fallback = phaseFallbackScreen();
    history.replaceState({ screen: fallback }, '');
    goto(fallback, { fromHistory: true, silent: true });
}

function goto(screen, options) {
    const opts = options || {};

    if (!screenAvailable(screen)) {
        const reason = lockReason(screen);
        if (reason && !opts.silent) showToast(reason, 'error');
        /* Un bouton verrouillé ne crée aucune entrée. En revanche, un ancien
           état de l'historique peut toujours pointer vers cet écran : on le
           remplace alors par une racine saine pour que Retour reste fiable. */
        if (opts.fromHistory) repairUnavailableNavigation();
        return false;
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
    if (screen === 'cartes') renderCartes();
    if (screen === 'biblio') renderLibraries();
    if (screen === 'admin') renderAdmin();
    if (screen === 'hauts-faits') renderHautsFaits();
    if (screen === 'defis') renderDefis();
    return true;
}

$('m-back').addEventListener('click', () => history.back());

/* Le titre de la LAN ramène à l'accueil, comme le logo de n'importe quel site.
   Même geste que la marque cliquable du bureau. Une feuille ouverte par-dessus
   se ferme d'abord, sinon on reviendrait à l'accueil derrière un panneau resté
   en place. */
$('m-brand').addEventListener('click', () => {
    closeSheet();
    goto('soiree');
});

window.addEventListener('popstate', (e) => {
    const screen = (e.state && e.state.screen) || 'soiree';
    goto(screen, { fromHistory: true, silent: true });
});

/* ==========================================================================
   Feuille glissante
   ========================================================================== */

/* La poignée en haut de la feuille annonçait un geste qui n'existait pas :
   on pouvait la saisir, rien ne suivait le doigt. On la rend vraie.

   Le geste part de la poignée ou de l'en-tête, jamais du corps : celui-ci
   défile, et une fiche Signature longue doit pouvoir se parcourir sans que
   chaque glissement vers le bas referme la feuille. Sous le tiers de la
   hauteur — ou en dessous d'un geste franc — la feuille revient en place. */
function attachSheetDrag() {
    const sheet = $('m-sheet');
    const panel = sheet.querySelector('.m-sheet__panel');
    const handles = [sheet.querySelector('.m-sheet__grab'), $('m-sheet-head')];

    let startY = 0;
    let startedAt = 0;
    let offset = 0;
    let dragging = false;

    const move = (y) => {
        // Vers le bas seulement : tirer vers le haut ne doit pas décoller la feuille.
        offset = Math.max(0, y - startY);
        panel.style.transform = 'translateY(' + offset + 'px)';
    };

    const end = () => {
        if (!dragging) return;
        dragging = false;
        panel.style.transition = '';
        panel.style.animation = '';

        const far = offset > panel.offsetHeight / 3;
        const flick = offset > 60 && (Date.now() - startedAt) < 300;
        if (far || flick) {
            closeSheet();
        }
        // Dans tous les cas on rend la main au CSS : closeSheet masque la
        // feuille, et une réouverture doit repartir de sa position normale.
        panel.style.transform = '';
        offset = 0;
    };

    handles.forEach(handle => {
        if (!handle) return;
        handle.addEventListener('touchstart', (e) => {
            dragging = true;
            startY = e.touches[0].clientY;
            startedAt = Date.now();
            offset = 0;
            // L'animation d'ouverture se rejouerait sous le doigt.
            panel.style.animation = 'none';
            panel.style.transition = 'none';
        }, { passive: true });

        handle.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            move(e.touches[0].clientY);
        }, { passive: true });

        handle.addEventListener('touchend', end);
        handle.addEventListener('touchcancel', end);
    });
}

function openSheet(heading, buildBody) {
    const sheet = $('m-sheet');
    const body = $('m-sheet-body');
    const head = $('m-sheet-head');
    body.innerHTML = '';
    body.classList.remove('m-sheet__body--profile');
    if (heading) {
        head.style.display = 'flex';
        $('m-sheet-heading').textContent = heading;
    } else {
        head.style.display = 'none';
    }
    buildBody(body);
    /* La Signature est volontairement une grande feuille. Sa hauteur bornée
       donne au corps flex une vraie zone à faire défiler ; un simple
       max-height laissait son contenu conserver sa hauteur intrinsèque. */
    sheet.classList.toggle('m-sheet--profile', body.classList.contains('m-sheet__body--profile'));
    sheet.classList.add('is-open');
    /* Une feuille réutilise toujours le même corps. Sans remise à zéro, une
       fiche longue pouvait se rouvrir au milieu de son contenu. */
    body.scrollTop = 0;
}

function closeSheet() {
    $('m-sheet').classList.remove('is-open', 'm-sheet--profile');
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

$('m-profile-trigger').addEventListener('click', () => {
    const user = state.user || auth.currentUser;
    if (user) openProfile(user.uid);
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

/* Le second callback de .on() manquait : quand une lecture échouait (règle
   refusée, jeton expiré, transport bloqué), l'écran restait vide sans le
   moindre message. On le dit désormais, une fois par chemin — une coupure les
   fait tous échouer d'un coup et répéter le même toast n'apprend rien. */
const reportedDbErrors = new Set();

function watch(path, handler) {
    const ref = db.ref(path);
    ref.on('value', snapshot => {
        handler(snapshot.val());
        if (state.ready) renderAll();
    }, error => {
        console.error('Lecture Firebase refusée :', path, error);
        if (reportedDbErrors.has(path)) return;
        reportedDbErrors.add(path);
        showToast(`Base de données inaccessible (${error.code || 'erreur'}).`, 'error');
    });
    refs.push(ref);
    return ref;
}

/* Un transport bloqué (extension, CSP, navigateur en mode strict) ne lève
   aucune erreur : la connexion reste en attente et l'application paraît vide
   sans raison. Au bout de dix secondes, on le dit. */
function watchConnection() {
    setTimeout(() => {
        if (firebaseConnected) return;
        console.error('Aucune connexion à la Realtime Database après 10 s.');
        showToast("Connexion impossible. Un bloqueur de contenu ou le mode strict du navigateur peut en être la cause.", 'error');
    }, 10000);
}

function writeMyPresence(user) {
    if (!myConnectionRef || !user) return;
    myConnectionRef.onDisconnect().remove();
    myConnectionRef.set({
        state: 'online',
        name: user.displayName || user.email,
        photo: user.photoURL || null,
        device: 'téléphone'
    });
}

/* Un appareil resté sur une version antérieure efface /status/{uid} en entier
   en se fermant, emportant les sessions des autres appareils du même joueur.
   Si la nôtre a disparu alors qu'on est toujours connecté, on se réinscrit. */
function reassertPresence() {
    const user = auth.currentUser;
    if (!user || !firebaseConnected || !myConnectionRef) return;
    const node = state.status[user.uid];
    if (node && node[myConnectionKey]) return;
    if (node && typeof node.name === 'string') return;
    writeMyPresence(user);
}

function boot(user) {
    /* Une clé par session : le même joueur ouvre souvent le téléphone en plus
       du PC, et fermer l'un effaçait la présence de l'autre. */
    myConnectionRef = db.ref('/status/' + user.uid).push();
    myConnectionKey = myConnectionRef.key;
    watchConnection();
    db.ref('.info/connected').on('value', snap => {
        firebaseConnected = snap.val() === true;
        if (!firebaseConnected) return;
        writeMyPresence(user);
        /* Fiche durable : /status s'efface en partant, mais le bureau affiche
           les votants absents et a besoin de leur photo. */
        /* Le nom n'est PLUS écrasé à chaque connexion : il est éditable dans
           le profil, et le réécrire depuis Google effacerait le choix du
           joueur. On ne le pose qu'à la première venue. */
        const profileRef = db.ref('lan/users/' + user.uid);
        profileRef.update({
            avatar: user.photoURL || '',
            lastSeen: Date.now()
        }).catch(() => { /* profil non critique */ });
        profileRef.child('name').once('value')
            .then(snap => {
                if (!snap.exists() || !snap.val()) {
                    profileRef.child('name').set(user.displayName || user.email || '');
                }
            })
            .catch(() => { /* profil non critique */ });
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
        /* Le maître du jeu tient la boutique : il crédite, valide les achats et
           range la carte. L'admin l'est d'office, pour qu'une soirée ne se
           bloque pas si le maître du jeu est parti dormir. */
        state.isGamemaster = isGamemaster(myRole, user.uid, ADMIN_UID);
        $('m-plus-role').textContent = state.isAdmin ? 'Admin'
            : (state.isMixologist ? 'Mixologue' : (state.isGamemaster ? 'Maître du jeu' : ''));
    });
    watch('/status', value => { state.status = value || {}; reassertPresence(); });
    watch('lan/users', value => { state.profiles = value || {}; });
    watch('lan/polls', value => { state.polls = value || {}; });
    watch('lan/foodRuns', value => { state.foodRuns = value || {}; });
    watch('lan/events', value => { state.events = value || {}; });
    watch('lan/cocktails', value => { state.cocktails = value || {}; });
    watch('lan/economy', value => { state.economy = value || {}; sealBoughtPacks(); });
    watch('lan/tcg', value => { state.tcg = value || {}; sealBoughtPacks(); });
    watch('lan/steamLibraries', value => { state.libraries = value || {}; });
    watch('lan/history', value => { state.history = value || {}; });
    watch('lan/xp', value => { state.xp = value || {}; grantPendingAchievements(); });
    watch('lan/challenges', value => { state.quests.challenges = value || {}; });
    watch('lan/claims', value => { state.quests.claims = value || {}; });
    watch('lan/suggestions', value => { state.quests.suggestions = value || {}; });
    watch(`lan/notifications/${user.uid}`, value => { state.notifs = value || {}; });

    startTickEngine();

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
    /* Le rejeu des cartes est recalculé une fois par passe, pas une fois par
       section : c'est le seul calcul de ce fichier qui parcourt tout. */
    tcgView = null;
    renderHeader();
    renderPresence();
    renderEditorialHome();
    renderWhenWhere();
    renderSealedTeaser();
    renderSoiree();
    renderPolls();
    renderFood();
    renderEvents();
    renderKocktails();
    renderBoutique();
    if (currentScreen === 'hauts-faits') renderHautsFaits();
    if (currentScreen === 'defis') renderDefis();
    grantPendingAchievements();
    renderCartes();
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
    const schedule = describeLanSchedule(state.settings, new Date());
    const meta = [];
    if (schedule && schedule.when) meta.push(schedule.when);
    if (schedule && schedule.place) meta.push(schedule.place);
    $('m-lan-meta').textContent = meta.length ? meta.join(' · ') : 'La prochaine nuit';
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

    /* Les absents restent affichés, cerclés de gris : comme sur le PC, on veut
       voir d'un coup d'œil qui manque, pas seulement qui est là. On prend tous
       ceux qu'on connaît et on laisse isRostered trancher — se limiter aux
       votants effaçait le joueur passé dans la journée sans voter. */
    const sources = { status: state.status, votes: state.votes, profiles: state.profiles };
    const everyone = {};
    [state.status, state.votes, state.profiles].forEach(source => {
        Object.keys(source || {}).forEach(uid => { everyone[uid] = true; });
    });
    const away = Object.keys(everyone)
        .filter(uid => !online.includes(uid) && isRostered(uid, sources));
    const accentData = achData();
    [...online.map(uid => [uid, true]), ...away.map(uid => [uid, false])]
        .slice(0, 6)
        .forEach(([uid, isOnline]) => {
            const img = el('img', isOnline ? 'm-presence__face is-online' : 'm-presence__face is-offline');
            img.src = playerPhoto(uid);
            img.alt = `${playerName(uid)} — ${isOnline ? 'connecté' : 'déconnecté'}`;
            /* La couleur du titre équipé, en liseré : elle ne se voyait que sur
               sa propre carte Signature. Voir playerAccent (core.js). */
            const accent = playerAccent(accentData, uid);
            if (accent && accent.accent) {
                img.style.setProperty('--face-accent', accent.accent);
                img.classList.add('has-accent');
                img.alt += ` · ${accent.label}`;
            }
            img.title = img.alt;
            /* Un visage ouvre la fiche : c'est le chemin le plus court vers
               « qui est ce joueur, et qu'a-t-il fait ». */
            img.addEventListener('click', () => openProfile(uid));
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
    const openPolls = screenAvailable('sondages')
        ? visiblePolls().filter(([, poll]) => !isPollClosed(poll)).length : 0;
    const moreDot = $('m-tab-more');
    const moreCount = openRuns + openPolls;
    moreDot.style.display = moreCount ? 'grid' : 'none';
    moreDot.textContent = moreCount;

    /* La pastille de la boutique ne parle qu'au maître du jeu : pour tous les
       autres, une file d'attente n'est pas une nouvelle à traiter. */
    const waiting = (state.isGamemaster && screenAvailable('boutique'))
        ? pendingPurchases(state.economy).length : 0;
    const shopDot = $('m-tab-shop');
    shopDot.style.display = waiting ? 'grid' : 'none';
    shopDot.textContent = waiting;
}

/* Grise ET désactive toutes les destinations qui n'appartiennent pas à la
   phase en cours. Un simple aspect grisé laissait encore le bouton focusable
   et cliquable ; avec l'historique du téléphone, cela pouvait fabriquer une
   route sans écran visible. */
function renderLocks() {
    document.querySelectorAll('[data-goto]').forEach(control => {
        const target = control.dataset.goto;
        const locked = !screenAvailable(target);
        control.classList.toggle('is-locked', locked);
        control.setAttribute('aria-disabled', locked ? 'true' : 'false');
        if ('disabled' in control) control.disabled = locked;
        if (locked) control.dataset.lockReason = lockReason(target);
        else delete control.dataset.lockReason;

        const hint = control.querySelector('.m-list__hint');
        if (hint && locked) hint.textContent = 'plus tard';
    });

    /* Si la phase change pendant qu'on est sur un écran devenu interdit
       (un admin clôt le vote), on ramène le joueur là où ça a du sens. */
    if (!screenAvailable(currentScreen)) {
        repairUnavailableNavigation();
    }
}

/* ==========================================================================
   Écran Soirée
   ========================================================================== */

/* Traduction mobile du cadrage éditorial du bureau. Un même composant raconte
   les quatre états de la LAN ; seules les données et l'action changent. */
function renderEditorialHome() {
    const p = phase();
    const hero = $('m-editorial');
    const schedule = describeLanSchedule(state.settings, new Date());
    const voterTotal = Object.keys(state.votes).length;
    const gameTotal = state.scores.length;
    const onlineTotal = Object.keys(state.status).filter(uid => statusIdentity(state.status[uid])).length;
    const eventTotal = Object.keys(state.events).length;
    const lanTotal = Object.keys(state.history).length;
    const knownPlayers = new Set([
        ...Object.keys(state.status),
        ...Object.keys(state.votes),
        ...Object.keys(state.profiles)
    ]).size;

    const views = {
        waiting: {
            kicker: 'Entre deux nuits',
            title: schedule ? 'Le prochain rendez-vous est posé.' : 'La prochaine nuit se prépare.',
            copy: schedule
                ? 'La date est annoncée. Revenez ici quand le conseil ouvrira les votes.'
                : 'Les archives restent ouvertes pendant que l’admin prépare le prochain chapitre.',
            stats: [[knownPlayers || '—', 'Joueurs'], [lanTotal, 'LAN'], [(schedule && schedule.countdown) || 'À fixer', 'Prochaine']],
            action: state.isAdmin ? ['Préparer la prochaine LAN', 'admin'] : ['Voir les archives', 'historique']
        },
        vote: {
            kicker: 'Le conseil d’avant-LAN',
            title: 'Composez la prochaine nuit.',
            copy: 'Chaque priorité pèse vraiment dans la sélection. Votez, observez la tendance, puis préparez ce qui monte.',
            stats: [[voterTotal, 'Votants'], [gameTotal, 'Jeux'], [(schedule && schedule.countdown) || 'Ouvert', 'Échéance']],
            action: ['Composer mon bulletin', 'vote']
        },
        lan: {
            kicker: 'La soirée est lancée',
            title: 'Autour de la table.',
            copy: 'Le programme, les défis et les décisions du groupe vivent ici pendant toute la nuit.',
            stats: [[onlineTotal, 'En ligne'], [eventTotal, 'Événements'], [gameTotal, 'Jeux retenus']],
            action: ['Voir le programme', 'evenements']
        },
        finished: {
            kicker: 'Le lendemain',
            title: 'La nuit laisse une trace.',
            copy: 'Le podium est figé, les hauts faits restent et la prochaine LAN peut déjà commencer à se raconter.',
            stats: [[voterTotal, 'Votants'], [gameTotal, 'Jeux'], [eventTotal, 'Événements']],
            action: ['Voir le bilan', 'bilan']
        }
    };
    const view = views[p] || views.waiting;

    if (hero.dataset.phase !== p) {
        hero.dataset.phase = p;
        hero.classList.remove('is-phase-changing');
        void hero.offsetWidth;
        hero.classList.add('is-phase-changing');
    }
    $('m-editorial-kicker').textContent = view.kicker;
    $('m-editorial-title').textContent = view.title;
    $('m-editorial-copy').textContent = view.copy;
    view.stats.forEach((stat, index) => {
        $('m-overview-value-' + (index + 1)).textContent = String(stat[0]);
        $('m-overview-label-' + (index + 1)).textContent = stat[1];
    });
    const action = $('m-editorial-action');
    action.textContent = view.action[0];
    action.dataset.goto = view.action[1];
    action.disabled = !screenAvailable(view.action[1]);
}

/* Quand & où : la seule question qui compte avant que la LAN démarre, donc
   affichée sur Soirée, dans toutes les phases. */
function renderWhenWhere() {
    const section = $('m-when-where-section');
    const mount = $('m-when-where');
    if (!section || !mount) return;
    mount.innerHTML = '';

    const schedule = describeLanSchedule(state.settings, new Date());

    if (!schedule) {
        // Rien d'annoncé : seul l'admin voit le rappel, les autres n'ont pas à
        // contempler un cadre vide.
        if (!state.isAdmin) { section.style.display = 'none'; return; }
        section.style.display = 'flex';
        mount.appendChild(emptyState('Ni date ni lieu annoncés. À renseigner dans Admin › Quand et où.'));
        return;
    }

    section.style.display = 'flex';

    const card = el('article', 'm-card');
    const top = el('div', 'm-card__top');
    top.appendChild(el('h3', 'm-card__title', schedule.when || 'Date encore à fixer'));
    if (schedule.countdown) {
        const imminent = schedule.state === 'live' || schedule.state === 'today';
        top.appendChild(el('span', `m-chip ${imminent ? 'm-chip--live' : 'm-chip--gold'}`, schedule.countdown));
    }
    card.appendChild(top);

    if (schedule.time) card.appendChild(el('p', 'm-card__body', `🕒 dès ${schedule.time}`));
    if (schedule.place) card.appendChild(el('p', 'm-card__body', `📍 ${schedule.place}`));

    if (schedule.startKey) {
        const add = el('button', 'm-btn m-btn--quiet m-btn--full', '📆 Ajouter à mon agenda');
        add.addEventListener('click', downloadLanIcs);
        card.appendChild(add);
    }

    mount.appendChild(card);
}

// Fichier .ics : chacun pose la LAN dans son propre agenda et n'a plus à se
// souvenir de la date.
function downloadLanIcs() {
    const ics = buildLanIcs(state.settings);
    if (!ics) { showToast("Aucune date n'est encore annoncée.", 'error'); return; }

    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(state.settings.lanName || 'LAN Demain').replace(/[^\w\- ]+/g, '').trim() || 'lan'}.ics`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Certains navigateurs n'ont pas fini de lire le blob au retour du clic.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

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

    /* Prochain événement : lui aussi appartient à la soirée. On montre celui
       qui reste à venir, pas le premier de la liste : à 23 h, annoncer le
       tournoi de 20 h n'aide personne. */
    const days = evening ? agendaDays() : [];
    const total = flattenAgenda(days).length;
    const next = evening ? nextEventInAgenda(days, new Date()) : null;
    const nextBox = $('m-next-event');
    nextBox.innerHTML = '';
    if (next) {
        nextBox.appendChild(buildEventCard(next, { isNext: true, showDay: true }));
        $('m-next-section').style.display = 'flex';
        $('m-events-count').textContent = `${total} au programme`;
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
            // voteList plutôt qu'un test de tableau : une priorité revenue en
            // objet (clés non contiguës) était jetée en silence.
            draft[p.key] = voteList(mine.votes[p.key]);
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

/* Les jeux déjà proposés par le groupe, offerts en complétion à la frappe. */
function refreshGameDatalist() {
    const datalist = $('m-voted-games');
    if (!datalist) return;
    datalist.replaceChildren();
    (state.scores || []).forEach(game => {
        const option = document.createElement('option');
        option.value = game.name;
        datalist.appendChild(option);
    });
}

function renderVote() {
    if (voteDraft === null) voteDraft = readMyVote();
    refreshGameDatalist();
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
            /* Complétion sur ce que le groupe a déjà proposé : deux
               orthographes du même jeu le comptaient comme deux jeux. */
            input.setAttribute('list', 'm-voted-games');
            input.autocomplete = 'off';
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

    /* « Reprendre mon bulletin de la dernière LAN » : beaucoup de jeux
       reviennent d'une soirée à l'autre, et les retaper au pouce décourage de
       voter. On remplit le brouillon sans l'enregistrer — le joueur relit,
       ajuste, puis soumet. */
    const reuse = $('m-vote-reuse');
    const previous = open ? lastBallotFor(state.history, state.user && state.user.uid) : null;
    if (reuse) {
        reuse.style.display = previous ? 'block' : 'none';
        if (previous) {
            reuse.textContent = '↺ Reprendre mes ' + previous.count + ' jeux de « ' + previous.name + ' »';
            reuse.onclick = () => {
                if (total > 0 && !window.confirm('Ton vote en cours sera remplacé par celui de « ' + previous.name + ' ».')) return;
                voteDraft = {
                    p1: previous.votes.p1.slice(0, 1),
                    p2: previous.votes.p2.slice(),
                    p3: previous.votes.p3.slice(),
                    p_other: previous.votes.p_other.slice()
                };
                renderVote();
                showToast('Bulletin repris — relis-le puis enregistre.', 'success');
            };
        }
    }

    /* Ce que la base contient vraiment, à côté du brouillon en cours : c'est ce
       qui rend visible un écart entre deux appareils. */
    const stored = ((state.votes[state.user && state.user.uid] || {}).votes) || {};
    const storedTotal = ['p1', 'p2', 'p3', 'p_other']
        .reduce((n, key) => n + voteList(stored[key]).length, 0);

    $('m-vote-count').textContent = storedTotal === total
        ? `${total} jeu${total > 1 ? 'x' : ''}`
        : `${total} en cours · ${storedTotal} enregistré${storedTotal > 1 ? 's' : ''}`;
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

/* Le regroupement par jour, l'ordre (une LAN passe minuit) et le « c'est
   passé » vivent dans core.js : le programme doit se lire à l'identique sur
   téléphone et sur PC. */
function agendaDays() {
    return buildAgenda(state.events, state.settings.lanDate || '');
}

function sortedEvents() {
    return flattenAgenda(agendaDays());
}

function buildEventCard(evt, flags) {
    const options = flags || {};
    const id = evt.id;
    const uid = state.user && state.user.uid;
    const rsvps = evt.rsvps || {};
    const accepted = Object.values(rsvps).filter(v => v === 'accepted').length;
    const mine = rsvps[uid];

    const card = el('article', `m-card${options.isPast ? ' is-past' : ''}`);
    const top = el('div', 'm-card__top');
    top.appendChild(el('h3', 'm-card__title', evt.title || 'Événement'));
    if (options.isNext) top.appendChild(el('span', 'm-chip m-chip--live', 'à suivre'));
    if (evt.time) top.appendChild(el('span', 'm-chip m-chip--gold', evt.time));
    card.appendChild(top);

    /* Le jour ne s'affiche que hors du programme, où aucun titre de journée ne
       le porte déjà — et seulement s'il diffère de celui de la LAN : sur une
       soirée d'un seul soir, le répéter est du bruit. */
    const dayKey = evt.dayKey || eventDayKey(evt, state.settings.lanDate || '');
    if (options.showDay && dayKey && dayKey !== (state.settings.lanDate || '')) {
        card.appendChild(el('p', 'm-card__meta', `📅 ${formatDayLabel(dayKey, new Date())}`));
    }

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

/* Le repère « maintenant » : sans lui, une liste d'heures ne dit pas où on
   en est de la soirée. */
function nowMarker(now) {
    const pad = (n) => String(n).padStart(2, '0');
    const row = el('div', 'm-now');
    row.appendChild(el('span', 'm-now__label', `maintenant · ${pad(now.getHours())}:${pad(now.getMinutes())}`));
    return row;
}

function renderEvents() {
    const mount = $('m-events');
    mount.innerHTML = '';

    const now = new Date();
    const days = agendaDays();
    if (!days.length) {
        mount.appendChild(emptyState('Aucun événement au programme.'));
        return;
    }

    const today = currentDayKey(now);
    const nowOrder = nowNightMinutes(now);
    const next = nextEventInAgenda(days, now);

    days.forEach(day => {
        const section = el('div', 'm-section');
        const head = el('div', 'm-section__head');
        head.appendChild(el('h3', 'm-section__title', formatDayLabel(day.dayKey, now)));
        head.appendChild(el('span', 'm-card__meta', `${day.events.length} événement${day.events.length > 1 ? 's' : ''}`));
        section.appendChild(head);

        // Le trait n'a de sens que sur la journée en cours.
        let markerPlaced = !(day.dayKey && day.dayKey === today);
        day.events.forEach(evt => {
            if (!markerPlaced && evt.order !== null && evt.order > nowOrder) {
                section.appendChild(nowMarker(now));
                markerPlaced = true;
            }
            section.appendChild(buildEventCard(evt, {
                isPast: isEventPast(evt, now),
                isNext: !!next && next.id === evt.id
            }));
        });
        // Tout est déjà passé : le trait ferme la journée.
        if (!markerPlaced) section.appendChild(nowMarker(now));

        mount.appendChild(section);
    });
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

        /* Jour pré-rempli avec la date de la LAN : l'écrasante majorité des
           événements s'y déroule, et le laisser vide les jetait « sans date ». */
        const date = el('input', 'm-input');
        date.type = 'date';
        date.setAttribute('aria-label', 'Jour');
        date.value = state.settings.lanDate || '';
        body.appendChild(date);

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
                date: date.value || '',
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
    const openRuns = Object.entries(state.foodRuns).filter(([, run]) => !isRunClosed(run)).length;
    $('m-plus-miam').textContent = openRuns ? `${openRuns} ouverte${openRuns > 1 ? 's' : ''}` : '';
    const openPolls = visiblePolls().filter(([, poll]) => !isPollClosed(poll)).length;
    $('m-plus-sondages').textContent = openPolls ? `${openPolls} en cours` : '';
    const view = tcgSnapshot();
    const sealed = view.uid ? sealedPacksOf(state.tcg, view.uid).length : 0;
    const progress = setProgress(view.setCards, view.cards, view.uid);
    $('m-plus-cartes').textContent = sealed
        ? `${sealed} booster${sealed > 1 ? 's' : ''} à ouvrir`
        : (progress.total ? `${progress.owned}/${progress.total}` : '');
    /* La rangée « Hauts faits » montre le niveau : c'est le chiffre qui
       progresse d'une soirée à l'autre, celui qu'on vient vérifier. */
    const myXp = xpLevel(xpTotal(state.xp, view.uid));
    $('m-plus-hauts-faits').textContent = 'Niveau ' + myXp.level;
    /* La rangée « Défis » compte ce qui attend l'admin, sinon ce qui est
       ouvert : on montre l'action, pas le catalogue. */
    const waitingClaims = state.isGamemaster ? pendingClaims(state.quests).length : 0;
    const openCount = openChallenges(state.quests).length;
    $('m-plus-defis').textContent = waitingClaims
        ? waitingClaims + ' à valider'
        : (openCount ? String(openCount) : '');
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
            avatar.src = safeAvatarUrl(lib.avatar, fallbackAvatar(lib.personaName));
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

/* L'expéditeur est inscrit DANS la clé, pas seulement dans le corps : les
   règles Firebase exigent que `lan/notifications/<cible>/<clé>` commence par
   l'uid de celui qui écrit. Un champ `senderId` seul se laissait omettre, et
   une notif sans expéditeur passait. Une clé, elle, ne s'omet pas. */
function sendNotification(targetUid, message, type = 'info') {
    const user = auth.currentUser;
    if (!user) return Promise.resolve();

    const notifId = user.uid + '__' + db.ref().push().key;
    return db.ref(`lan/notifications/${targetUid}/${notifId}`).set({
        message,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        read: false,
        type,
        senderId: user.uid
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

    /* Champs « quand & où » : on ne réécrit pas par-dessus une saisie en
       cours, la mise à jour temps réel arrive pendant que l'admin tape. */
    document.querySelectorAll('[data-schedule]').forEach(input => {
        if (document.activeElement === input) return;
        input.value = state.settings[input.dataset.schedule] || '';
    });
}

$('m-schedule-save').addEventListener('click', () => {
    const update = {};
    document.querySelectorAll('[data-schedule]').forEach(input => {
        update[input.dataset.schedule] = input.value.trim();
    });

    if (update.lanEndDate && update.lanDate && update.lanEndDate < update.lanDate) {
        showToast('La date de fin tombe avant le début.', 'error');
        return;
    }

    db.ref('lan/settings').update(update)
        .then(() => showToast('Date et lieu annoncés à tout le monde.', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
});

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
        'Archiver la soirée en cours puis repartir de zéro ? Les votes, événements, sondages, commandes, one-shots et bibliothèques sont effacés. La carte des kocktails est conservée, ainsi que les cartes à collectionner : une collection ne se réinitialise pas.',
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
   Boutique
   Le solde n'est jamais stocké : il se recalcule depuis le registre et le
   compteur de présence (core.js). Ici on n'écrit que deux choses — une tranche
   de présence, et une demande d'achat. Tout le reste passe par un maître du
   jeu, parce que rien de ce qu'un joueur écrit ne doit pouvoir l'enrichir.
   ========================================================================== */

/* Le gain passif. Les règles Firebase imposent le rythme et le plafond ; ce
   minuteur ne fait que proposer une tranche quand elle est due. Une tentative
   trop tôt, ou depuis un second appareil du même joueur, est refusée par la
   base — c'est voulu : on gagne par joueur, pas par écran ouvert. */
let tickTimer = null;

function claimTick() {
    const user = state.user;
    if (!user || !state.settings.isLanActive) return;

    const node = (state.economy.ticks || {})[user.uid] || null;
    const count = Number(node && node.count) || 0;
    if (count >= ECONOMY.MAX_TICKS) return;

    const last = Number(node && node.lastTick) || 0;
    /* Une petite marge : l'horloge du téléphone avance rarement comme celle du
       serveur, et une tentative en avance est rejetée pour rien. */
    if (last && Date.now() - last < ECONOMY.TICK_INTERVAL_MS + 2000) return;

    db.ref('lan/economy/ticks/' + user.uid).set({
        count: count + 1,
        lastTick: firebase.database.ServerValue.TIMESTAMP
    }).catch(() => { /* refusé par les règles : trop tôt, ou un autre appareil a pris la tranche */ });
}

function startTickEngine() {
    clearInterval(tickTimer);
    /* On sonde plus souvent que l'intervalle : le joueur arrive au milieu
       d'une tranche, et attendre dix minutes pleines pour la première serait
       perçu comme une panne. */
    tickTimer = setInterval(claimTick, 60000);
    claimTick();
}

function renderBoutique() {
    const uid = state.user && state.user.uid;
    if (!uid) return;

    const balance = economyBalance(state.economy, uid);
    const available = availablePoints(state.economy, uid);
    const reserved = balance - available;

    $('m-wallet-value').textContent = formatPoints(balance);
    const hint = $('m-wallet-hint');
    if (reserved > 0) {
        hint.textContent = 'dont ' + formatPoints(reserved) + ' en attente de validation';
    } else if (state.settings.isLanActive) {
        const ticks = Number(((state.economy.ticks || {})[uid] || {}).count) || 0;
        hint.textContent = ticks >= ECONOMY.MAX_TICKS
            ? 'Présence : plafond atteint, à toi de jouer'
            : '+' + ECONOMY.TICK_VALUE + ' ' + ECONOMY.CURRENCY + ' toutes les 10 min de présence';
    } else {
        hint.textContent = 'Les points se gagnent pendant la LAN.';
    }

    paintXpBar('m-xp-level', 'm-xp-count', 'm-xp-segs', 'm-xp-foot');
    renderAchSummary();
    renderBoosterShelf();
    renderGmQueue();
    renderMyPurchases();
    renderShopList();
    renderShopLeaderboard();
    renderShopFeed();

    $('m-shop-new').style.display = state.isGamemaster ? 'block' : 'none';
}

/* ---------- La barre d'expérience ----------
   Elle est peinte à deux endroits (boutique et hauts faits) : mêmes chiffres,
   mêmes segments, une seule fonction. */

const XP_SEGMENTS = 24;

function paintXpBar(levelId, countId, segsId, footId) {
    const uid = state.user && state.user.uid;
    const info = xpLevel(xpTotal(state.xp, uid));

    $(levelId).textContent = info.level + ' · ' + levelTitle(info.level);
    $(countId).textContent = info.into + ' / ' + info.span + ' XP';

    const segs = $(segsId);
    segs.innerHTML = '';
    /* On arrondit vers le haut dès qu'il y a le moindre progrès : un joueur
       qui vient de gagner 25 XP doit voir un segment s'allumer, pas rien. */
    const lit = info.into > 0 ? Math.max(1, Math.round(info.ratio * XP_SEGMENTS)) : 0;
    for (let i = 0; i < XP_SEGMENTS; i += 1) {
        const seg = el('span', 'm-xp__seg');
        if (i < lit) seg.classList.add(i === lit - 1 ? 'is-edge' : 'is-on');
        segs.appendChild(seg);
    }

    if (footId) {
        $(footId).textContent = info.total === 0
            ? 'L\'expérience se gagne en venant, et en décrochant des hauts faits.'
            : 'Encore ' + info.toNext + ' XP avant le niveau ' + (info.level + 1)
              + ' · ' + info.total + ' XP en tout';
    }
}

/* ---------- Le booster en tête de gondole ----------
   Le paquet est l'article que la soirée met en avant : il a droit à son
   emballage plutôt qu'à une ligne de liste. */

function renderBoosterShelf() {
    const uid = state.user && state.user.uid;
    const section = $('m-booster-section');
    const mount = $('m-booster-shelf');
    const items = packItems(state.economy);

    /* Sans set, un booster ne contiendrait rien : on ne le propose pas. */
    const setId = tcgCurrentSetId(state.tcg);
    if (!setId) { section.style.display = 'none'; return; }

    if (!items.length) {
        /* Personne n'a encore mis de booster en vente. Pour un maître du jeu,
           c'est une chose à faire, pas une absence à constater. */
        if (!state.isGamemaster) { section.style.display = 'none'; return; }
        section.style.display = 'flex';
        mount.innerHTML = '';
        const card = el('article', 'm-card');
        card.appendChild(el('p', 'm-card__body',
            'Aucun booster en vente. Les joueurs ne peuvent pas acheter de cartes.'));
        const go = el('button', 'm-btn m-btn--solid m-btn--full', 'Mettre le booster en vente');
        go.addEventListener('click', createDefaultPackItem);
        card.appendChild(go);
        mount.appendChild(card);
        return;
    }

    section.style.display = 'flex';
    mount.innerHTML = '';
    items.forEach(([id, item]) => mount.appendChild(buildBoosterCard(id, item, uid)));
}

function buildBoosterCard(id, item, uid) {
    const card = el('article', 'm-boostbuy');
    const row = el('div', 'm-boostbuy__row');

    const art = el('div', 'm-boostbuy__art');
    const img = el('img');
    img.src = generatedArt[PACK_ART_KEY] || DEFAULT_THUMB;
    img.alt = '';
    art.appendChild(img);
    row.appendChild(art);

    const main = el('div', 'm-boostbuy__main');
    main.appendChild(el('h3', 'm-boostbuy__name',
        item.name || packLabel({ name: generatedArtNames[PACK_ART_KEY] }, state.settings.lanName)));
    main.appendChild(el('p', 'm-boostbuy__meta',
        TCG.PACK_SIZE + ' cartes du set de la soirée, dont trois brillantes.'));

    const cost = el('span', 'm-boostbuy__cost');
    cost.appendChild(el('span', null, ECONOMY.CURRENCY));
    cost.appendChild(document.createTextNode(String(Math.round(Number(item.price) || 0))));
    main.appendChild(cost);
    row.appendChild(main);
    card.appendChild(row);

    const verdict = canBuy(state.economy, uid, id, item);
    const buy = el('button', 'm-btn m-btn--solid m-btn--full',
        verdict.ok ? 'Acheter un booster' : verdict.why);
    buy.disabled = !verdict.ok;
    buy.addEventListener('click', () => requestPurchase(id, item));
    card.appendChild(buy);

    if (state.isGamemaster) {
        const del = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Retirer de la vente');
        del.addEventListener('click', () => removeCatalogItem(id));
        card.appendChild(del);
    }

    return card;
}

/* Un booster prêt à vendre, sans passer par le formulaire. Le prix part du
   plafond de présence : dix heures de LAN paient trois paquets, ce qui laisse
   la place aux défis pour le reste. */
function createDefaultPackItem() {
    const user = state.user;
    if (!user) return;
    const price = Math.round(ECONOMY.MAX_TICKS * ECONOMY.TICK_VALUE / 3);
    db.ref('lan/economy/catalog').push().set({
        name: packLabel({ name: generatedArtNames[PACK_ART_KEY] }, state.settings.lanName),
        description: TCG.PACK_SIZE + ' cartes du set de la soirée.',
        price: price,
        category: 'fun',
        stock: null,
        needsTarget: false,
        kind: 'pack',
        active: true,
        createdBy: user.uid,
        createdAt: firebase.database.ServerValue.TIMESTAMP
    })
        .then(() => showToast('Le booster est en vente à ' + formatPoints(price) + '.', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

/* Garnir la boutique d'un coup. On n'ajoute que ce qui manque, comparé sur le
   nom : regarnir deux fois ne double pas les articles. */
function stockStarterShop() {
    const user = state.user;
    if (!user) return;
    const missing = missingStarterItems(state.economy);
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
        .then(() => showToast(missing.length + ' articles ajoutés à la boutique.', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

function removeCatalogItem(id) {
    db.ref('lan/economy/catalog/' + id).remove()
        .then(() => showToast('Article retiré.', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

/* ---------- File d'attente du maître du jeu ---------- */

function renderGmQueue() {
    const section = $('m-gm-section');
    const mount = $('m-gm-queue');
    const queue = pendingPurchases(state.economy);

    /* Les achats sont immédiats : cette file ne sert plus qu'aux demandes
       déposées avant le changement. Vide, elle disparaît au lieu d'annoncer
       un travail qui n'existe plus. */
    if (!state.isGamemaster || !queue.length) { section.style.display = 'none'; return; }

    section.style.display = 'flex';
    mount.innerHTML = '';

    queue.forEach(p => {
        const card = el('article', 'm-card');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title', p.itemName || 'Article'));
        top.appendChild(el('span', 'm-price', formatPoints(p.price)));
        card.appendChild(top);

        const buyerBalance = economyBalance(state.economy, p.uid);
        let meta = (p.userName || playerName(p.uid)) + ' · solde ' + formatPoints(buyerBalance);
        if (p.targetName) meta += ' · visé : ' + p.targetName;
        card.appendChild(el('p', 'm-card__meta', meta));

        /* Le solde est affiché au moment de trancher : c'est le garde-fou
           contre un client bricolé qui aurait laissé passer un achat trop
           cher. Les règles ne peuvent pas additionner un registre. */
        if (buyerBalance < (Number(p.price) || 0)) {
            card.appendChild(el('p', 'm-card__meta', '⚠️ Solde insuffisant.'));
        }

        const grant = el('button', 'm-btn m-btn--solid m-btn--sm m-btn--full', 'Valider');
        grant.addEventListener('click', () => resolvePurchase(p, 'granted'));
        card.appendChild(grant);
        const refuse = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Refuser');
        refuse.addEventListener('click', () => resolvePurchase(p, 'refused'));
        card.appendChild(refuse);

        mount.appendChild(card);
    });
}

/* Valider un achat, c'est écrire deux choses : la ligne du registre qui
   débite, et le sort de la demande. Le registre d'abord : si la seconde
   écriture échoue, le joueur a été débité d'un article qu'il recevra quand
   même, ce qui se rattrape ; l'inverse donnerait un article gratuit. */
function resolvePurchase(purchase, status) {
    const user = state.user;
    if (!user) return;

    const close = () => db.ref('lan/economy/purchases/' + purchase.id).update({
        status: status,
        resolvedBy: user.uid,
        resolvedByName: user.displayName || 'Maître du jeu',
        resolvedAt: firebase.database.ServerValue.TIMESTAMP
    });

    if (status === 'refused') {
        close().then(() => showToast('Demande refusée.', 'success'))
            .catch(e => showToast('Erreur : ' + e.message, 'error'));
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
        .then(() => showToast('Achat validé !', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

function writeLedger(entry) {
    const user = state.user;
    return db.ref('lan/economy/ledger').push().set(Object.assign({
        by: user ? user.uid : null,
        byName: user ? (user.displayName || 'Maître du jeu') : null,
        ts: firebase.database.ServerValue.TIMESTAMP
    }, entry));
}

/* ---------- Mes demandes en cours ---------- */

function renderMyPurchases() {
    const uid = state.user && state.user.uid;
    const section = $('m-my-purchases-section');
    const mount = $('m-my-purchases');
    const mine = Object.entries(state.economy.purchases || {})
        .map(([id, p]) => Object.assign({ id: id }, p))
        .filter(p => p.uid === uid && p.status === 'pending')
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

    if (!mine.length) { section.style.display = 'none'; return; }
    section.style.display = 'flex';
    mount.innerHTML = '';

    mine.forEach(p => {
        const card = el('article', 'm-card');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title', p.itemName || 'Article'));
        top.appendChild(el('span', 'm-chip', 'en attente'));
        card.appendChild(top);
        card.appendChild(el('p', 'm-card__meta',
            formatPoints(p.price) + ' réservés' + (p.targetName ? ' · visé : ' + p.targetName : '')));

        const cancel = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Annuler');
        cancel.addEventListener('click', () => {
            db.ref('lan/economy/purchases/' + p.id).remove()
                .then(() => showToast('Demande annulée.', 'success'))
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        card.appendChild(cancel);
        mount.appendChild(card);
    });
}

/* ---------- La carte ---------- */

function renderShopList() {
    const uid = state.user && state.user.uid;
    const mount = $('m-shop-list');
    mount.innerHTML = '';

    /* Les boosters ont leur rayon à eux, tout en haut : les remettre ici
       ferait deux fois le même article sur le même écran. */
    const catalog = Object.entries(state.economy.catalog || {})
        .filter(([, item]) => item && item.active !== false && !isPackItem(item));

    if (!catalog.length) {
        if (!state.isGamemaster) {
            mount.appendChild(emptyState('La boutique est vide pour le moment.'));
            return;
        }
        /* Pour un maître du jeu, une boutique vide est une chose à faire, pas
           une absence à constater. */
        const card = el('article', 'm-card');
        card.appendChild(el('p', 'm-card__body',
            'La boutique est vide. Une carte de départ existe : privilèges, handicaps à jouer sur quelqu\'un, cosmétiques.'));
        const go = el('button', 'm-btn m-btn--solid m-btn--full', 'Garnir la boutique');
        go.addEventListener('click', stockStarterShop);
        card.appendChild(go);
        mount.appendChild(card);
        return;
    }

    /* Il reste des articles de la carte de départ à poser : on le propose sans
       insister, tout en bas. */
    const missing = state.isGamemaster ? missingStarterItems(state.economy).length : 0;
    /* Groupé par rayon : une liste à plat de vingt articles ne se lit pas sur
       un téléphone. */
    ECONOMY.CATEGORIES.forEach(cat => {
        const items = catalog.filter(([, item]) => (item.category || 'fun') === cat.key);
        if (!items.length) return;
        mount.appendChild(el('p', 'm-shop__cat', cat.icon + ' ' + cat.label));
        items
            .sort((a, b) => (Number(a[1].price) || 0) - (Number(b[1].price) || 0))
            .forEach(([id, item]) => mount.appendChild(buildShopCard(id, item, uid)));
    });

    if (missing) {
        const more = el('button', 'm-btn m-btn--quiet m-btn--sm m-btn--full',
            'Ajouter les ' + missing + ' articles de la carte de départ');
        more.addEventListener('click', stockStarterShop);
        mount.appendChild(more);
    }
}

/* Un article de boutique, à la manière d'une carte : jeton de coût, nom gravé,
   bande de famille. Le format reste le PAYSAGE — les collectibles sont en
   portrait, et deux systèmes de cartes qui se ressemblent trop se confondent. */
function buildShopCard(id, item, uid) {
    const family = item.category || 'fun';
    const card = el('article', 'm-sitem m-sitem--' + family);
    const verdict = canBuy(state.economy, uid, id, item);
    if (!verdict.ok) card.classList.add('is-locked');

    /* Le prix est un jeton, pas une ligne de texte : c'est ce qui fait qu'on
       lit « ça coûte 40 » avant de lire le nom. */
    card.appendChild(el('span', 'm-sitem__cost', String(Math.round(Number(item.price) || 0))));

    const main = el('div', 'm-sitem__main');
    main.appendChild(el('h3', 'm-sitem__name', item.name || 'Article'));
    if (item.description) main.appendChild(el('p', 'm-sitem__desc', item.description));

    const strip = el('div', 'm-sitem__strip');
    strip.appendChild(el('span', 'm-sitem__gem'));
    strip.appendChild(el('span', 'm-sitem__fam',
        item.needsTarget ? 'Handicap ciblé' : categoryLabel(family)));

    const left = itemStockLeft(state.economy, id, item);
    if (left !== null) {
        strip.appendChild(el('span', 'm-sitem__stock',
            left ? left + ' restant' + (left > 1 ? 's' : '') : 'Épuisé'));
    }
    main.appendChild(strip);

    const buy = el('button', 'm-sitem__buy');
    if (verdict.ok) {
        buy.appendChild(iconSvg('M5 12h14M13 6l6 6-6 6'));
        buy.appendChild(document.createTextNode(item.needsTarget ? 'Viser' : 'Prendre'));
    } else {
        buy.textContent = verdict.why;
    }
    buy.disabled = !verdict.ok;
    buy.addEventListener('click', () => requestPurchase(id, item));
    main.appendChild(buy);

    if (state.isGamemaster) {
        const del = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Retirer de la carte');
        del.addEventListener('click', () => removeCatalogItem(id));
        main.appendChild(del);
    }

    card.appendChild(main);
    return card;
}

/* Une icône au trait, à la taille du texte qui l'accompagne. */
function iconSvg(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const d = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    d.setAttribute('d', path);
    svg.appendChild(d);
    return svg;
}

/* Combien on peut s'en offrir, sans jamais passer sous zéro ni dépasser le
   stock. Sert au bouton « Max » comme au plafond du champ. */
function affordableCount(itemId, item) {
    const uid = state.user && state.user.uid;
    const price = Number(item.price) || 0;
    if (price <= 0) return 1;
    let max = Math.floor(availablePoints(state.economy, uid) / price);
    const left = itemStockLeft(state.economy, itemId, item);
    if (left !== null) max = Math.min(max, left);
    return Math.max(0, max);
}

/* Acheter N exemplaires d'un coup. Tout part dans UNE écriture multi-chemins :
   Firebase applique le lot entier ou rien, donc on ne peut pas être débité de
   trois boosters et n'en recevoir qu'un.

   Le joueur écrit lui-même ses lignes de registre, ce qu'il ne peut faire nulle
   part ailleurs. Les règles l'y autorisent parce qu'une ligne de type
   « purchase » est forcément NÉGATIVE et forcément égale au prix affiché en
   boutique : elle ne peut qu'appauvrir celui qui la signe. */
function buyItem(itemId, item, quantity, targetUid, targetName) {
    const user = state.user;
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

    /* Ces paquets-là s'annoncent tout seuls au moment du clic : le sceau qui
       suivra restera muet, sinon acheter cinq boosters ferait dix bulles. */
    if (isPackItem(item)) purchaseIds.forEach(id => sealedQuietly.add(id));

    return db.ref().update(update)
        .then(() => {
            closeSheet();
            /* UN seul message, quel que soit le nombre. */
            if (isPackItem(item)) {
                showToast(count > 1
                    ? count + ' boosters achetés ! Ils t\'attendent dans tes cartes.'
                    : 'Booster acheté ! Il t\'attend dans tes cartes.', 'success');
            } else {
                showToast((item.name || 'Article')
                    + (count > 1 ? ' ×' + count : '') + ' : c\'est à toi !', 'success');
            }
            if (targetUid && targetUid !== user.uid) {
                sendNotification(targetUid,
                    (user.displayName || 'Quelqu\'un') + ' te joue « ' + (item.name || 'un handicap') + ' »', 'info');
            }
        })
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

function requestPurchase(itemId, item) {
    const user = state.user;
    if (!user) return;

    /* Un handicap sans cible serait du sabotage anonyme : on demande sur qui,
       et le nom restera visible dans le registre. On n'en achète qu'un à la
       fois — jouer trois fois le même handicap sur quelqu'un n'a pas de sens. */
    if (item.needsTarget) {
        openSheet(item.name + ' — sur qui ?', (body) => {
            const others = economyPlayers().filter(u => u !== user.uid);
            if (!others.length) {
                body.appendChild(emptyState('Aucun autre joueur pour le moment.'));
                return;
            }
            others.forEach(other => {
                const row = el('button', 'm-btn m-btn--full', playerName(other));
                row.addEventListener('click', () => buyItem(itemId, item, 1, other, playerName(other)));
                body.appendChild(row);
            });
        });
        return;
    }

    /* Tout le reste s'achète en quantité. Un seul exemplaire possible ? On ne
       fait pas perdre un écran pour choisir « 1 ». */
    const max = affordableCount(itemId, item);
    if (max <= 1) { buyItem(itemId, item, 1, null, null); return; }

    openQuantitySheet(itemId, item, max);
}

/* Le choix de la quantité : un champ, deux flèches, et « Max ». Le total se
   met à jour à chaque frappe — on doit voir ce qu'on va payer avant de payer. */
function openQuantitySheet(itemId, item, max) {
    const price = Number(item.price) || 0;

    openSheet(item.name || 'Acheter', (body) => {
        const row = el('div', 'm-qty');

        const minus = el('button', 'm-qty__step', '−');
        const input = el('input', 'm-qty__field');
        input.type = 'number';
        input.inputMode = 'numeric';
        input.min = '1';
        input.max = String(max);
        input.value = '1';
        const plus = el('button', 'm-qty__step', '+');
        const maxBtn = el('button', 'm-qty__max', 'Max');

        row.appendChild(minus);
        row.appendChild(input);
        row.appendChild(plus);
        row.appendChild(maxBtn);
        body.appendChild(row);

        const total = el('p', 'm-qty__total');
        body.appendChild(total);

        const clamp = (n) => Math.max(1, Math.min(max, Math.floor(Number(n) || 1)));
        const paint = () => {
            const n = clamp(input.value);
            total.textContent = n + ' × ' + formatPoints(price) + ' = ' + formatPoints(n * price);
            go.textContent = 'Acheter · ' + formatPoints(n * price);
        };
        const setN = (n) => { input.value = String(clamp(n)); paint(); };

        minus.addEventListener('click', () => setN(clamp(input.value) - 1));
        plus.addEventListener('click', () => setN(clamp(input.value) + 1));
        maxBtn.addEventListener('click', () => setN(max));
        input.addEventListener('input', paint);
        /* On ne recale qu'en quittant le champ : corriger pendant la frappe
           empêcherait d'effacer pour retaper. */
        input.addEventListener('blur', () => setN(input.value));

        const go = el('button', 'm-btn m-btn--solid m-btn--full');
        go.addEventListener('click', () => buyItem(itemId, item, clamp(input.value), null, null));
        body.appendChild(go);

        body.appendChild(el('p', 'm-card__meta',
            'Tu peux en prendre ' + max + ' au maximum avec ton solde.'));

        paint();
    });
}

/* Tous ceux qu'on connaît : connectés, votants, ou simplement déjà venus.
   Un joueur parti se coucher reste une cible valable pour un handicap. */
function economyPlayers() {
    const seen = {};
    [state.status, state.votes, state.profiles].forEach(source => {
        Object.keys(source || {}).forEach(uid => { seen[uid] = true; });
    });
    return Object.keys(seen);
}

/* ---------- Fortunes et registre ---------- */

function renderShopLeaderboard() {
    const mount = $('m-shop-leaderboard');
    mount.innerHTML = '';
    const board = economyLeaderboard(state.economy, economyPlayers());
    if (!board.length) {
        mount.appendChild(emptyState("Personne n'a encore gagné de points."));
        return;
    }
    board.slice(0, 10).forEach((row, i) => {
        const line = el('button', 'm-podium m-podium--' + (i + 1));
        line.addEventListener('click', () => openProfile(row.uid));
        line.appendChild(el('span', 'm-podium__pos', String(i + 1)));
        const face = el('img', 'm-podium__face');
        face.src = playerPhoto(row.uid);
        face.alt = '';
        line.appendChild(face);
        line.appendChild(el('span', 'm-podium__name', playerFullName(playerName(row.uid), playerNickname(achData(), row.uid))));
        line.appendChild(el('span', 'm-price', formatPoints(row.balance)));
        mount.appendChild(line);
    });
}

/* Le registre est public : c'est lui qui rend l'économie honnête. Chacun voit
   qui a reçu quoi, et pourquoi. */
function renderShopFeed() {
    const mount = $('m-shop-feed');
    mount.innerHTML = '';
    const feed = economyFeed(state.economy, 15);
    if (!feed.length) {
        mount.appendChild(emptyState('Aucun mouvement pour le moment.'));
        return;
    }
    feed.forEach(entry => {
        const row = el('div', 'm-move');
        const who = el('span', 'm-move__who', playerName(entry.uid));
        who.appendChild(el('span', 'm-move__why',
            (entry.reason || 'Mouvement') + ' · ' + timeAgo(entry.ts)));
        row.appendChild(who);
        const delta = Number(entry.delta) || 0;
        row.appendChild(el('span', 'm-move__delta ' + (delta >= 0 ? 'is-up' : 'is-down'),
            (delta >= 0 ? '+' : '') + delta));
        mount.appendChild(row);
    });
}

/* ---------- Tenue de la boutique (maître du jeu) ---------- */

$('m-shop-new').addEventListener('click', () => {
    openSheet('Ajouter un article', (body) => {
        const name = el('input', 'm-input');
        name.placeholder = 'Ex : Choisir le prochain jeu';
        body.appendChild(name);

        const desc = el('textarea', 'm-input');
        desc.placeholder = 'Ce que ça fait, et pour combien de temps';
        body.appendChild(desc);

        const price = el('input', 'm-input');
        price.type = 'number';
        price.min = '0';
        price.placeholder = 'Prix en ' + ECONOMY.CURRENCY;
        body.appendChild(price);

        const category = el('select', 'm-input');
        ECONOMY.CATEGORIES.forEach(cat => {
            const opt = el('option', null, cat.icon + ' ' + cat.label);
            opt.value = cat.key;
            category.appendChild(opt);
        });
        body.appendChild(category);

        const stock = el('input', 'm-input');
        stock.type = 'number';
        stock.min = '0';
        stock.placeholder = 'Stock (vide = illimité)';
        body.appendChild(stock);

        const targetWrap = el('label', 'm-check');
        const target = el('input');
        target.type = 'checkbox';
        targetWrap.appendChild(target);
        targetWrap.appendChild(el('span', null, 'À jouer sur un autre joueur'));
        body.appendChild(targetWrap);

        /* Un booster n'est pas un article comme un autre : sa validation donne
           droit à un paquet scellé, dont le contenu est décidé par le serveur
           au moment du sceau. Le reste de la boutique ignore tout de ça. */
        const packWrap = el('label', 'm-check');
        const pack = el('input');
        pack.type = 'checkbox';
        packWrap.appendChild(pack);
        packWrap.appendChild(el('span', null, 'C\'est un booster de cartes'));
        body.appendChild(packWrap);

        const submit = el('button', 'm-btn m-btn--solid m-btn--full', 'Mettre en boutique');
        submit.addEventListener('click', () => {
            const user = state.user;
            if (!user) return;
            const value = name.value.trim();
            if (!value) { showToast('Il manque le nom.', 'error'); return; }
            const priceValue = Number(price.value);
            if (!price.value.trim() || !isFinite(priceValue) || priceValue < 0) {
                showToast('Prix invalide.', 'error');
                return;
            }
            const stockValue = Number(stock.value);
            db.ref('lan/economy/catalog').push().set({
                name: value,
                description: desc.value.trim(),
                price: Math.round(priceValue),
                category: category.value,
                stock: stock.value.trim() && isFinite(stockValue) && stockValue > 0 ? Math.round(stockValue) : null,
                needsTarget: target.checked,
                kind: pack.checked ? 'pack' : null,
                active: true,
                createdBy: user.uid,
                createdAt: firebase.database.ServerValue.TIMESTAMP
            }).then(() => {
                closeSheet();
                showToast('"' + value + '" en boutique !', 'success');
            }).catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        body.appendChild(submit);
    });
});

/* ==========================================================================
   LES CARTES
   La collection n'est stockée nulle part : elle se rejoue à chaque rendu
   depuis les paquets ouverts et les échanges acceptés (core.js). Ce fichier
   n'écrit que quatre choses — sceller un paquet acheté, l'ouvrir, proposer un
   échange, y répondre. Tout le reste est de la lecture.
   ========================================================================== */

/* Le rejeu coûte un parcours de tous les paquets : on ne le refait pas six
   fois par rendu. Invalidé au début de chaque renderAll. */
let tcgView = null;

function tcgSnapshot() {
    if (tcgView) return tcgView;
    const replay = tcgReplay(state.tcg);
    const set = tcgCurrentSet(state.tcg);
    tcgView = {
        cards: replay.cards,
        applied: replay.applied,
        set,
        setCards: (set && set.cards) || {},
        uid: (state.user && state.user.uid) || ''
    };
    return tcgView;
}

/* Les illustrations générées pour les Signature, chargées à la demande. Elles
   vivent sous `lan/cardArt`, à côté de `lan/tcg` et non dedans : ce sont des
   images en base64, et les faire transiter dans la synchro permanente de tous
   les clients coûterait des mégaoctets à chaque connexion. Huit cartes par
   set : on les lit une par une, et on retient. */
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
            if (node && node.data) renderCartes();
        })
        .catch(() => { generatedArt[gameKey] = null; })
        .finally(() => generatedArtPending.delete(gameKey));
}

/* Repli pour les sets composés avant que les cartes portent un appId : on
   retombe sur la résolution par nom, à l'ancienne. Sans lui, un set créé par
   une version précédente n'affiche plus une seule illustration — c'est
   exactement ce qui est arrivé. Chargé à l'approche de l'écran, sinon un set
   de cinq cents cartes redemanderait cinq cents jaquettes d'un coup. */
const legacyArtObserver = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            observer.unobserve(entry.target);
            thumbFor(entry.target.dataset.game || '', entry.target);
        });
    }, { rootMargin: '320px' })
    : null;

/* Illustration d'une carte. Quand la carte porte son appId — tous les sets
   composés à partir de maintenant — l'adresse de la jaquette Steam s'en déduit
   et le set entier ne déclenche pas une seule requête. */
function cardArtFor(card, imgEl) {
    if (card.rarity === 'signature') ensureGeneratedArt(card.gameKey);

    const known = cardImage(card, generatedArt);
    if (known) { imgEl.src = known; return; }

    const label = card.name || card.gameKey;
    const cached = thumbCache.get(normalizeGameName(label));
    if (cached) { imgEl.src = cached; return; }

    imgEl.src = DEFAULT_THUMB;
    imgEl.dataset.game = label;
    if (legacyArtObserver) legacyArtObserver.observe(imgEl);
    else thumbFor(label, imgEl);
}

/* La carte elle-même. Une seule fabrique pour la grille, les doubles,
   l'échange et la révélation : une carte doit se ressembler partout. */
function cardNode(card, options) {
    const opts = options || {};
    const rarity = rarityMeta(card.rarity);
    const node = el('article', 'm-tcard m-tcard--' + rarity.key);
    if (card.foil) node.classList.add('is-foil');
    if (opts.missing) node.classList.add('is-missing');
    if (opts.selected) node.classList.add('is-picked');
    if (opts.small) node.classList.add('m-tcard--sm');

    const art = el('div', 'm-tcard__art');
    const img = el('img', 'm-tcard__img');
    img.alt = '';
    img.loading = 'lazy';
    cardArtFor(card, img);
    art.appendChild(img);
    if (card.foil) art.appendChild(el('span', 'm-tcard__foil'));
    node.appendChild(art);

    node.appendChild(el('h4', 'm-tcard__name', card.name || card.gameKey));

    const foot = el('div', 'm-tcard__foot');
    foot.appendChild(el('span', 'm-tcard__rarity', card.foil ? rarity.short + ' ✦' : rarity.short));
    if (opts.badge) foot.appendChild(el('span', 'm-tcard__badge', opts.badge));
    node.appendChild(foot);

    /* Le reflet couvre la carte entière et se pose en dernier, donc au-dessus
       de tout le reste. Il reste invisible tant qu'aucun pointeur ne la
       touche. */
    node.appendChild(el('span', 'm-tcard__glare'));

    if (opts.onClick) {
        node.setAttribute('role', 'button');
        node.tabIndex = 0;
        node.addEventListener('click', (e) => {
            /* Toucher une carte est un geste : c'est l'autre occasion valable
               de demander le capteur à iOS. */
            askTiltPermission();
            opts.onClick(e);
        });
    }
    return node;
}

/* La fiche d'une carte : sa rareté, son score de vote, et surtout sa
   provenance. Qui l'a sortie du paquet, quand, et par combien de mains elle
   est passée — c'est ce qui fait d'une carte un souvenir de soirée. */
function openCardSheet(card) {
    openSheet(card.name || card.gameKey, (body) => {
        const stage = el('div', 'm-tcard-solo');
        stage.appendChild(cardNode(card, {}));
        body.appendChild(stage);

        const rarity = rarityMeta(card.rarity);
        body.appendChild(el('p', 'm-card__meta',
            rarity.label + (card.foil ? ' · brillante ✦' : '')));

        /* Pourquoi cette carte est rare. C'est tout l'intérêt d'une rareté
           tirée du groupe plutôt qu'inventée : elle s'explique en une phrase,
           et la phrase est vraie. */
        const view = tcgSnapshot();
        const setCard = view.setCards[card.gameKey];
        if (setCard) body.appendChild(el('p', 'm-card__meta', rarityReason(setCard, view.set)));

        if (card.mintedBy) {
            body.appendChild(el('p', 'm-card__meta',
                'Sortie du paquet par ' + playerName(card.mintedBy)
                + (card.mintedAt ? ' · ' + new Date(card.mintedAt).toLocaleString('fr-FR') : '')));
        }
        const hands = (card.lineage || []).length - 1;
        if (hands > 0) {
            body.appendChild(el('p', 'm-card__meta',
                'Échangée ' + hands + ' fois : ' + card.lineage.map(playerName).join(' → ')));
        }
    });
}

/* ---------- Le bandeau du set ---------- */

function renderCartes() {
    const view = tcgSnapshot();
    if (!view.uid) return;
    /* Redessiner trois cents cartes à chaque mise à jour Firebase mettrait le
       téléphone à genoux. Hors de l'écran Cartes, il n'y a rien à voir : le
       rappel d'accueil et la pastille de « Plus » suffisent. */
    if (currentScreen !== 'cartes') return;

    // L'emballage a son propre visuel, chargé comme celui d'une Signature.
    ensureGeneratedArt(PACK_ART_KEY);

    renderSetBand(view);
    renderMintPanel(view);
    renderMyPacks(view);
    renderTradesIn(view);
    renderSetGrid(view);
    renderDupes(view);
    renderTradesOut(view);
    renderTcgLeaderboard(view);
    renderTradeFeed(view);
}

function renderSetBand(view) {
    const band = $('m-set-band');
    band.innerHTML = '';

    if (!view.set) {
        band.appendChild(el('p', 'm-setband__title', 'Pas encore de set'));
        band.appendChild(el('p', 'm-setband__hint',
            'Les cartes viennent du vote : elles apparaîtront quand le maître du jeu aura créé le set de la LAN.'));
        return;
    }

    const progress = setProgress(view.setCards, view.cards, view.uid);
    band.appendChild(el('p', 'm-setband__title', view.set.name));
    const bar = el('div', 'm-setband__bar');
    const fill = el('span', 'm-setband__fill');
    fill.style.width = progress.percent + '%';
    bar.appendChild(fill);
    band.appendChild(bar);
    band.appendChild(el('p', 'm-setband__hint',
        progress.owned + ' / ' + progress.total + ' cartes'
        + (progress.foils ? ' · ' + progress.foils + ' brillante' + (progress.foils > 1 ? 's' : '') : '')
        + (progress.complete ? ' · set complet 🏆' : '')));
}

/* ---------- Poste du maître du jeu ---------- */

function renderMintPanel(view) {
    const section = $('m-mint-section');
    if (!state.isGamemaster) { section.style.display = 'none'; return; }
    section.style.display = 'flex';

    const summary = $('m-mint-state');
    const pool = setPoolSize();
    if (!view.set) {
        summary.textContent = pool
            ? 'Aucun set. ' + pool + ' jeux connus (votes + bibliothèques Steam) attendent de devenir des cartes.'
            : 'Aucun set, et aucun jeu connu pour en composer un.';
    } else {
        const count = Object.keys(view.setCards).length;
        summary.textContent = 'Set en cours : « ' + view.set.name + ' », ' + count + ' cartes. '
            + pool + ' jeux connus aujourd\'hui.';
    }
    /* Le set existe déjà : le bouton principal refuse, et c'est un second
       bouton, explicite, qui permet d'en recomposer un. Recréer sans le vouloir
       repartirait sur un set neuf alors que la soirée est lancée. */
    $('m-mint-set').style.display = view.set ? 'none' : 'block';
    $('m-mint-set').disabled = !pool;
    /* La soirée close, les collections sont archivées : on ne propose plus de
       tout jeter pour recomposer. */
    $('m-remint-set').style.display = (view.set && !state.settings.lanFinished) ? 'block' : 'none';
}

/* Tous les jeux qui peuvent devenir des cartes : les votés, plus tout ce que
   les bibliothèques Steam du groupe et les soirées passées nous ont appris. */
function setPool() {
    return knownGames({ libraries: state.libraries });
}

function setPoolSize() {
    return Object.keys(buildCardSet(state.scores || [], setPool())).length;
}

/* Composer le set : le classement des votes prend le haut, les bibliothèques
   remplissent le reste. On ne remplace jamais un set existant — on en crée un
   nouveau et on pointe dessus, pour que les cartes déjà ouvertes gardent un
   sens. */
/* Les jeux votés à la main n'ont pas d'appId : ils ne sont dans aucune
   bibliothèque, on ne connaît que le nom tapé par le joueur. Sans appId, pas
   d'illustration, donc pas de carte — or ce sont justement les jeux les plus
   réclamés. On les résout donc une fois, à la création du set. C'est borné :
   quelques dizaines de noms, une seule fois, contre plusieurs centaines de
   jeux de bibliothèque qui, eux, arrivent déjà avec leur appId. */
function resolveVotedArt(pool) {
    const known = new Set(pool.games.map(game => cardKey(game.name)));
    const missing = (state.scores || [])
        .map(game => ({ key: cardKey(game.name), name: game.name }))
        .filter(game => game.key && !known.has(game.key));

    if (!missing.length) return Promise.resolve({});

    return Promise.all(missing.map(game =>
        fetch('/api/get-game-image?name=' + encodeURIComponent(game.name) + '&fuzzy=1')
            .then(res => (res.ok ? res.json() : null))
            .then(data => (data && data.appId ? [game.key, data.appId] : null))
            .catch(() => null)
    )).then(found => Object.fromEntries(found.filter(Boolean)));
}

/* Recomposer un set pendant la soirée, c'est repartir de zéro pour de bon : on
   efface TOUS les anciens sets, TOUS les paquets et TOUS les échanges — pas
   seulement ceux du set remplacé. N'effacer que le set courant laissait dans
   les collections les cartes venues d'un set encore plus ancien, et le
   « nouveau départ » n'en était pas un.

   Tant que la LAN n'est pas terminée, une collection est un brouillon : elle ne
   devient un souvenir qu'à la clôture de la soirée. C'est ce qui autorise à
   tout jeter ici sans rien perdre qui compte.

   Les illustrations (`lan/cardArt`) survivent : elles sont attachées au jeu et
   non au set, et les regénérer coûterait pour rien. */
function discardCards(keepSetId) {
    const doomed = Object.keys(state.tcg.sets || {}).filter(id => id !== keepSetId);
    return Promise.all(doomed.map(id => db.ref('lan/tcg/sets/' + id).remove()))
        .then(() => Promise.all([
            db.ref('lan/tcg/packs').remove(),
            db.ref('lan/tcg/trades').remove()
        ]));
}

/* Une écriture refusée par les règles ne dit rien d'utile telle quelle. Ici on
   sait pourquoi ça arrive presque toujours : les règles Firebase n'ont pas été
   republiées depuis que la carte porte `owners` et `appId`. */
function tcgWriteError(error) {
    const code = (error && (error.code || error.message)) || '';
    if (/permission/i.test(code)) {
        return 'Écriture refusée par la base. Les règles Firebase doivent être republiées (voir SECURITY.md).';
    }
    return 'Erreur : ' + ((error && error.message) || code);
}

function mintSet(force) {
    const user = state.user;
    if (!user) return;

    const previous = tcgCurrentSetId(state.tcg);
    if (!force && previous) {
        showToast('Le set de la LAN existe déjà !', 'error');
        return;
    }
    /* La soirée close, les collections sont archivées : ce ne sont plus des
       brouillons, et on ne les jette pas pour recomposer un set. */
    if (force && state.settings.lanFinished) {
        showToast('La LAN est terminée : les cartes sont archivées. Rouvre la LAN pour recomposer un set.', 'error');
        return;
    }

    const pool = setPool();
    showToast('Composition du set…', 'success');

    resolveVotedArt(pool).then(appIds => {
        const cards = buildCardSet(state.scores || [], Object.assign({}, pool, { appIds }));
        const count = Object.keys(cards).length;
        if (!count) { showToast('Aucun jeu illustrable : rien à composer.', 'error'); return; }

        const ref = db.ref('lan/tcg/sets').push();
        return ref.set({
            name: 'Set de la LAN ' + (state.settings.lanName || 'LAN Demain'),
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
                showToast('Set créé : ' + count + ' cartes !', 'success');
                return openSignatureArtSheet(cards);
            });
    }).catch(e => showToast(tcgWriteError(e), 'error'));
}

/* Le choix des illustrations des Signature : importer les siennes, ou laisser
   le modèle dessiner ce qui manque. Importer d'abord puis générer ne regénère
   que le reste — c'est ce qui permet de n'utiliser l'API que pour ce qu'on n'a
   pas déjà fait soi-même. */
function openSignatureArtSheet(setCards) {
    const wanted = signatureCards(setCards);
    if (!wanted.length) return Promise.resolve();

    openSheet('Illustrations', (body) => {
        /* L'emballage d'abord : c'est la première chose qu'on voit d'un
           booster, et la seule qui ne soit pas une carte. */
        body.appendChild(el('p', 'm-shop__cat', 'Le booster'));
        const packRow = el('div', 'm-artrow');
        body.appendChild(packRow);

        const packName = el('input', 'm-input');
        packName.placeholder = 'Nom du booster (ex : Booster Janvier 2027)';
        packName.value = generatedArtNames[PACK_ART_KEY] || '';
        packName.addEventListener('change', () => savePackName(packName.value));
        body.appendChild(packName);

        body.appendChild(el('p', 'm-shop__cat', 'Les Signature'));
        body.appendChild(el('p', 'm-card__meta',
            'Ces ' + wanted.length + ' cartes sont le sommet du set. Importe tes propres '
            + 'illustrations pour les distinguer des cartes ordinaires.'));

        const list = el('div', 'm-artlist');
        body.appendChild(list);

        const done = el('button', 'm-btn m-btn--quiet m-btn--full', 'Terminé');
        done.addEventListener('click', closeSheet);
        body.appendChild(done);

        const paintPack = () => {
            packRow.innerHTML = '';
            const thumb = el('img', 'm-artrow__thumb');
            thumb.alt = '';
            thumb.src = generatedArt[PACK_ART_KEY] || DEFAULT_THUMB;
            packRow.appendChild(thumb);
            packRow.appendChild(el('span', 'm-artrow__name',
                packLabel({ name: generatedArtNames[PACK_ART_KEY] }, state.settings.lanName)));

            const pick = el('label', 'm-artrow__pick',
                generatedArt[PACK_ART_KEY] ? 'Remplacer' : 'Importer');
            const input = el('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                if (file) importArt(PACK_ART_KEY, packName.value.trim(), file).then(paintPack);
            });
            pick.appendChild(input);
            packRow.appendChild(pick);
        };

        const paint = () => {
            paintPack();
            list.innerHTML = '';
            let missing = 0;
            wanted.forEach(card => {
                const row = el('div', 'm-artrow');
                const thumb = el('img', 'm-artrow__thumb');
                thumb.alt = '';
                const art = generatedArt[card.gameKey];
                if (art) thumb.src = art;
                else { thumb.src = DEFAULT_THUMB; missing++; }
                row.appendChild(thumb);

                const label = el('span', 'm-artrow__name', card.name);
                row.appendChild(label);

                /* Un vrai <input type="file"> caché derrière un libellé : c'est
                   la seule façon d'ouvrir la galerie du téléphone. */
                const pick = el('label', 'm-artrow__pick', art ? 'Remplacer' : 'Importer');
                const input = el('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.addEventListener('change', () => {
                    const file = input.files && input.files[0];
                    if (!file) return;
                    importCardArt(card, file).then(paint);
                });
                pick.appendChild(input);
                row.appendChild(pick);

                list.appendChild(row);
            });
            generate.textContent = missing
                ? 'Générer les ' + missing + ' manquantes'
                : 'Toutes illustrées';
            generate.disabled = !missing;
        };

        // On sait déjà lesquelles existent : on les lit avant de dessiner.
        const keys = wanted.map(card => card.gameKey).concat([PACK_ART_KEY]);
        Promise.all(keys.map(key =>
            db.ref('lan/cardArt/' + key).once('value')
                .then(snapshot => {
                    const node = snapshot.val();
                    generatedArt[key] = (node && node.data) || null;
                    generatedArtNames[key] = (node && node.name) || '';
                })
                .catch(() => { generatedArt[key] = null; })
        )).then(() => {
            packName.value = generatedArtNames[PACK_ART_KEY] || '';
            paint();
        });

        paint();
    });

    return Promise.resolve();
}

/* Une photo de téléphone pèse plusieurs mégaoctets : on la redimensionne avant
   de l'envoyer. La fenêtre d'illustration d'une carte fait 240 px de large au
   plus, donc 1024 px suffisent largement, et les règles refusent au-delà de
   4 Mo de toute façon. */
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
            by: state.user ? state.user.uid : null,
            ts: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            generatedArt[key] = dataUrl;
            generatedArtNames[key] = label || generatedArtNames[key] || '';
            showToast('Illustration importée.', 'success');
            renderCartes();
        }))
        .catch(e => showToast(tcgWriteError(e), 'error'));
}

function importCardArt(card, file) {
    return importArt(card.gameKey, card.name, file);
}

/* Renommer l'emballage sans forcément lui donner une image : le nom seul suffit
   déjà à ce qu'un booster ne s'appelle plus « Booster de test ». */
function savePackName(name) {
    const label = String(name || '').trim();
    const node = { name: label, ts: firebase.database.ServerValue.TIMESTAMP };
    if (generatedArt[PACK_ART_KEY]) node.data = generatedArt[PACK_ART_KEY];
    if (state.user) node.by = state.user.uid;
    /* Sans image, le nœud n'a pas de `data` et les règles l'exigent : on ne
       l'écrit alors que sous forme de champ, ce que la validation par enfant
       accepte parce que `data` reste celui déjà en place — ou absent si le nœud
       n'existe pas encore, auquel cas on ne peut pas encore nommer. */
    if (!node.data) {
        generatedArtNames[PACK_ART_KEY] = label;
        showToast('Nom retenu. Il sera enregistré avec l\'illustration.', 'success');
        return Promise.resolve();
    }
    return db.ref('lan/cardArt/' + PACK_ART_KEY).set(node)
        .then(() => {
            generatedArtNames[PACK_ART_KEY] = label;
            showToast('Booster renommé.', 'success');
        })
        .catch(e => showToast(tcgWriteError(e), 'error'));
}

$('m-mint-set').addEventListener('click', () => mintSet(false));

$('m-remint-set').addEventListener('click', () => {
    if (state.settings.lanFinished) {
        showToast('La LAN est terminée : les cartes sont archivées.', 'error');
        return;
    }

    const packs = Object.keys(state.tcg.packs || {}).length;
    const cards = tcgCards(state.tcg).length;

    openSheet('Recréer le set ?', (body) => {
        body.appendChild(el('p', 'm-card__meta',
            'Tout repart de zéro : les anciens sets, les boosters et les échanges sont EFFACÉS'
            + (cards
                ? ' — ' + cards + ' carte' + (cards > 1 ? 's' : '') + ' dans '
                  + packs + ' booster' + (packs > 1 ? 's' : '') + ', pour tout le monde.'
                : '.')));
        body.appendChild(el('p', 'm-card__meta',
            'Tant que la soirée n\'est pas close, une collection est un brouillon. '
            + 'Les illustrations déjà faites, elles, sont conservées.'));
        const go = el('button', 'm-btn m-btn--danger m-btn--full', 'Tout effacer et recréer');
        go.addEventListener('click', () => { closeSheet(); mintSet(true); });
        body.appendChild(go);
    });
});

/* Débogage : en attendant la boutique, le maître du jeu ouvre autant de
   boosters qu'il veut. Le paquet est scellé puis ouvert dans la foulée — même
   chemin qu'un booster acheté, même sceau serveur, même tirage. */
$('m-debug-pack').addEventListener('click', () => {
    const user = state.user;
    const setId = tcgCurrentSetId(state.tcg);
    if (!user) return;
    if (!setId) { showToast('Crée d\'abord le set de la LAN.', 'error'); return; }
    // Synchrone dans le geste : c'est la condition d'iOS pour le gyroscope.
    askTiltPermission();

    const ref = db.ref('lan/tcg/packs').push();
    ref.set({
        uid: user.uid,
        setId: setId,
        status: 'sealed',
        sealedAt: firebase.database.ServerValue.TIMESTAMP,
        origin: 'debug'
        // Pas de `label` : l'emballage porte le nom de la soirée, pas celui du
        // bouton qui l'a créé. Personne n'ouvre un « booster de test ».
    })
        .then(() => ref.once('value'))
        .then(snapshot => {
            const pack = snapshot.val();
            if (pack) openPack(Object.assign({ id: ref.key }, pack));
        })
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
});

$('m-gift-pack').addEventListener('click', () => {
    if (!tcgCurrentSetId(state.tcg)) { showToast('Crée d\'abord le set de la LAN.', 'error'); return; }
    openSheet('Offrir un booster', (body) => {
        economyPlayers().forEach(uid => {
            const row = el('button', 'm-btn m-btn--full', playerName(uid));
            row.addEventListener('click', () => giftPack(uid));
            body.appendChild(row);
        });
    });
});

function giftPack(uid) {
    db.ref('lan/tcg/packs').push().set({
        uid: uid,
        setId: tcgCurrentSetId(state.tcg),
        status: 'sealed',
        sealedAt: firebase.database.ServerValue.TIMESTAMP,
        origin: 'gift'
    }).then(() => {
        closeSheet();
        showToast('Booster offert à ' + playerName(uid) + ' !', 'success');
    }).catch(e => showToast('Erreur : ' + e.message, 'error'));
}

/* ---------- Sceller ce qui a été acheté ----------
   Un booster validé par le maître du jeu donne droit à un paquet dont
   l'identifiant EST celui de la demande : un achat ne peut donc pas donner
   deux paquets, même si le client insiste. Le sceau, lui, est l'horodatage
   écrit par le serveur — c'est lui, et rien d'autre, qui décide du contenu. */
let sealing = false;
/* Un sceau refusé (règle, set changé, autre appareil plus rapide) ne se
   retente pas en boucle : on l'oublie jusqu'au prochain chargement. */
const sealFailures = new Set();

/* Les achats faits dans cette session ont déjà dit ce qu'il fallait dire au
   moment du clic. Les sceller ne doit pas produire un second message : acheter
   cinq boosters donnait dix bulles à la suite, et plus personne ne les lisait.

   Un paquet qui arrive SANS avoir été acheté ici — commandé depuis le
   téléphone, ou offert pendant qu'on était hors ligne — mérite au contraire
   d'être annoncé. C'est à ça que sert cette liste. */
const sealedQuietly = new Set();

function sealBoughtPacks() {
    const uid = state.user && state.user.uid;
    const setId = tcgCurrentSetId(state.tcg);
    if (!uid || !setId || sealing) return;

    const waiting = unsealedPurchases(state.economy, state.tcg, uid)
        .filter(purchase => !sealFailures.has(purchase.id));
    if (!waiting.length) return;

    sealing = true;
    const purchase = waiting[0];
    const quiet = sealedQuietly.has(purchase.id);

    db.ref('lan/tcg/packs/' + purchase.id).set({
        uid: uid,
        setId: setId,
        status: 'sealed',
        sealedAt: firebase.database.ServerValue.TIMESTAMP,
        origin: 'shop',
        label: purchase.itemName || 'Booster'
    })
        .then(() => { if (!quiet) showToast('Un booster t\'attend !', 'success'); })
        .catch(() => { sealFailures.add(purchase.id); })
        .finally(() => {
            sealing = false;
            sealedQuietly.delete(purchase.id);
            /* On enchaîne : trois boosters achetés d'affilée doivent donner
               trois paquets, pas un seul. */
            sealBoughtPacks();
        });
}

/* ---------- Mes paquets ---------- */

function renderMyPacks(view) {
    const section = $('m-packs-section');
    const mount = $('m-packs');
    const sealed = sealedPacksOf(state.tcg, view.uid);
    const waiting = unsealedPurchases(state.economy, state.tcg, view.uid).length;

    if (!sealed.length && !waiting) { section.style.display = 'none'; return; }
    section.style.display = 'flex';
    mount.innerHTML = '';

    sealed.forEach(pack => {
        const card = el('article', 'm-card m-card--pack');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title',
            pack.label || packLabel({ name: generatedArtNames[PACK_ART_KEY] }, state.settings.lanName)));
        top.appendChild(el('span', 'm-chip m-chip--gold', 'scellé'));
        card.appendChild(top);
        card.appendChild(el('p', 'm-card__meta',
            'Scellé ' + timeAgo(pack.sealedAt) + ' · ' + TCG.PACK_SIZE + ' cartes'));

        const open = el('button', 'm-btn m-btn--solid m-btn--full', 'Ouvrir');
        open.addEventListener('click', () => openPack(pack));
        card.appendChild(open);
        mount.appendChild(card);
    });

    if (waiting) {
        mount.appendChild(emptyState(waiting + ' booster' + (waiting > 1 ? 's' : '') + ' en cours de scellage…'));
    }
}

/* Le teaser d'accueil : un booster qui attend mérite qu'on le dise. */
function renderSealedTeaser() {
    const section = $('m-sealed-teaser-section');
    const mount = $('m-sealed-teaser');
    const uid = state.user && state.user.uid;
    const sealed = uid ? sealedPacksOf(state.tcg, uid) : [];
    if (!sealed.length) { section.style.display = 'none'; return; }

    section.style.display = 'flex';
    mount.innerHTML = '';
    const card = el('article', 'm-card m-card--pack');
    card.appendChild(el('h3', 'm-card__title',
        sealed.length > 1 ? sealed.length + ' boosters t\'attendent' : 'Un booster t\'attend'));
    card.appendChild(el('p', 'm-card__meta', 'Scellé, jamais ouvert. Personne ne sait ce qu\'il y a dedans.'));
    const go = el('button', 'm-btn m-btn--solid m-btn--full', 'Ouvrir');
    go.addEventListener('click', () => goto('cartes'));
    card.appendChild(go);
    mount.appendChild(card);
}

/* ---------- L'ouverture ---------- */

let revealQueue = [];
let revealDone = [];
/* Ce que le joueur possédait AVANT d'ouvrir : c'est ce qui distingue une
   nouvelle carte d'un double. Relevé avant l'écriture, parce qu'aussitôt le
   paquet marqué ouvert, le rejeu compte déjà ses cartes comme possédées. */
let revealOwned = new Set();
let opening = false;

/* Ouvrir, c'est écrire l'horodatage d'ouverture puis jouer la révélation. Le
   contenu se déduit du sceau : il était déjà décidé à l'achat, personne ne
   peut plus rien y changer — ni le joueur, ni nous. */
function openPack(pack) {
    if (opening) return;
    opening = true;

    /* Ici et pas dans le .then() qui suit : iOS n'accorde le capteur que si la
       demande part directement du geste de l'utilisateur. Passée l'écriture en
       base, l'activation transitoire est perdue et la promesse est rejetée. */
    askTiltPermission();

    const view = tcgSnapshot();
    const setCards = tcgSetCards(state.tcg, pack.setId);
    const due = pityCount(state.tcg, pack.uid) >= TCG.PITY;

    if (!Object.keys(setCards).length) {
        opening = false;
        showToast('Ce booster appartient à un set introuvable.', 'error');
        return;
    }

    const ownedBefore = new Set(view.cards
        .filter(card => card.owner === pack.uid)
        .map(card => card.gameKey));

    /* Le tirage vient APRÈS l'écriture, et relit le nœud : depuis que la
       graine contient `openedAt`, elle n'existe qu'une fois l'horodatage posé
       par le serveur. Tirer avant donnerait à celui qui ouvre des cartes que
       personne d'autre ne recalculerait. */
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
            startReveal(pack, drawn.map(card => Object.assign({}, card, {
                name: (setCards[card.gameKey] && setCards[card.gameKey].name) || card.gameKey,
                owner: pack.uid,
                mintedBy: pack.uid,
                mintedAt: Date.now(),
                lineage: [pack.uid]
            })), ownedBefore);
        })
        .catch(e => showToast('Erreur : ' + e.message, 'error'))
        .finally(() => { opening = false; });
}

/* L'ouverture se joue en trois temps : le paquet scellé qu'on déchire, les
   cartes une à une, puis la planche complète. On révèle du plus commun au plus
   rare, et le brillant en dernier à rareté égale — la tension doit monter,
   jamais retomber. */
let revealPhase = 'pack';   // 'pack' → 'cards' → 'spread'
let revealFlipping = false;
/* Un toucher arrivé pendant le demi-tour n'est pas perdu, il est mis de côté :
   quatorze cartes se tapotent au rythme du joueur, pas à celui de
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

    $('m-reveal-seal').textContent = 'Sceau ' + new Date(pack.sealedAt).toLocaleTimeString('fr-FR');

    /* Le nom et l'illustration du booster ne viennent pas du paquet mais de la
       soirée : un paquet créé pour un test ne doit pas s'appeler « test » aux
       yeux de celui qui l'ouvre. */
    const packArt = generatedArt[PACK_ART_KEY];
    $('m-reveal-packname').textContent = packLabel(
        { name: generatedArtNames[PACK_ART_KEY] }, state.settings.lanName);
    $('m-reveal-wrap').classList.toggle('has-art', !!packArt);
    if (packArt) $('m-reveal-packart').src = packArt;
    $('m-reveal-flip').innerHTML = '';
    $('m-reveal-spread').className = 'm-reveal__spread';
    $('m-reveal-spread').innerHTML = '';
    $('m-reveal-sparks').innerHTML = '';
    $('m-reveal-pack').className = 'm-reveal__pack';
    $('m-reveal-wrap').style.setProperty('--cut', '0');
    $('m-reveal-hint').textContent = CUT_HINT;
    cutFrom = null;
    cutReached = 0;
    $('m-reveal-mute').textContent = Sfx.isEnabled() ? '🔊' : '🔇';

    const overlay = $('m-reveal');
    overlay.className = 'm-reveal is-open is-pack';
    paintRevealFoot();
}

/* Les pastilles disent où on en est sans qu'on ait à lire un compteur, et se
   colorent à la rareté déjà sortie : la planche se dessine au fur et à
   mesure. */
function paintRevealFoot() {
    const dots = $('m-reveal-dots');
    dots.innerHTML = '';
    if (revealPhase !== 'cards') {
        $('m-reveal-all').style.display = 'none';
        $('m-reveal-next').textContent = revealPhase === 'pack'
            ? 'Ouvrir' : 'Ranger dans ma collection';
        return;
    }

    revealDone.concat(revealQueue).forEach((card, i) => {
        const dot = el('span', 'm-reveal__dot');
        if (i < revealDone.length) dot.classList.add('is-done', 'is-' + card.rarity);
        dots.appendChild(dot);
    });
    $('m-reveal-all').style.display = revealQueue.length > 1 ? 'block' : 'none';
    $('m-reveal-next').textContent = revealQueue.length ? 'Carte suivante' : 'Voir le paquet';
}

/* Ce que chaque rareté déclenche à la révélation. Tout ne secoue pas l'écran :
   si la commune fait le même bruit que la prestige, plus rien ne compte. */
const RARITY_FX = {
    signature: { sparks: 30, rays: true,  shake: true,  flash: true },
    common:   { sparks: 0,  rays: false, shake: false, flash: false },
    uncommon: { sparks: 0,  rays: false, shake: false, flash: false },
    rare:     { sparks: 8,  rays: false, shake: false, flash: false },
    epic:     { sparks: 14, rays: true,  shake: true,  flash: true },
    showcase: { sparks: 22, rays: true,  shake: true,  flash: true }
};

const SPARK_COLORS = {
    signature: '#ffb066',
    rare: '#b79dff',
    epic: '#e6a2ff',
    showcase: '#ffd76a'
};

/* Les éclats qui giclent du centre. Ils partent en couronne, avec assez de
   désordre pour ne pas ressembler à une horloge. */
function fireSparks(rarity, count) {
    const box = $('m-reveal-sparks');
    box.innerHTML = '';
    if (!count || REDUCED_MOTION) return;

    const color = SPARK_COLORS[rarity] || '#ffd76a';
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
        const distance = 90 + Math.random() * 130;
        const spark = el('span', 'm-reveal__spark');
        spark.style.setProperty('--sx', Math.cos(angle) * distance + 'px');
        spark.style.setProperty('--sy', Math.sin(angle) * distance + 'px');
        spark.style.setProperty('--spark', color);
        spark.style.animationDelay = (Math.random() * 90) + 'ms';
        box.appendChild(spark);
    }
    setTimeout(() => { box.innerHTML = ''; }, 1100);
}

/* Le retournement, sans preserve-3d : la carte pivote jusqu'à la tranche, on
   échange son contenu à mi-parcours, puis elle revient. Deux animations
   plates valent mieux qu'une scène 3D, qui se brouille avec les modes de
   fusion du brillant sur certains Android. */
function flipToCard(card, isNew) {
    const flip = $('m-reveal-flip');
    const burst = $('m-reveal-burst');
    const rays = $('m-reveal-rays');
    const overlay = $('m-reveal');
    const fx = RARITY_FX[card.rarity] || RARITY_FX.common;

    revealFlipping = true;
    Sfx.flip();
    flip.className = 'm-reveal__flip is-out';

    setTimeout(() => {
        const node = cardNode(card, { badge: isNew ? 'NOUVELLE' : 'double' });
        node.classList.add('m-tcard--reveal');
        flip.innerHTML = '';
        flip.appendChild(node);
        // Le retour est d'autant plus ample que la carte est rare.
        flip.className = 'm-reveal__flip is-in is-' + card.rarity;

        // L'éclat derrière la carte porte la couleur de sa rareté : on sait ce
        // qu'on a sorti avant même d'avoir lu le nom.
        burst.className = 'm-reveal__burst is-firing is-' + card.rarity;
        void burst.offsetWidth;

        rays.className = fx.rays ? 'm-reveal__rays is-firing is-' + card.rarity : 'm-reveal__rays';
        if (fx.rays) void rays.offsetWidth;

        fireSparks(card.rarity, fx.sparks);
        Sfx.reveal(card.rarity);

        overlay.classList.remove('is-shake', 'is-flash', 'is-flash-epic', 'is-flash-showcase');
        void overlay.offsetWidth;
        if (fx.shake && !REDUCED_MOTION) overlay.classList.add('is-shake');
        if (fx.flash && !REDUCED_MOTION) overlay.classList.add('is-flash', 'is-flash-' + card.rarity);

        /* Rendu dès que la carte est posée, sans attendre la fin du retour :
           quatorze cartes, ça se tapote vite, et un verrou d'une demi-seconde
           avalerait un clic sur deux. Seul le demi-tour aller est protégé,
           parce que c'est là que le contenu s'échange. */
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
        showToast(rarityMeta(card.rarity).label + ' ! ' + card.name, 'success');
    }
    paintRevealFoot();
}

/* La planche : les quatorze cartes d'un coup d'œil, dans l'ordre où on les a
   sorties, avec ce que le paquet a vraiment apporté. */
function showRevealSpread() {
    revealPhase = 'spread';
    const spread = $('m-reveal-spread');
    spread.innerHTML = '';

    const fresh = revealDone.filter((card, i) =>
        revealDone.findIndex(other => other.gameKey === card.gameKey) === i).length;

    revealDone.forEach((card, i) => {
        const node = cardNode(card, { small: true, onClick: () => openCardSheet(card) });
        node.style.animationDelay = (i * 35) + 'ms';
        // Chaque carte se pose de travers, d'un côté ou de l'autre : une main
        // qui étale des cartes ne les aligne pas au millimètre.
        node.style.setProperty('--deal-tilt', ((i % 2 ? 1 : -1) * (3 + (i % 3))) + 'deg');
        node.classList.add('m-tcard--dealt');
        spread.appendChild(node);
    });

    const best = revealDone.slice().sort((a, b) => rarityIndex(a.rarity) - rarityIndex(b.rarity))[0];
    $('m-reveal-seal').textContent = revealDone.length + ' cartes · '
        + fresh + ' jeu' + (fresh > 1 ? 'x' : '') + ' différent' + (fresh > 1 ? 's' : '')
        + (best ? ' · meilleure : ' + rarityMeta(best.rarity).label : '');

    $('m-reveal').className = 'm-reveal is-open is-spread';
    paintRevealFoot();
}

/* « Ranger dans ma collection » ne fait pas que fermer : les quatorze cartes se
   rassemblent pour de bon. Chacune file vers le bas de l'écran en tournant,
   d'après sa position réelle — c'est le geste de ramasser un paquet étalé sur
   la table. */
function gatherAndClose() {
    const spread = $('m-reveal-spread');
    const cards = Array.from(spread.querySelectorAll('.m-tcard'));

    if (REDUCED_MOTION || !cards.length) { closeReveal(); return; }

    const target = { x: window.innerWidth / 2, y: window.innerHeight - 40 };
    cards.forEach((card, i) => {
        const box = card.getBoundingClientRect();
        card.style.setProperty('--gx', Math.round(target.x - (box.left + box.width / 2)) + 'px');
        card.style.setProperty('--gy', Math.round(target.y - (box.top + box.height / 2)) + 'px');
        card.style.setProperty('--gr', ((i % 2 ? 1 : -1) * (8 + i * 2)) + 'deg');
        // Les dernières partent en premier : la pile se referme du bas.
        card.style.animationDelay = ((cards.length - i) * 14) + 'ms';
    });

    spread.classList.add('is-gathering');
    Sfx.gather();
    setTimeout(closeReveal, 420 + cards.length * 14);
}

/* Le son se coupe et se retient : une LAN se joue souvent en vocal, et un
   booster qui claque dans le micro de tout le monde n'amuse personne. */
$('m-reveal-mute').addEventListener('click', () => {
    const on = Sfx.toggle();
    $('m-reveal-mute').textContent = on ? '🔊' : '🔇';
    $('m-reveal-mute').setAttribute('aria-label', on ? 'Couper le son' : 'Remettre le son');
});

function closeReveal() {
    $('m-reveal').className = 'm-reveal';
    $('m-reveal-flip').innerHTML = '';
    $('m-reveal-spread').className = 'm-reveal__spread';
    $('m-reveal-spread').innerHTML = '';
    $('m-reveal-sparks').innerHTML = '';
    revealQueue = [];
    revealDone = [];
    renderAll();
}

/* Déchirer le paquet : on peut glisser le doigt dessus (la fente suit, et
   au-delà de la moitié le paquet cède) ou simplement toucher. */
function tearPack() {
    if (revealPhase !== 'pack') return;
    revealPhase = 'cards';
    const pack = $('m-reveal-pack');
    pack.classList.remove('is-tearing');
    pack.classList.add('is-torn');
    // L'entaille file jusqu'au bord : c'est elle qui déclenche tout le reste.
    setCut(1);
    Sfx.packOpen();
    paintRevealFoot();

    /* Le paquet reste à l'écran le temps de s'ouvrir en entier — la bande
       s'envole, la lumière explose, les cartes montent. Basculer tout de suite
       sur la scène des cartes masquerait le seul moment où l'on voit le paquet
       céder, c'est-à-dire tout l'intérêt du geste. */
    setTimeout(() => {
        $('m-reveal').className = 'm-reveal is-open is-cards';
        revealNextCard();
    }, 560);
}

/* Un seul geste fait tout avancer : le paquet s'ouvre, les cartes défilent,
   la planche s'affiche, la collection se range. C'est ce que fait le bouton du
   bas — la scène et la barre d'espace font exactement la même chose, pour
   qu'on puisse enchaîner les boosters sans jamais viser.

   Le piège d'avant : la scène ne réagissait que s'il RESTAIT des cartes. Sur la
   dernière, cliquer ne faisait plus rien et il fallait aller chercher le
   bouton. On avançait quatorze fois d'un geste, puis on butait. */
function advanceReveal() {
    if (revealPhase === 'pack') { tearPack(); return; }
    if (revealPhase === 'cards') {
        if (revealQueue.length) revealNextCard();
        else if (!revealFlipping) showRevealSpread();
        return;
    }
    gatherAndClose();
}

$('m-reveal-next').addEventListener('click', advanceReveal);

/* Toucher la scène avance aussi : on ne vise pas un bouton quatorze fois. */
$('m-reveal-stage').addEventListener('click', advanceReveal);


/* Le paquet entier d'un coup, pour qui a déjà ouvert dix boosters. */
$('m-reveal-all').addEventListener('click', () => {
    while (revealQueue.length) {
        const card = revealQueue.shift();
        revealOwned.add(card.gameKey);
        revealDone.push(card);
    }
    revealFlipping = false;
    revealPending = false;
    showRevealSpread();
});

/* Le glissement qui déchire. On mesure la course du doigt sur la hauteur du
   paquet : la fente s'ouvre en proportion, et passé 55 % l'emballage cède. Un
   simple toucher (course quasi nulle) ouvre aussi — il ne faut pas obliger
   quelqu'un à découvrir un geste pour ouvrir son booster. */
/* Le glissement qui tranche. Le geste est LATÉRAL, comme sur un vrai paquet :
   on entaille la bande du haut d'un bord à l'autre. La course est mesurée une
   fois, au premier contact — relire la géométrie à chaque déplacement du doigt
   forcerait un recalcul de mise en page par pixel parcouru. */
let cutFrom = null;
let cutSpan = 0;
let cutReached = 0;

const CUT_HINT = 'Glisse le doigt en travers';

function setCut(value) {
    cutReached = value;
    $('m-reveal-wrap').style.setProperty('--cut', value.toFixed(3));
}

/* Le dernier cran sonore franchi. L'entaille craque par paliers plutôt qu'à
   chaque pixel : c'est ce qui lui donne son grain de fermeture éclair, et ça
   évite de lancer cinquante sons par glissement. */
let cutHeard = 0;

$('m-reveal-pack').addEventListener('pointerdown', (e) => {
    if (revealPhase !== 'pack') return;
    cutFrom = e.clientX;
    cutHeard = 0;
    // La largeur du paquet : trancher, c'est le traverser.
    cutSpan = Math.max(60, $('m-reveal-wrap').getBoundingClientRect().width * 0.8);
    $('m-reveal-pack').classList.add('is-tearing');
    // Premier contact : c'est le geste qui autorise le son sur iOS.
    Sfx.wake();
});

$('m-reveal-pack').addEventListener('pointermove', (e) => {
    if (cutFrom === null) return;
    // La valeur absolue : on tranche de gauche à droite ou l'inverse, peu importe.
    const progress = Math.max(0, Math.min(1, Math.abs(e.clientX - cutFrom) / cutSpan));
    setCut(progress);
    if (progress - cutHeard >= 0.07) { cutHeard = progress; Sfx.cut(progress); }
    $('m-reveal-hint').textContent = progress > 0.25 ? 'Encore…' : CUT_HINT;
    if (progress >= 0.75) { cutFrom = null; tearPack(); }
}, { passive: true });

$('m-reveal-pack').addEventListener('pointerup', () => {
    if (cutFrom === null) return;
    cutFrom = null;
    // Course trop courte : c'était un simple toucher, on ouvre quand même.
    if (cutReached < 0.12) { tearPack(); return; }
    // Relâché à mi-chemin : l'entaille se referme.
    $('m-reveal-pack').classList.remove('is-tearing');
    setCut(0);
    $('m-reveal-hint').textContent = CUT_HINT;
});

$('m-reveal-pack').addEventListener('pointercancel', () => {
    cutFrom = null;
    $('m-reveal-pack').classList.remove('is-tearing');
    setCut(0);
});

/* ==========================================================================
   LE BRILLANT VIVANT
   Une carte brillante doit donner envie de la bouger. Trois façons de la
   bouger selon l'appareil, une seule sortie : les variables CSS --px / --py
   (position du reflet), --pxn / --pyn (décalage du voile, -0.5 à 0.5),
   --pfc (distance au centre, qui dose l'intensité) et --rx / --ry
   (inclinaison de la carte).

   1. Le pointeur — souris, doigt ou stylet. On passe par Pointer Events, qui
      couvre les trois d'un coup : pas de code séparé pour le tactile.
   2. Le gyroscope du téléphone, quand il répond.
   3. Rien du tout : l'animation CSS par défaut prend le relais.
   ========================================================================== */

const REDUCED_MOTION = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Quelles cartes réagissent au pointeur : les brillantes partout, et la carte
   mise en scène (révélation, fiche) même ordinaire — c'est là qu'on la
   regarde vraiment. */
const LIVE_CARD_SELECTOR = '.m-tcard.is-foil, .m-tcard--reveal, .m-tcard-solo .m-tcard';

let liveCard = null;
let livePointer = null;
/* Un booléen posé AVANT la demande d'image, et levé dans le rappel : dans cet
   ordre, le drapeau ne peut pas rester coincé à « en attente » et figer le
   reflet pour le reste de la session. */
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

    card.style.setProperty('--px', (x * 100).toFixed(2) + '%');
    card.style.setProperty('--py', (y * 100).toFixed(2) + '%');
    card.style.setProperty('--pxn', dx.toFixed(3));
    card.style.setProperty('--pyn', dy.toFixed(3));
    card.style.setProperty('--pfc', Math.min(1, Math.hypot(dx, dy) * 2).toFixed(3));
    card.style.setProperty('--rx', (dy * -12).toFixed(2) + 'deg');
    card.style.setProperty('--ry', (dx * 12).toFixed(2) + 'deg');
}

function releaseLiveCard() {
    if (!liveCard) return;
    liveCard.classList.remove('is-live');
    ['--px', '--py', '--pxn', '--pyn', '--pfc', '--rx', '--ry']
        .forEach(name => liveCard.style.removeProperty(name));
    liveCard = null;
    livePointer = null;
}

/* Un seul écouteur pour toute la page, et un rendu par image : la grille peut
   afficher cinquante cartes, et cinquante écouteurs qui écrivent du style à
   chaque pixel parcouru feraient ramer le téléphone bien avant le PC. */
document.addEventListener('pointermove', (e) => {
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

/* Le doigt quitte l'écran : la carte se repose. Sans ça, elle resterait figée
   en biais après un glissement sur téléphone. */
document.addEventListener('pointerup', releaseLiveCard, { passive: true });
document.addEventListener('pointercancel', releaseLiveCard, { passive: true });
window.addEventListener('blur', releaseLiveCard);

/* iOS exige que requestPermission() parte d'un geste de l'utilisateur, et la
   promesse est rejetée si l'appel arrive après un await : il doit être
   SYNCHRONE dans le gestionnaire de clic, jamais dans un .then(). D'où
   l'appel en tête d'ouverture de paquet et au toucher d'une carte. */
let tiltAsked = false;

function askTiltPermission() {
    if (tiltAsked || REDUCED_MOTION) return;
    tiltAsked = true;
    const api = window.DeviceOrientationEvent;
    if (!api) return;
    if (typeof api.requestPermission === 'function') {
        api.requestPermission()
            .then(result => { if (result === 'granted') listenToTilt(); })
            .catch(() => { /* refusé : le brillant garde son animation */ });
    } else {
        // Android et les navigateurs de bureau n'ont rien à demander.
        listenToTilt();
    }
}

function listenToTilt() {
    window.addEventListener('deviceorientation', (e) => {
        /* On n'active le mode inclinaison qu'à la première mesure réelle. Un
           téléphone sans gyroscope, ou un PC, émet des événements vides : les
           prendre pour argent comptant figerait le brillant sur une position
           morte au lieu de le laisser respirer. */
        if (e.gamma === null || e.beta === null) return;
        const x = Math.max(-0.5, Math.min(0.5, Number(e.gamma) / 90));
        const y = Math.max(-0.5, Math.min(0.5, Number(e.beta) / 90));
        const root = document.documentElement;
        if (!root.classList.contains('has-tilt')) root.classList.add('has-tilt');
        root.style.setProperty('--pxn', x.toFixed(3));
        root.style.setProperty('--pyn', y.toFixed(3));
    });
}

/* ---------- La grille du set ---------- */

let setFilter = 'all';

$('m-set-filter').addEventListener('click', () => {
    const options = ['all', 'missing', 'owned'];
    setFilter = options[(options.indexOf(setFilter) + 1) % options.length];
    $('m-set-filter').textContent = setFilter === 'all' ? 'Tout'
        : (setFilter === 'missing' ? 'Manquantes' : 'Possédées');
    renderCartes();
});

/* La grille du set, rangée par rareté. Un set de cinq cents cartes affiché à
   plat n'est pas une collection, c'est un annuaire : on ne voit ni où on en
   est, ni ce qui vaut la peine. Groupé, chaque rareté annonce sa complétion et
   les cartes de chasse sont en tête, là où on les cherche.

   Le bas du set reste replié par défaut : personne ne veut faire défiler
   trois cent trente silhouettes de communes pour trouver ses prestiges. */
const openRarities = new Set(['signature', 'showcase', 'epic', 'rare']);

function renderSetGrid(view) {
    const mount = $('m-set-grid');
    mount.innerHTML = '';

    if (!view.set) {
        mount.appendChild(emptyState('Le set de la LAN n\'a pas encore été créé.'));
        return;
    }

    const rows = collectionBySet(view.setCards, view.cards, view.uid)
        .filter(row => setFilter === 'all'
            || (setFilter === 'missing' && !row.owned)
            || (setFilter === 'owned' && row.owned));

    if (!rows.length) {
        mount.appendChild(emptyState(setFilter === 'missing'
            ? 'Rien ne manque. Set complet.'
            : 'Aucune carte pour l\'instant. Un booster, et ça commence.'));
        return;
    }

    TCG.RARITIES.forEach(rarity => {
        const group = rows.filter(row => row.rarity === rarity.key);
        if (!group.length) return;

        const owned = group.filter(row => row.owned).length;
        const head = el('button', 'm-raritybar m-raritybar--' + rarity.key);
        head.appendChild(el('span', 'm-raritybar__gem'));
        head.appendChild(el('span', 'm-raritybar__label', rarity.label));
        head.appendChild(el('span', 'm-raritybar__count', owned + ' / ' + group.length));
        head.appendChild(el('span', 'm-raritybar__chev', openRarities.has(rarity.key) ? '▾' : '▸'));
        head.addEventListener('click', () => {
            if (openRarities.has(rarity.key)) openRarities.delete(rarity.key);
            else openRarities.add(rarity.key);
            renderSetGrid(tcgSnapshot());
        });
        mount.appendChild(head);

        if (!openRarities.has(rarity.key)) return;

        const grid = el('div', 'm-cardgrid');
        group.forEach(row => {
            const best = row.copies.find(copy => copy.foil) || row.copies[0];
            /* La silhouette d'une carte manquante porte quand même son appId :
               sans lui, elle n'aurait aucune illustration à griser. */
            const card = best || {
                gameKey: row.gameKey, name: row.name, rarity: row.rarity,
                appId: row.appId, foil: false
            };
            grid.appendChild(cardNode(card, {
                missing: !row.owned,
                badge: row.copies.length > 1 ? '×' + row.copies.length : '',
                onClick: () => (best
                    ? openCardSheet(best)
                    : showToast(row.name + ' — pas encore dans ta collection.', 'error'))
            }));
        });
        mount.appendChild(grid);
    });
}

/* ---------- Les doubles ---------- */

function renderDupes(view) {
    const section = $('m-dupes-section');
    const mount = $('m-dupes');
    const dupes = duplicatesOf(view.cards, view.uid);

    if (!dupes.length) { section.style.display = 'none'; return; }
    section.style.display = 'flex';
    mount.innerHTML = '';
    dupes.forEach(card => mount.appendChild(cardNode(card, {
        small: true,
        onClick: () => openCardSheet(card)
    })));
}

/* ---------- Les échanges ----------
   Rien n'est vérifié à l'écriture : les règles Firebase ne savent pas dire qui
   possède quoi. C'est le rejeu qui tranche, et un échange malhonnête n'est pas
   refusé — il est sans effet, à la vue de tous dans le journal. */

$('m-trade-new').addEventListener('click', openTradeBuilder);

function openTradeBuilder() {
    const view = tcgSnapshot();
    const others = economyPlayers().filter(uid => uid !== view.uid
        && view.cards.some(card => card.owner === uid));

    if (!others.length) {
        showToast('Personne d\'autre n\'a encore de cartes.', 'error');
        return;
    }

    let target = others[0];
    const offer = new Set();
    const request = new Set();

    openSheet('Proposer un échange', (body) => {
        const who = el('select', 'm-input');
        others.forEach(uid => {
            const option = el('option', null, playerName(uid));
            option.value = uid;
            who.appendChild(option);
        });
        who.value = target;
        body.appendChild(who);

        const mineTitle = el('p', 'm-shop__cat', 'Je donne');
        const mineRow = el('div', 'm-cardrow');
        const theirsTitle = el('p', 'm-shop__cat', 'Je demande');
        const theirsRow = el('div', 'm-cardrow');
        const submit = el('button', 'm-btn m-btn--solid m-btn--full', 'Envoyer la proposition');

        const paint = () => {
            mineRow.innerHTML = '';
            theirsRow.innerHTML = '';

            /* Les doubles d'abord : c'est ce qu'on troque, le reste on le garde. */
            const dupes = duplicatesOf(view.cards, view.uid);
            const dupeIds = new Set(dupes.map(card => card.id));
            const mine = dupes.concat(collectionOf(view.cards, view.uid).filter(card => !dupeIds.has(card.id)));

            if (!mine.length) mineRow.appendChild(emptyState('Tu n\'as aucune carte à offrir.'));
            mine.forEach(card => mineRow.appendChild(cardNode(card, {
                small: true,
                selected: offer.has(card.id),
                badge: dupeIds.has(card.id) ? 'double' : '',
                onClick: () => { togglePick(offer, card.id); paint(); }
            })));

            const theirs = collectionOf(view.cards, target);
            if (!theirs.length) theirsRow.appendChild(emptyState('Ce joueur n\'a aucune carte.'));
            theirs.forEach(card => theirsRow.appendChild(cardNode(card, {
                small: true,
                selected: request.has(card.id),
                onClick: () => { togglePick(request, card.id); paint(); }
            })));

            submit.disabled = !offer.size && !request.size;
            submit.textContent = (offer.size || request.size)
                ? 'Proposer : ' + offer.size + ' contre ' + request.size
                : 'Choisis au moins une carte';
        };

        who.addEventListener('change', () => {
            target = who.value;
            request.clear();
            paint();
        });

        submit.addEventListener('click', () => sendTrade(target, Array.from(offer), Array.from(request)));

        body.append(mineTitle, mineRow, theirsTitle, theirsRow, submit);
        paint();
    });
}

function togglePick(set, id) {
    if (set.has(id)) { set.delete(id); return; }
    if (set.size >= TCG.TRADE_MAX) {
        showToast('Six cartes par côté, pas plus.', 'error');
        return;
    }
    set.add(id);
}

function sendTrade(toUid, offer, request) {
    const user = state.user;
    if (!user) return;
    db.ref('lan/tcg/trades').push().set({
        fromUid: user.uid,
        fromName: user.displayName || 'Un joueur',
        toUid: toUid,
        toName: playerName(toUid),
        offer: serializeCardList(offer),
        request: serializeCardList(request),
        status: 'pending',
        ts: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
        closeSheet();
        showToast('Proposition envoyée à ' + playerName(toUid) + '.', 'success');
    }).catch(e => showToast('Erreur : ' + e.message, 'error'));
}

function resolveTrade(trade, status) {
    db.ref('lan/tcg/trades/' + trade.id).update({
        status: status,
        resolvedAt: firebase.database.ServerValue.TIMESTAMP
    })
        .then(() => showToast(status === 'accepted' ? 'Échange conclu !' : 'C\'est noté.', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

/* Le résumé d'une proposition : deux colonnes de cartes, sans jargon. */
function tradeCard(trade, view, mine) {
    const byId = new Map(view.cards.map(card => [card.id, card]));
    const card = el('article', 'm-card');
    const top = el('div', 'm-card__top');
    top.appendChild(el('h3', 'm-card__title',
        mine ? 'À ' + playerName(trade.toUid) : 'De ' + playerName(trade.fromUid)));
    top.appendChild(el('span', 'm-chip', timeAgo(trade.ts)));
    card.appendChild(top);

    const side = (label, ids) => {
        card.appendChild(el('p', 'm-shop__cat', label));
        const row = el('div', 'm-cardrow');
        if (!ids.length) row.appendChild(emptyState('Rien'));
        ids.forEach(id => {
            const owned = byId.get(id);
            row.appendChild(owned
                ? cardNode(owned, { small: true, onClick: () => openCardSheet(owned) })
                : emptyState('Carte introuvable'));
        });
        card.appendChild(row);
    };

    side(mine ? 'Je donne' : playerName(trade.fromUid) + ' donne', trade.offer);
    side(mine ? 'Je demande' : 'En échange de', trade.request);

    if (!tradeStillValid(view.cards, trade)) {
        card.appendChild(el('p', 'm-card__meta',
            '⚠️ Caduque : une des cartes a changé de mains depuis. L\'accepter n\'aurait aucun effet.'));
    }

    return card;
}

function renderTradesIn(view) {
    const section = $('m-trade-in-section');
    const mount = $('m-trade-in');
    const trades = pendingTradesFor(state.tcg, view.uid);
    if (!trades.length) { section.style.display = 'none'; return; }

    section.style.display = 'flex';
    mount.innerHTML = '';
    trades.forEach(trade => {
        const card = tradeCard(trade, view, false);
        const accept = el('button', 'm-btn m-btn--solid m-btn--sm m-btn--full', 'Accepter');
        accept.disabled = !tradeStillValid(view.cards, trade);
        accept.addEventListener('click', () => resolveTrade(trade, 'accepted'));
        card.appendChild(accept);
        const decline = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Refuser');
        decline.addEventListener('click', () => resolveTrade(trade, 'declined'));
        card.appendChild(decline);
        mount.appendChild(card);
    });
}

function renderTradesOut(view) {
    const section = $('m-trade-out-section');
    const mount = $('m-trade-out');
    const trades = pendingTradesFrom(state.tcg, view.uid);
    if (!trades.length) { section.style.display = 'none'; return; }

    section.style.display = 'flex';
    mount.innerHTML = '';
    trades.forEach(trade => {
        const card = tradeCard(trade, view, true);
        const cancel = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Annuler');
        cancel.addEventListener('click', () => resolveTrade(trade, 'cancelled'));
        card.appendChild(cancel);
        mount.appendChild(card);
    });
}

function renderTcgLeaderboard(view) {
    const mount = $('m-tcg-leaderboard');
    mount.innerHTML = '';
    const board = tcgLeaderboard(view.setCards, view.cards, economyPlayers());
    if (!board.length) {
        mount.appendChild(emptyState('Personne n\'a encore ouvert de booster.'));
        return;
    }
    board.slice(0, 10).forEach((row, i) => {
        const line = el('button', 'm-podium m-podium--' + (i + 1));
        line.addEventListener('click', () => openProfile(row.uid));
        line.appendChild(el('span', 'm-podium__pos', String(i + 1)));
        const face = el('img', 'm-podium__face');
        face.src = playerPhoto(row.uid);
        face.alt = '';
        line.appendChild(face);
        line.appendChild(el('span', 'm-podium__name', playerFullName(playerName(row.uid), playerNickname(achData(), row.uid))));
        line.appendChild(el('span', 'm-price', row.owned + '/' + row.total));
        mount.appendChild(line);
    });
}

/* Le journal est public, comme le registre des points : entre amis, la
   transparence fait le travail que les règles ne peuvent pas faire. */
function renderTradeFeed(view) {
    const mount = $('m-trade-feed');
    mount.innerHTML = '';
    const feed = tcgTrades(state.tcg).filter(trade => trade.status !== 'pending').slice(0, 15);
    if (!feed.length) {
        mount.appendChild(emptyState('Aucun échange pour le moment.'));
        return;
    }
    const words = { accepted: 'conclu', declined: 'refusé', cancelled: 'annulé' };
    feed.forEach(trade => {
        const row = el('div', 'm-move');
        const who = el('span', 'm-move__who', playerName(trade.fromUid) + ' → ' + playerName(trade.toUid));
        /* « Sans effet » se lit dans le rejeu, jamais dans l'état actuel : une
           fois l'échange conclu, les cartes ne sont plus chez leur émetteur —
           les recompter dirait le contraire de la vérité. */
        const effective = view.applied.has(trade.id);
        who.appendChild(el('span', 'm-move__why',
            trade.offer.length + ' contre ' + trade.request.length
            + ' · ' + (words[trade.status] || trade.status)
            + (trade.status === 'accepted' && !effective ? ' (sans effet)' : '')
            + ' · ' + timeAgo(trade.resolvedAt || trade.ts)));
        row.appendChild(who);
        mount.appendChild(row);
    });
}


/* ==========================================================================
   Hauts faits
   Les jalons se CALCULENT depuis les données du moment (core.js), mais ce qui
   fait foi, c'est la récompense inscrite au journal : sans elle, un jalon
   gagné ce soir se reverrouillerait à la prochaine LAN, quand les compteurs de
   la soirée repartent à zéro.

   L'inscription est faite par les clients des maîtres du jeu, comme la
   validation des achats. La clé est déterministe, donc deux maîtres du jeu en
   ligne écrivent le même nœud plutôt que deux récompenses.
   ========================================================================== */

/* Les pictogrammes, au trait, à la taille du texte. Pas d'emoji : ils ne se
   recolorent pas et rendent différemment sur chaque téléphone. */
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

function achIcon(key) {
    const wrap = el('span', 'm-achline__ico');
    wrap.appendChild(iconSvg(ACH_ICONS[key] || ACH_ICONS.trophy));
    return wrap;
}

/* Les données que core.js attend pour calculer les compteurs. Le rejeu des
   cartes est le seul calcul lourd : il est fait UNE fois et partagé. */
function achData() {
    return {
        economy: state.economy,
        tcg: state.tcg,
        cards: tcgSnapshot().cards,
        xp: state.xp,
        history: state.history,
        votes: state.votes,
        settings: state.settings,
        quests: state.quests,
        profiles: state.profiles,
        roles: state.roles,
        adminUid: ADMIN_UID
    };
}

function renderAchSummary() {
    const uid = state.user && state.user.uid;
    const rows = achievementState(achData(), uid);
    const owned = rows.filter(r => r.owned).length;
    const pending = rows.filter(r => r.pending).length;

    $('m-ach-n').textContent = String(owned);
    const sub = $('m-ach-sub');
    if (pending) {
        sub.textContent = pending + (pending > 1 ? ' viennent' : ' vient') + ' d\'être atteint'
            + (pending > 1 ? 's' : '') + ' !';
    } else if (owned) {
        sub.textContent = owned + ' sur ' + rows.length + ' débloqués';
    } else {
        sub.textContent = 'Aucun pour l\'instant — il y en a ' + rows.length + ' à décrocher';
    }
}

function renderHautsFaits() {
    const uid = state.user && state.user.uid;
    if (!uid) return;

    paintXpBar('m-ach-level', 'm-ach-count', 'm-ach-segs', 'm-ach-foot');

    const rows = achievementState(achData(), uid);
    const owned = rows.filter(r => r.owned).length;
    $('m-ach-progress').textContent = owned + ' / ' + rows.length;

    const mount = $('m-ach-list');
    mount.innerHTML = '';

    /* Obtenus d'abord, puis ceux qui sont à portée, puis le reste. On montre
       ce qu'on a et ce qui est presque là ; le lointain peut attendre. */
    rows.slice()
        .sort((a, b) => (b.owned ? 1 : 0) - (a.owned ? 1 : 0)
            || (b.pending ? 1 : 0) - (a.pending ? 1 : 0)
            || b.ratio - a.ratio)
        .forEach(row => mount.appendChild(buildAchLine(row)));

    renderLanTitles();
    renderXpBoard();
}

function buildAchLine(row) {
    const line = el('div', 'm-achline');
    if (row.owned) line.classList.add('is-owned');
    else if (row.pending) line.classList.add('is-pending');

    line.appendChild(achIcon(row.ach.icon));

    const main = el('div', 'm-achline__main');
    main.appendChild(el('span', 'm-achline__name', row.ach.label));

    if (row.owned) {
        main.appendChild(el('span', 'm-achline__hint', row.ach.hint));
    } else if (row.pending) {
        main.appendChild(el('span', 'm-achline__hint',
            'Atteint — en attente d\'un maître du jeu'));
    } else {
        main.appendChild(el('span', 'm-achline__hint',
            row.ach.hint + ' · ' + row.current + ' / ' + row.goal));
        const bar = el('div', 'm-achline__bar');
        const fill = el('div', 'm-achline__fill');
        fill.style.width = Math.round(row.ratio * 100) + '%';
        bar.appendChild(fill);
        main.appendChild(bar);
    }
    line.appendChild(main);

    line.appendChild(el('span', 'm-achline__xp', '+' + row.ach.xp));
    return line;
}

/* Les titres de la soirée en cours : comparatifs, donc provisoires tant que la
   LAN n'est pas close. On le dit — un titre qui bouge sans prévenir passerait
   pour un bug. */
function renderLanTitles() {
    const section = $('m-titles-section');
    const mount = $('m-titles');
    const titles = lanTitles(achData(), economyPlayers());

    if (!titles.length) { section.style.display = 'none'; return; }
    section.style.display = 'flex';
    mount.innerHTML = '';

    titles.forEach(entry => {
        const row = el('div', 'm-title');
        row.appendChild(el('span', 'm-title__label', entry.title.label));
        row.appendChild(el('span', 'm-title__who', playerName(entry.uid)));
        mount.appendChild(row);
    });

    const note = el('p', 'm-card__meta',
        state.settings.lanFinished
            ? 'Décernés à la clôture.'
            : 'Provisoire : les titres sont décernés à la clôture de la soirée.');
    mount.appendChild(note);
}

function renderXpBoard() {
    const mount = $('m-xp-board');
    mount.innerHTML = '';
    const board = xpLeaderboard(state.xp, economyPlayers());

    if (!board.length) {
        mount.appendChild(emptyState('Personne n\'a encore d\'expérience.'));
        return;
    }

    board.slice(0, 10).forEach((row, i) => {
        const line = el('button', 'm-podium m-podium--' + (i + 1));
        line.addEventListener('click', () => openProfile(row.uid));
        line.appendChild(el('span', 'm-podium__pos', String(i + 1)));
        const face = el('img', 'm-podium__face');
        face.src = playerPhoto(row.uid);
        face.alt = '';
        line.appendChild(face);
        const main = el('span', 'm-podium__name', playerFullName(playerName(row.uid), playerNickname(achData(), row.uid)));
        line.appendChild(main);
        line.appendChild(el('span', 'm-price', levelTitle(row.level)));
        mount.appendChild(line);
    });
}

/* ---------- L'arbitre ----------
   Tourne sur les clients des maîtres du jeu. Il n'invente rien : il inscrit ce
   que tout le monde peut déjà calculer. Un joueur seul verra ses hauts faits
   « atteints » sans être inscrits jusqu'à ce qu'un maître du jeu se connecte —
   c'est la même dépendance que la validation des achats. */

let granting = false;

function grantPendingAchievements() {
    const user = state.user;
    if (!user || !state.isGamemaster || granting || !state.ready) return;

    const waiting = pendingAchievements(achData(), economyPlayers());
    if (!waiting.length) return;

    granting = true;
    const next = waiting[0];
    const awardId = achievementAwardId(next.uid, next.ach.id);

    db.ref('lan/xp/awards/' + awardId).set({
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
                    'Haut fait : ' + next.ach.label + ' (+' + next.ach.xp + ' XP)', 'success');
            }
        })
        .catch(() => { /* déjà inscrit par un autre maître du jeu, ou refusé */ })
        .finally(() => {
            granting = false;
            /* On enchaîne : une soirée entière de jalons doit se rattraper
               d'un coup quand le maître du jeu arrive. */
            grantPendingAchievements();
        });
}


/* ==========================================================================
   La fiche Signature d'un joueur
   Le téléphone garde le même langage que le bureau, mais sous forme d'une
   carte verticale pensée pour une feuille glissante et un pouce.
   ========================================================================== */

function mobileProfileSerial(uid) {
    let hash = 0;
    String(uid || '').split('').forEach(char => {
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    });
    return String((hash % 900) + 100);
}

function applyMobileProfileTheme(root, title) {
    const theme = title || {
        rarity: 'none', material: 'graphite', motif: 'grid', motion: 'calm',
        accent: '#d4af37', accent2: '#f1dd8a'
    };
    const card = root.matches('.m-prof-card') ? root : root.querySelector('.m-prof-card');
    [root, card].filter(Boolean).forEach(node => {
        node.dataset.titleRarity = theme.rarity;
        node.dataset.titleMotif = theme.motif;
        node.dataset.titleMaterial = theme.material;
        node.dataset.titleMotion = theme.motion || 'calm';
    });
    root.style.setProperty('--m-prof-accent', theme.accent);
    root.style.setProperty('--m-prof-accent-2', theme.accent2);
    root.style.setProperty('--m-prof-accent-rgb', hexRgb(theme.accent).join(', '));
    const family = root.querySelector('.m-prof-card__family');
    if (family) {
        family.textContent = title
            ? theme.material.toUpperCase() + ' · ' + theme.rarity.toUpperCase()
            : 'LAN DEMAIN · SANS TITRE';
    }
}

function hexRgb(hex) {
    const value = String(hex || '').replace('#', '');
    const full = value.length === 3
        ? value.split('').map(char => char + char).join('')
        : value;
    const parsed = parseInt(full, 16);
    if (!Number.isFinite(parsed)) return [212, 175, 55];
    return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

function openProfile(uid) {
    if (!uid) return;
    const data = achData();
    const profile = playerProfile(data, uid);
    const isMe = uid === (state.user && state.user.uid);

    openSheet(null, (body) => {
        body.classList.add('m-sheet__body--profile');
        const root = el('div', 'm-prof');

        /* La carte : portrait, titre équipé et famille visuelle. */
        const card = el('section', 'm-prof-card');
        card.appendChild(el('span', 'm-prof-card__foil'));
        card.appendChild(el('span', 'm-prof-card__motif'));
        card.appendChild(el('span', 'm-prof-card__label', 'SIGNATURE JOUEUR'));

        const head = el('div', 'm-prof__head');
        const face = el('img', 'm-prof__face');
        face.src = playerPhoto(uid);
        face.alt = '';
        head.appendChild(face);

        const ident = el('div', 'm-prof__ident');
        ident.appendChild(el('h2', 'm-prof__name', playerName(uid)));

        /* Changer son nom affiché, sur sa propre fiche seulement. Beaucoup de
           comptes Google ici ont dix ans et un pseudo qu'on ne reconnaît plus.
           Le nom vit dans `lan/users/<uid>/name`, que les règles n'ouvrent
           qu'à son propriétaire, et il fait autorité (voir playerName). */
        if (state.user && uid === state.user.uid) {
            const rename = el('button', 'm-prof__rename', '✎ Changer mon nom');
            rename.addEventListener('click', () => {
                const proposed = window.prompt(
                    'Ton nom, tel que le groupe le verra partout :', playerName(uid));
                if (proposed === null) return;
                const clean = proposed.trim().replace(/\s+/g, ' ').slice(0, 40);
                if (!clean) { showToast('Il faut bien un nom.', 'error'); return; }
                db.ref('lan/users/' + uid + '/name').set(clean)
                    .then(() => { showToast('Nom mis à jour.', 'success'); openProfile(uid); })
                    .catch(e => showToast('Erreur : ' + e.message, 'error'));
            });
            ident.appendChild(rename);
        }

        const nickname = el('p', 'm-prof__nick', profile.nickname ? '« ' + profile.nickname + ' »' : '');
        nickname.hidden = !profile.nickname;
        ident.appendChild(nickname);
        ident.appendChild(el('p', 'm-prof__lvl',
            'Niveau ' + profile.level.level + ' · ' + levelTitle(profile.level.level) + ' · ' + profile.level.total + ' XP'));
        head.appendChild(ident);
        card.appendChild(head);

        const serial = el('div', 'm-prof-card__serial');
        serial.appendChild(el('span', 'm-prof-card__family'));
        serial.appendChild(el('span', null, '№ ' + mobileProfileSerial(uid)));
        card.appendChild(serial);
        root.appendChild(card);
        applyMobileProfileTheme(root, profile.equippedTitle);

        /* La barre : la même que dans la boutique, en plus discret. */
        const progress = el('section', 'm-prof__progress');
        const progressHead = el('div', 'm-prof__progress-head');
        progressHead.appendChild(el('span', null, 'PROGRESSION PERMANENTE'));
        progressHead.appendChild(el('strong', null,
            profile.level.total + ' XP · encore ' + profile.level.toNext
                + ' avant le niveau ' + (profile.level.level + 1)));
        progress.appendChild(progressHead);
        const segs = el('div', 'm-xp__segs');
        const lit = profile.level.into > 0
            ? Math.max(1, Math.round(profile.level.ratio * XP_SEGMENTS)) : 0;
        for (let i = 0; i < XP_SEGMENTS; i += 1) {
            const seg = el('span', 'm-xp__seg');
            if (i < lit) seg.classList.add(i === lit - 1 ? 'is-edge' : 'is-on');
            segs.appendChild(seg);
        }
        progress.appendChild(segs);
        root.appendChild(progress);

        /* Les quatre repères fixes reprennent la composition du dossier bureau. */
        const stats = [
            ['Fortune', formatPoints(profile.balance)],
            ['Hauts faits', profile.achievementCount],
            ['Cartes', profile.counters.cards],
            ['LAN', profile.counters.lans]
        ];
        const grid = el('div', 'm-prof__stats');
        stats.forEach(([label, value]) => {
            const cell = el('div', 'm-prof__stat');
            cell.appendChild(el('span', 'm-prof__statv', String(value)));
            cell.appendChild(el('span', 'm-prof__statl', label));
            grid.appendChild(cell);
        });
        root.appendChild(grid);

        /* La vitrine est personnelle et suit le joueur de LAN en LAN. */
        const showcase = el('section', 'm-prof__section');
        showcase.appendChild(el('p', 'm-shop__cat', 'Vitrine'));
        const featured = el('div', 'm-prof__featured');
        if (!profile.featuredAchievements.length) {
            featured.appendChild(emptyState('La vitrine attend son premier trophée.'));
        } else {
            profile.featuredAchievements.forEach(row => {
                const trophy = el('article', 'm-prof__trophy');
                trophy.appendChild(achIcon(row.ach.icon));
                const copy = el('span', 'm-prof__trophy-copy');
                copy.appendChild(el('strong', null, row.ach.label));
                copy.appendChild(el('small', null, row.ach.hint));
                trophy.appendChild(copy);
                featured.appendChild(trophy);
            });
        }
        showcase.appendChild(featured);
        root.appendChild(showcase);

        /* Sur son propre profil, le téléphone est un atelier complet : titre et
           trois trophées, avec le même contrôle Firebase que le bureau. */
        if (isMe) {
            const customizeButton = el('button', 'm-prof__customize');
            customizeButton.appendChild(iconSvg('M14.5 4.5l5 5L10 19H5v-5zM13 6l5 5M5 19c-1.7 0-3 1.3-3 3 2 0 3-.8 3-3z'));
            const customizeLabel = el('span', null, 'Personnaliser ma Signature');
            customizeButton.appendChild(customizeLabel);
            const customizer = el('section', 'm-prof-customizer');
            customizer.hidden = true;
            let draftTitleId = profile.equippedTitle ? profile.equippedTitle.id : '';
            let draftFeatured = [1, 2, 3]
                .map(index => (state.profiles[uid] || {})['featuredAchievement' + index])
                .filter(Boolean);

            const renderCustomizer = () => {
                customizer.innerHTML = '';
                customizer.appendChild(el('p', 'm-shop__cat', 'Titre équipé'));
                const titleOptions = el('div', 'm-prof-title-options');
                const choices = [{ id: '', label: 'Nom seul', material: 'graphite', rarity: 'sans titre' }]
                    .concat(profile.unlockedTitles);
                choices.forEach(title => {
                    const button = el('button', 'm-prof-title-choice');
                    if (draftTitleId === title.id) button.classList.add('is-selected');
                    button.style.setProperty('--m-choice-accent', title.accent || '#777');
                    button.appendChild(el('i', 'm-prof-title-choice__swatch'));
                    const copy = el('span', 'm-prof-title-choice__copy');
                    copy.appendChild(el('strong', null, title.id ? '« ' + title.label + ' »' : title.label));
                    copy.appendChild(el('small', null, title.material + ' · ' + title.rarity));
                    button.appendChild(copy);
                    button.addEventListener('click', () => {
                        draftTitleId = title.id;
                        applyMobileProfileTheme(root, title.id ? title : null);
                        nickname.textContent = title.id ? '« ' + title.label + ' »' : '';
                        nickname.hidden = !title.id;
                        renderCustomizer();
                    });
                    titleOptions.appendChild(button);
                });
                customizer.appendChild(titleOptions);

                customizer.appendChild(el('p', 'm-shop__cat', 'Trois trophées en vitrine'));
                const featureOptions = el('div', 'm-prof-feature-options');
                profile.achievements.forEach(row => {
                    const button = el('button', 'm-prof-feature-choice');
                    if (draftFeatured.includes(row.ach.id)) button.classList.add('is-selected');
                    button.appendChild(achIcon(row.ach.icon));
                    const copy = el('span', 'm-prof-title-choice__copy');
                    copy.appendChild(el('strong', null, row.ach.label));
                    copy.appendChild(el('small', null, row.ach.hint));
                    button.appendChild(copy);
                    button.addEventListener('click', () => {
                        const index = draftFeatured.indexOf(row.ach.id);
                        if (index >= 0) draftFeatured.splice(index, 1);
                        else if (draftFeatured.length < 3) draftFeatured.push(row.ach.id);
                        else showToast('Ta vitrine contient déjà trois trophées.', 'info');
                        renderCustomizer();
                    });
                    featureOptions.appendChild(button);
                });
                customizer.appendChild(featureOptions);

                const actions = el('div', 'm-prof-customizer__actions');
                const cancel = el('button', 'm-btn m-btn--quiet', 'Annuler');
                cancel.addEventListener('click', () => openProfile(uid));
                const save = el('button', 'm-btn m-btn--solid', 'Enregistrer');
                save.addEventListener('click', async () => {
                    const update = { equippedTitleId: draftTitleId || null };
                    [1, 2, 3].forEach(index => {
                        update['featuredAchievement' + index] = draftFeatured[index - 1] || null;
                    });
                    try {
                        await db.ref('lan/users/' + uid).update(update);
                        state.profiles[uid] = Object.assign({}, state.profiles[uid] || {}, update);
                        showToast('Ta Signature est enregistrée.', 'success');
                        openProfile(uid);
                    } catch (error) {
                        showToast('Impossible d’enregistrer : ' + error.message, 'error');
                    }
                });
                actions.append(cancel, save);
                customizer.appendChild(actions);
            };

            customizeButton.addEventListener('click', () => {
                customizer.hidden = !customizer.hidden;
                customizeLabel.textContent = customizer.hidden ? 'Personnaliser ma Signature' : 'Fermer l’atelier';
                if (!customizer.hidden) {
                    renderCustomizer();
                    setTimeout(() => customizer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
                }
            });
            root.append(customizeButton, customizer);
        }

        /* Les titres de soirée déjà décernés : ce sont des récompenses
           inscrites, pas un calcul du moment. */
        if (profile.titles.length) {
            root.appendChild(el('p', 'm-shop__cat', 'Titres décrochés'));
            profile.titles.slice(0, 6).forEach(award => {
                const row = el('div', 'm-title');
                row.appendChild(el('span', 'm-title__label', award.reason || 'Titre'));
                row.appendChild(el('span', 'm-title__who', '+' + award.delta + ' XP'));
                root.appendChild(row);
            });
        }

        root.appendChild(el('p', 'm-shop__cat',
            'Hauts faits · ' + profile.achievementCount + ' / ' + profile.achievementTotal));

        if (!profile.achievements.length) {
            root.appendChild(emptyState(isMe
                ? 'Rien encore. Achète, ouvre, échange.'
                : 'Aucun haut fait pour le moment.'));
        } else {
            const wrap = el('div', 'm-prof__badges');
            profile.achievements.forEach(row => {
                const badge = el('span', 'm-prof__badge');
                badge.title = row.ach.label;
                badge.appendChild(iconSvg(ACH_ICONS[row.ach.icon] || ACH_ICONS.trophy));
                badge.appendChild(el('span', null, row.ach.label));
                wrap.appendChild(badge);
            });
            root.appendChild(wrap);
        }

        /* Ce qui est presque là : c'est ça qui donne envie de rouvrir la fiche. */
        if (profile.nextUp) {
            const next = el('p', 'm-card__meta',
                'Bientôt : ' + profile.nextUp.ach.label
                + ' (' + profile.nextUp.current + ' / ' + profile.nextUp.goal + ')');
            root.appendChild(next);
        }
        body.appendChild(root);
    });
}


/* ==========================================================================
   Les défis et la boîte à idées
   Rien ici ne se calcule : un défi se raconte, et c'est un humain qui tranche.
   Le joueur réclame, l'admin valide, et c'est la validation qui écrit les
   złotych au registre et l'expérience au journal — jamais le joueur lui-même.
   ========================================================================== */

function renderDefis() {
    const uid = state.user && state.user.uid;
    if (!uid) return;

    const earned = challengeEarnings(state.quests, uid);
    $('m-defis-count').textContent = String(earned.count);
    $('m-defis-hint').textContent = earned.count
        ? 'Ils t\'ont rapporté ' + formatPoints(earned.zl) + ' et ' + earned.xp + ' XP'
        : 'Aucun défi relevé pour l\'instant.';

    renderClaimsQueue();
    renderProposals();
    renderMyClaims();
    renderChallengeList();
    renderSuggestions();
}

/* ---------- Ce que l'admin doit trancher ---------- */

function renderClaimsQueue() {
    const section = $('m-claims-section');
    const mount = $('m-claims-queue');
    const queue = pendingClaims(state.quests);

    if (!state.isGamemaster || !queue.length) { section.style.display = 'none'; return; }
    section.style.display = 'flex';
    mount.innerHTML = '';

    queue.forEach(claim => {
        const card = el('article', 'm-card');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title', claim.title || 'Défi'));
        top.appendChild(el('span', 'm-chip', timeAgo(claim.ts)));
        card.appendChild(top);
        card.appendChild(el('p', 'm-card__meta',
            'par ' + (claim.userName || playerName(claim.uid))
            + (claim.witnessName ? ' · témoin : ' + claim.witnessName : '')));
        if (claim.note) card.appendChild(el('p', 'm-card__body', '« ' + claim.note + ' »'));
        card.appendChild(el('p', 'm-card__meta',
            'Vaut ' + formatPoints(claim.zl) + ' et ' + (Number(claim.xp) || 0) + ' XP'));

        const ok = el('button', 'm-btn m-btn--solid m-btn--sm m-btn--full', 'Valider');
        ok.addEventListener('click', () => resolveClaim(claim, 'granted'));
        card.appendChild(ok);
        const no = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Refuser');
        no.addEventListener('click', () => resolveClaim(claim, 'refused'));
        card.appendChild(no);

        mount.appendChild(card);
    });
}

/* Valider paie. Le débit d'un achat, le joueur sait l'écrire ; un CRÉDIT, non —
   les règles le réservent aux maîtres du jeu, et c'est tout l'intérêt. Les
   złotych, l'expérience et le sort de la réclamation partent ensemble dans une
   écriture multi-chemins : on ne peut pas être payé deux fois, ni payé sans que
   la réclamation soit close.

   La clé de la récompense d'expérience est déterministe : deux admins qui
   valident en même temps écrivent le même nœud plutôt que deux récompenses. */
function resolveClaim(claim, status) {
    const user = state.user;
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
                    ? '« ' + (claim.title || 'Défi') + ' » validé ! +' + formatPoints(claim.zl) + ' et ' + (Number(claim.xp) || 0) + ' XP'
                    : '« ' + (claim.title || 'Défi') + ' » refusé.',
                    status === 'granted' ? 'success' : 'info');
            }
            showToast(status === 'granted' ? 'Validé et payé.' : 'Refusé.', 'success');
        })
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

/* ---------- Les propositions des joueurs ---------- */

function renderProposals() {
    const section = $('m-proposals-section');
    const mount = $('m-proposals');
    const list = proposedChallenges(state.quests);

    if (!state.isGamemaster || !list.length) { section.style.display = 'none'; return; }
    section.style.display = 'flex';
    mount.innerHTML = '';

    list.forEach(challenge => {
        const card = el('article', 'm-card');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title', challenge.title || 'Défi'));
        top.appendChild(el('span', 'm-chip', challengeCategory(challenge.category).label));
        card.appendChild(top);
        if (challenge.description) card.appendChild(el('p', 'm-card__body', challenge.description));
        card.appendChild(el('p', 'm-card__meta',
            'proposé par ' + (challenge.createdByName || playerName(challenge.createdBy))
            + ' · ' + formatPoints(challenge.zl) + ' et ' + (Number(challenge.xp) || 0) + ' XP'));

        const ok = el('button', 'm-btn m-btn--solid m-btn--sm m-btn--full', 'Ouvrir aux joueurs');
        ok.addEventListener('click', () => approveChallenge(challenge));
        card.appendChild(ok);
        const no = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Refuser');
        no.addEventListener('click', () => {
            db.ref('lan/challenges/' + challenge.id).remove()
                .then(() => showToast('Proposition refusée.', 'success'))
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        card.appendChild(no);

        mount.appendChild(card);
    });
}

function approveChallenge(challenge) {
    const user = state.user;
    if (!user) return;
    db.ref('lan/challenges/' + challenge.id).update({
        status: 'open',
        approvedBy: user.uid,
        approvedAt: firebase.database.ServerValue.TIMESTAMP
    })
        .then(() => {
            if (challenge.createdBy && challenge.createdBy !== user.uid) {
                sendNotification(challenge.createdBy,
                    'Ton défi « ' + (challenge.title || '') + ' » est ouvert à tous !', 'success');
            }
            showToast('Défi ouvert.', 'success');
        })
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

/* ---------- Mes réclamations en attente ---------- */

function renderMyClaims() {
    const uid = state.user && state.user.uid;
    const section = $('m-myclaims-section');
    const mount = $('m-myclaims');
    const mine = claimsOf(state.quests, uid).filter(c => c.status === 'pending');

    if (!mine.length) { section.style.display = 'none'; return; }
    section.style.display = 'flex';
    mount.innerHTML = '';

    mine.forEach(claim => {
        const card = el('article', 'm-card');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title', claim.title || 'Défi'));
        top.appendChild(el('span', 'm-chip', 'en attente'));
        card.appendChild(top);
        if (claim.note) card.appendChild(el('p', 'm-card__body', '« ' + claim.note + ' »'));

        const cancel = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Retirer');
        cancel.addEventListener('click', () => {
            db.ref('lan/claims/' + claim.id).remove()
                .then(() => showToast('Réclamation retirée.', 'success'))
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        card.appendChild(cancel);
        mount.appendChild(card);
    });
}

/* ---------- La liste des défis ---------- */

function renderChallengeList() {
    const uid = state.user && state.user.uid;
    const mount = $('m-challenge-list');
    mount.innerHTML = '';

    const list = openChallenges(state.quests);
    if (!list.length) {
        if (!state.isGamemaster) {
            mount.appendChild(emptyState('Aucun défi pour le moment. Propose le premier !'));
            return;
        }
        const card = el('article', 'm-card');
        card.appendChild(el('p', 'm-card__body',
            'Aucun défi. Une liste de départ existe : sport, jeu, boisson, bouffe.'));
        const go = el('button', 'm-btn m-btn--solid m-btn--full', 'Garnir la liste');
        go.addEventListener('click', stockStarterChallenges);
        card.appendChild(go);
        mount.appendChild(card);
        return;
    }

    CHALLENGES.CATEGORIES.forEach(cat => {
        const items = list.filter(c => (c.category || 'autre') === cat.key);
        if (!items.length) return;
        mount.appendChild(el('p', 'm-shop__cat', cat.icon + ' ' + cat.label));
        items.forEach(challenge => mount.appendChild(buildChallengeCard(challenge, uid)));
    });

    const missing = state.isGamemaster ? missingStarterChallenges(state.quests).length : 0;
    if (missing) {
        const more = el('button', 'm-btn m-btn--quiet m-btn--sm m-btn--full',
            'Ajouter les ' + missing + ' défis de la liste de départ');
        more.addEventListener('click', stockStarterChallenges);
        mount.appendChild(more);
    }
}

function buildChallengeCard(challenge, uid) {
    const card = el('article', 'm-sitem m-sitem--' + (challenge.category === 'sport' ? 'privilege' : 'fun'));
    const state_ = claimState(state.quests, challenge, uid);
    if (!state_.can) card.classList.add('is-locked');

    card.appendChild(el('span', 'm-sitem__cost', String(Math.round(Number(challenge.zl) || 0))));

    const main = el('div', 'm-sitem__main');
    main.appendChild(el('h3', 'm-sitem__name', challenge.title || 'Défi'));
    if (challenge.description) main.appendChild(el('p', 'm-sitem__desc', challenge.description));

    const strip = el('div', 'm-sitem__strip');
    strip.appendChild(el('span', 'm-sitem__gem'));
    strip.appendChild(el('span', 'm-sitem__fam', '+' + (Number(challenge.xp) || 0) + ' XP'));
    const done = challengeGrantedCount(state.quests, challenge.id);
    if (done) strip.appendChild(el('span', 'm-sitem__stock', 'relevé ' + done + '×'));
    main.appendChild(strip);

    const go = el('button', 'm-sitem__buy');
    if (state_.can) {
        go.appendChild(iconSvg('M20 6 9 17l-5-5'));
        go.appendChild(document.createTextNode('Je l\'ai fait'));
    } else {
        go.textContent = state_.why;
    }
    go.disabled = !state_.can;
    go.addEventListener('click', () => openClaimSheet(challenge));
    main.appendChild(go);

    if (state.isGamemaster) {
        const del = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Retirer');
        del.addEventListener('click', () => {
            db.ref('lan/challenges/' + challenge.id).remove()
                .then(() => showToast('Défi retiré.', 'success'))
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        main.appendChild(del);
    }

    card.appendChild(main);
    return card;
}

/* Réclamer, c'est raconter. Le mot du joueur et le nom d'un témoin sont ce qui
   permet à l'admin de trancher sans avoir tout vu. */
function openClaimSheet(challenge) {
    const user = state.user;
    if (!user) return;

    openSheet(challenge.title || 'Défi', (body) => {
        body.appendChild(el('p', 'm-card__meta',
            'Vaut ' + formatPoints(challenge.zl) + ' et ' + (Number(challenge.xp) || 0) + ' XP.'));

        const note = el('textarea', 'm-input');
        note.placeholder = 'Comment ça s\'est passé ? (facultatif)';
        body.appendChild(note);

        body.appendChild(el('p', 'm-label', 'Un témoin ?'));
        const witness = el('select', 'm-input');
        const none = el('option', null, 'Personne');
        none.value = '';
        witness.appendChild(none);
        economyPlayers().filter(u => u !== user.uid).forEach(other => {
            const opt = el('option', null, playerName(other));
            opt.value = other;
            witness.appendChild(opt);
        });
        body.appendChild(witness);

        const go = el('button', 'm-btn m-btn--solid m-btn--full', 'Envoyer à l\'admin');
        go.addEventListener('click', () => {
            /* Le montant est FIGÉ dans la réclamation : si l'admin change le
               prix du défi demain, ce qui a été promis reste promis. */
            db.ref('lan/claims').push().set({
                challengeId: challenge.id,
                title: challenge.title || 'Défi',
                zl: Number(challenge.zl) || 0,
                xp: Number(challenge.xp) || 0,
                uid: user.uid,
                userName: user.displayName || 'Un joueur',
                note: note.value.trim().slice(0, 500),
                witnessUid: witness.value || null,
                witnessName: witness.value ? playerName(witness.value) : null,
                status: 'pending',
                ts: firebase.database.ServerValue.TIMESTAMP
            })
                .then(() => {
                    closeSheet();
                    showToast('Envoyé ! L\'admin tranchera.', 'success');
                })
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        body.appendChild(go);
    });
}

/* Garnir la liste d'un coup. On n'ajoute que ce qui manque, comparé sur le
   titre : regarnir deux fois ne double pas les défis. */
function stockStarterChallenges() {
    const user = state.user;
    if (!user) return;
    const missing = missingStarterChallenges(state.quests);
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
        .then(() => showToast(missing.length + ' défis ajoutés.', 'success'))
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
}

/* Proposer un défi. Un admin l'ouvre directement ; un joueur le propose, et il
   attend l'approbation — les règles plafonnent d'ailleurs sa récompense. */
$('m-challenge-new').addEventListener('click', () => {
    const user = state.user;
    if (!user) return;
    const isGm = state.isGamemaster;

    openSheet(isGm ? 'Créer un défi' : 'Proposer un défi', (body) => {
        const title = el('input', 'm-input');
        title.placeholder = 'Ex : 30 pompes d\'affilée';
        body.appendChild(title);

        const desc = el('textarea', 'm-input');
        desc.placeholder = 'Les règles exactes. Ce qui compte, ce qui ne compte pas.';
        body.appendChild(desc);

        const category = el('select', 'm-input');
        CHALLENGES.CATEGORIES.forEach(cat => {
            const opt = el('option', null, cat.icon + ' ' + cat.label);
            opt.value = cat.key;
            category.appendChild(opt);
        });
        body.appendChild(category);

        const row = el('div', 'm-field');
        const zl = el('input', 'm-input');
        zl.type = 'number';
        zl.min = '0';
        zl.placeholder = 'złotych';
        const xp = el('input', 'm-input');
        xp.type = 'number';
        xp.min = '0';
        xp.placeholder = 'XP';
        row.appendChild(zl);
        row.appendChild(xp);
        body.appendChild(row);

        if (!isGm) {
            body.appendChild(el('p', 'm-card__meta',
                'Au maximum ' + CHALLENGES.MAX_PROPOSED_ZL + ' ' + ECONOMY.CURRENCY
                + ' et ' + CHALLENGES.MAX_PROPOSED_XP + ' XP. L\'admin décidera.'));
        }

        const go = el('button', 'm-btn m-btn--solid m-btn--full',
            isGm ? 'Ouvrir le défi' : 'Proposer à l\'admin');
        go.addEventListener('click', () => {
            const value = title.value.trim();
            if (!value) { showToast('Il manque le titre.', 'error'); return; }

            let zlValue = Math.max(0, Math.round(Number(zl.value) || 0));
            let xpValue = Math.max(0, Math.round(Number(xp.value) || 0));
            if (!isGm) {
                zlValue = Math.min(zlValue, CHALLENGES.MAX_PROPOSED_ZL);
                xpValue = Math.min(xpValue, CHALLENGES.MAX_PROPOSED_XP);
            }

            db.ref('lan/challenges').push().set({
                title: value.slice(0, 120),
                description: desc.value.trim(),
                category: category.value,
                zl: zlValue,
                xp: xpValue,
                repeatable: true,
                status: isGm ? 'open' : 'proposed',
                createdBy: user.uid,
                createdByName: user.displayName || 'Un joueur',
                createdAt: firebase.database.ServerValue.TIMESTAMP
            })
                .then(() => {
                    closeSheet();
                    showToast(isGm ? 'Défi ouvert !' : 'Proposé ! L\'admin décidera.', 'success');
                })
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        body.appendChild(go);
    });
});

/* ---------- La boîte à idées ---------- */

function renderSuggestions() {
    const uid = state.user && state.user.uid;
    const mount = $('m-suggestions');
    mount.innerHTML = '';

    /* Tout le monde voit tout : c'est la même règle que le registre. Une idée
       lue par les autres a une chance d'être appuyée. */
    const list = allSuggestions(state.quests).slice(0, 20);
    if (!list.length) {
        mount.appendChild(emptyState('Rien pour l\'instant.'));
        return;
    }

    list.forEach(item => {
        const card = el('article', 'm-card');
        const top = el('div', 'm-card__top');
        top.appendChild(el('h3', 'm-card__title', item.userName || playerName(item.uid)));
        top.appendChild(el('span', 'm-chip', timeAgo(item.ts)));
        card.appendChild(top);
        card.appendChild(el('p', 'm-card__body', item.text));

        if (item.reply) {
            const reply = el('p', 'm-card__meta',
                '↳ ' + (item.repliedByName || 'Admin') + ' : ' + item.reply);
            card.appendChild(reply);
        }

        if (state.isGamemaster && !item.reply) {
            const answer = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Répondre');
            answer.addEventListener('click', () => openReplySheet(item));
            card.appendChild(answer);
        }
        if (item.uid === uid || state.isGamemaster) {
            const del = el('button', 'm-btn m-btn--quiet m-btn--sm', 'Supprimer');
            del.addEventListener('click', () => {
                db.ref('lan/suggestions/' + item.id).remove()
                    .then(() => showToast('Supprimé.', 'success'))
                    .catch(e => showToast('Erreur : ' + e.message, 'error'));
            });
            card.appendChild(del);
        }

        mount.appendChild(card);
    });
}

function openReplySheet(item) {
    const user = state.user;
    if (!user) return;
    openSheet('Répondre à ' + (item.userName || 'un joueur'), (body) => {
        body.appendChild(el('p', 'm-card__body', '« ' + item.text + ' »'));
        const text = el('textarea', 'm-input');
        text.placeholder = 'Ta réponse';
        body.appendChild(text);
        const go = el('button', 'm-btn m-btn--solid m-btn--full', 'Répondre');
        go.addEventListener('click', () => {
            const value = text.value.trim();
            if (!value) { showToast('Réponse vide.', 'error'); return; }
            db.ref('lan/suggestions/' + item.id).update({
                reply: value.slice(0, 1000),
                repliedBy: user.uid,
                repliedByName: user.displayName || 'Admin',
                repliedAt: firebase.database.ServerValue.TIMESTAMP,
                status: 'done'
            })
                .then(() => {
                    closeSheet();
                    if (item.uid !== user.uid) {
                        sendNotification(item.uid, 'Réponse à ton idée : ' + value.slice(0, 80), 'info');
                    }
                    showToast('Répondu.', 'success');
                })
                .catch(e => showToast('Erreur : ' + e.message, 'error'));
        });
        body.appendChild(go);
    });
}

$('m-suggest-send').addEventListener('click', () => {
    const user = state.user;
    const field = $('m-suggest-text');
    if (!user) return;
    const value = field.value.trim();
    if (!value) { showToast('Écris quelque chose d\'abord.', 'error'); return; }

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
        .catch(e => showToast('Erreur : ' + e.message, 'error'));
});

/* ==========================================================================
   Câblage final
   ========================================================================== */

document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-goto]');
    if (nav) {
        e.preventDefault();
        const target = nav.dataset.goto;
        if (!screenAvailable(target)) {
            const reason = lockReason(target);
            if (reason) showToast(reason, 'error');
            return;
        }
        goto(target);
        return;
    }
    if (e.target.closest('[data-sheet-close]')) closeSheet();
});

// La feuille est un élément unique du document : on branche le geste une fois.
attachSheetDrag();

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet(); return; }

    /* Ouvrir un booster au clavier : espace et entrée avancent d'un cran,
       exactement comme le bouton. C'est ce qui permet d'en enchaîner dix sans
       jamais lâcher la main. On ne s'en mêle que si la scène est ouverte, et
       jamais pendant une saisie — sinon on ne pourrait plus taper d'espace. */
    if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
    if (!$('m-reveal').classList.contains('is-open')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    /* Sur un bouton, la barre d'espace déclenche déjà le clic : réagir en plus
       ferait avancer de deux cartes d'un coup. */
    if (tag === 'BUTTON') return;

    e.preventDefault();
    advanceReveal();
});

loadThumbStore();
