// normalizeGameName, escapeHtml, levenshtein, checkTypos et calculateScores
// vivent désormais dans core.js, partagé avec l'interface téléphone.

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
    let globalUsers = {};
    // Fiches durables (nom + avatar). /status disparaît à la déconnexion : sans
    // ce miroir, un joueur qui a voté puis fermé l'onglet n'avait plus de photo.
    let globalProfiles = {};
    // Notre entrée dans /status : une par session, pas une par joueur.
    let myConnectionRef = null;
    let myConnectionKey = null;
    let firebaseConnected = false;
    let appInitialized = false;
    let isEditing = false;
    const imageCache = new Map();
    const DEFAULT_GAME_ICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23666'%3E%3Cpath d='M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-2.5 14H6.5v-1.5h11V18zm0-2.5H6.5v-1.5h11V15.5zm0-2.5H6.5v-1.5h11V13zm-5-3.25L10.25 8h1.5l2.25 1.75V8h1.5v6h-1.5v-1.75L13.25 14h-1.5L9.5 12.25V14H8V8h1.5v1.75z'/%3E%3C/svg%3E`;

    const voteForm = document.getElementById('vote-form');
    const voterSelectMenu = document.getElementById('voter-select-menu');
    const correctionModal = document.getElementById('correction-modal');

    auth.onAuthStateChanged(user => {
        if (user) {
            authContainer.style.display = 'none';
            appContainer.style.display = 'block';
            userNameSpan.textContent = user.displayName || user.email;
            userAvatarImg.src = user.photoURL || '';
            if (votesRef) votesRef.off();
            if (settingsRef) settingsRef.off();
            initializeApp(user);
        } else {
            authContainer.style.display = 'block';
            appContainer.style.display = 'none';
            if (votesRef) votesRef.off();
            if (settingsRef) settingsRef.off();
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

    // Repasser en interface téléphone. Le choix est un cookie et non un
    // localStorage : c'est Vercel qui le lit pour servir la bonne page.
    document.getElementById('btn-mobile-version')?.addEventListener('click', () => {
        document.cookie = 'lan_vue=mobile; path=/; max-age=31536000; samesite=lax';
        window.location.replace('/');
    });

    logoutBtn.addEventListener('click', () => {
        const user = auth.currentUser;
        // On ne retire que cette session : le téléphone du même joueur, s'il est
        // ouvert, reste connecté.
        if (myConnectionRef) {
            myConnectionRef.remove();
            myConnectionRef = null;
        } else if (user) {
            db.ref('/status/' + user.uid).remove();
        }
        auth.signOut();
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

        // Les fiches seules ne suffisent pas à figurer dans la bande : il faut
        // être connecté ou avoir voté, sinon d'anciens invités traîneraient.
        const kept = [...roster.values()].filter(p => p.online || (globalVotes && globalVotes[p.uid]));

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
        ['role-user-select', 'role-user-select-lan'].forEach(id => {
            const sel = document.getElementById(id);
            if (sel) sel.innerHTML = '<option value="">Sélectionner un joueur...</option>';
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
            img.src = player.avatar || initialsAvatar(player.name);
            img.alt = player.name || 'Joueur';
            img.className = 'user-avatar-icon';
            // Une photo Google périmée renverrait une image cassée : on retombe
            // sur les initiales plutôt que sur l'icône de vignette absente.
            img.addEventListener('error', () => { img.src = initialsAvatar(player.name); });
            slot.appendChild(img);

            const dot = document.createElement('span');
            dot.className = 'presence-dot';
            slot.appendChild(dot);

            slot.addEventListener('click', () => {
                showPlayerVotesModal(player.uid, player.name, globalVotes);
            });

            sidebar.appendChild(slot);

            // Populate both role selects (View 3 admin panel + Active LAN admin panel)
            ['role-user-select', 'role-user-select-lan'].forEach(selectId => {
                const sel = document.getElementById(selectId);
                if (sel) {
                    const opt = document.createElement('option');
                    opt.value = player.uid;
                    opt.textContent = player.name || player.uid;
                    sel.appendChild(opt);
                }
            });
        });
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

    function showPlayerVotesModal(uid, userName, votesData) {
        const modal = document.getElementById('player-votes-modal');
        const nameEl = document.getElementById('player-votes-name');
        const listEl = document.getElementById('player-votes-content');

        if (!modal || !nameEl || !listEl) return;

        nameEl.textContent = `Voeux de ${userName}`;
        listEl.innerHTML = '';

        const userVoteData = votesData[uid];
        if (!userVoteData || !userVoteData.votes) {
            listEl.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Aucun vote enregistré.</p>';
        } else {
            const p = userVoteData.votes;
            const displayNames = buildDisplayNameMap();
            const displayGameName = (raw) => displayNames.get(normalizeGameName(raw)) || raw;

            const createSection = (title, gamesArray, color) => {
                if (!gamesArray || gamesArray.length === 0) return;
                const sec = document.createElement('div');
                sec.style.marginBottom = '15px';
                sec.innerHTML = `<h5 style="color: ${color}; margin-bottom: 5px; font-family: 'Outfit'; font-size: 0.9em;">${title}</h5>`;
                gamesArray.forEach(g => {
                    const row = document.createElement('div');
                    row.className = 'player-row';
                    // Les votes stockent la saisie brute, souvent en minuscules :
                    // on réutilise la casse d'affichage calculée pour le classement
                    const label = displayGameName(g);
                    row.innerHTML = `<span style="color: var(--primary-text);">${escapeHtml(label)}</span>`;

                    // Reprendre un jeu vu chez un autre joueur, pendant le vote
                    if (globalSettings.isVotingOpen && document.getElementById('vote-form')) {
                        const add = document.createElement('button');
                        add.type = 'button';
                        add.className = 'rank-row__add';
                        add.textContent = '+';
                        add.title = `Ajouter « ${label} » à mon vote`;
                        add.setAttribute('aria-label', `Ajouter ${label} à mon vote`);
                        add.style.marginLeft = 'auto';
                        add.addEventListener('click', () => addGameToVote(label));
                        row.appendChild(add);
                    }

                    sec.appendChild(row);
                });
                listEl.appendChild(sec);
            };

            createSection('P1 (5 pts)', p.p1, 'var(--accent-color)');
            createSection('P2 (3 pts)', p.p2, 'silver');
            createSection('P3 (2 pts)', p.p3, '#cd7f32'); // bronze
            createSection('Autres (1 pt)', p.p_other, 'var(--secondary-text)');
        }

        modal.style.display = 'flex';
    }

    function initializeApp(user) {
        // Initial check based on config, but roles from DB will overwrite
        let isAdmin = user.uid === ADMIN_UID;
        window.currentUserIsAdmin = isAdmin;
        window.currentUserIsMixologist = false;

        // Listen for user roles
        db.ref('lan/roles').on('value', snapshot => {
            const roles = snapshot.val() || {};
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

            // Update UI based on roles
            const lanAdminNav = document.getElementById('lan-nav-admin');
            if (lanAdminNav) lanAdminNav.style.display = window.currentUserIsAdmin ? 'block' : 'none';
            updateVotingUIState();
        });

        // Une clé par session ouverte : le même compte tourne souvent sur le PC
        // et sur le téléphone, et fermer l'un ne doit pas déclarer l'autre parti.
        myConnectionRef = db.ref('/status/' + user.uid).push();
        myConnectionKey = myConnectionRef.key;
        const connectedRef = db.ref('.info/connected');

        connectedRef.on('value', (snap) => {
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

        votesRef = db.ref('lan/votes');
        settingsRef = db.ref('lan/settings');
        eventsRef = db.ref('lan/events');
        cocktailsRef = db.ref('lan/cocktails');
        notificationsRef = db.ref('lan/notifications/' + user.uid);

        db.ref('/status').on('value', snapshot => {
            globalUsers = snapshot.val() || {};
            reassertPresence();
            renderActiveUsers();
        });

        db.ref('lan/users').on('value', snapshot => {
            globalProfiles = snapshot.val() || {};
            renderActiveUsers();
        });

        eventsRef.on('value', (snapshot) => {
            const eventsData = snapshot.val() || {};
            window._latestEventsData = eventsData;
            renderEvents(eventsData, user);
            renderAgenda();
            checkEventReminders(eventsData, user);
        });

        // Une minute suffit : rappels, compte à rebours et repère « maintenant »
        // du programme se rafraîchissent ensemble.
        setInterval(() => {
            if (auth.currentUser) {
                renderWhenWhere();
                renderAgenda();
            }
            if (window._latestEventsData && auth.currentUser) {
                checkEventReminders(window._latestEventsData, auth.currentUser);
            }
        }, 60000);

        cocktailsRef.on('value', (snapshot) => {
            const cocktailsData = snapshot.val() || {};
            window._latestCocktailsData = cocktailsData;
            renderCocktails(cocktailsData, user);
            renderCocktailSummary(cocktailsData);
        });

        notificationsRef.on('value', (snapshot) => {
            renderNotifications(snapshot.val() || {}, user);
        });

        // Bibliothèques Steam, indexées par compte Steam. Le catalogue Game Pass
        // n'est téléchargé que si au moins une personne est marquée abonnée.
        db.ref('lan/steamLibraries').on('value', (snapshot) => {
            groupLibraries = snapshot.val() || {};
            const needsGamepass = Object.values(groupLibraries).some(l => l.gamepass);
            if (needsGamepass && !gamepassCatalog) {
                loadGamepassCatalog().then(renderGroupLibrary);
            } else {
                renderGroupLibrary();
            }
        });

        // Sondages
        db.ref('lan/polls').on('value', (snapshot) => {
            globalPolls = snapshot.val() || {};
            announceNewPolls();
            handlePollClosures();
            renderPolls();
            refreshRecapIfVisible();
        });

        // Commandes groupées
        db.ref('lan/foodRuns').on('value', (snapshot) => {
            globalFoodRuns = snapshot.val() || {};
            renderFoodRuns();
            refreshRecapIfVisible();
        });
        buildPollOptionInputs(2);

        settingsRef.on('value', (snapshot) => {
            const newSettings = snapshot.val() || { isVotingOpen: true, topGamesCount: 10, isLanActive: false };

            if (appInitialized && globalSettings.isVotingOpen === true && newSettings.isVotingOpen === false) {
                showToast("Les votes sont terminés ! Voici les résultats...", "success");
                showFinalResults();
            }

            globalSettings = newSettings;
            updateVotingUIState();
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

        votesRef.on('value', (snapshot) => {
            globalVotes = snapshot.val() || {};
            renderDashboard(globalVotes, user);
            // Un nouveau votant doit rejoindre le trombinoscope même hors ligne.
            renderActiveUsers();

            const selectedUserId = voterSelectMenu.value || user.uid;
            if (!isEditing || selectedUserId !== user.uid) {
                loadVoteIntoForm(selectedUserId, globalVotes, user);
            }
            appInitialized = true;
        });

        updateVotingUIState();
    }

    function updateVotingUIState() {
        const viewVotingOpen = document.getElementById('view-voting-open');
        const viewWaitingClosed = document.getElementById('view-waiting-closed');
        const viewAdminDashboard = document.getElementById('view-admin-dashboard');
        const viewLanActive = document.getElementById('view-lan-active');
        const adminPanelOpen = document.getElementById('admin-panel-open');
        const form = document.getElementById('vote-form');

        const viewLanFinished = document.getElementById('view-lan-finished');

        if (viewVotingOpen) viewVotingOpen.style.display = 'none';
        if (viewWaitingClosed) viewWaitingClosed.style.display = 'none';
        if (viewAdminDashboard) viewAdminDashboard.style.display = 'none';
        if (viewLanActive) viewLanActive.style.display = 'none';
        if (viewLanFinished) viewLanFinished.style.display = 'none';
        if (adminPanelOpen) adminPanelOpen.style.display = 'none';

        const finalResultsModal = document.getElementById('final-results-modal');
        if (finalResultsModal) finalResultsModal.style.display = 'none';

        // La soirée terminée prime : c'est un état volontaire de l'admin, qui
        // ne doit pas être confondu avec l'attente d'avant-LAN.
        if (globalSettings.lanFinished && !globalSettings.isLanActive) {
            if (viewLanFinished) viewLanFinished.style.display = 'block';
            const btnNotifRecap = document.getElementById('btn-notifications');
            if (btnNotifRecap) btnNotifRecap.style.display = 'inline-flex';
            renderLanRecap();
            return;
        }

        if (globalSettings.isLanActive) {
            if (viewLanActive) viewLanActive.style.display = 'block';
            // Clear all marquee tracks when LAN goes active
            ['waiting-marquee-1', 'waiting-marquee-2', 'waiting-marquee-3', 'waiting-marquee-4'].forEach(id => {
                const t = document.getElementById(id);
                if (t) t.innerHTML = '';
            });
            // Show notification bell in LAN active phase
            const btnNotif = document.getElementById('btn-notifications');
            if (btnNotif) btnNotif.style.display = 'inline-flex';
            // Show admin/mixologist buttons
            if (window.currentUserIsAdmin || window.currentUserIsMixologist) {
                const addMasterBtn = document.getElementById('btn-add-master-kocktail');
                if (addMasterBtn) addMasterBtn.style.display = 'inline-block';
            }
            return;
        }

        // Show notification bell always (not just in LAN active)
        const btnNotif = document.getElementById('btn-notifications');
        if (btnNotif) btnNotif.style.display = 'inline-flex';

        if (globalSettings.isVotingOpen) {
            if (viewVotingOpen) viewVotingOpen.style.display = 'block';
            if (form) form.style.display = 'flex';
            if (window.currentUserIsAdmin && adminPanelOpen) {
                adminPanelOpen.style.display = 'block';
            }
        } else {
            if (form) form.style.display = 'none';

            // Show btn-open-lan-dashboard only when votes are closed and LAN not active
            const openLanBtn = document.getElementById('btn-open-lan-dashboard');

            if (window.currentUserIsAdmin) {
                if (viewAdminDashboard) viewAdminDashboard.style.display = 'block';
                if (openLanBtn && !globalSettings.isLanActive) openLanBtn.style.display = 'block';
            } else {
                if (viewWaitingClosed) viewWaitingClosed.style.display = 'flex';
                renderMarquee();
            }
        }
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
            if (e.target.classList.contains('add-game-btn')) {
                const list = e.target.previousElementSibling;
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
        const listElement = document.getElementById('suggestions-list');
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
            tableBody.innerHTML = `<tr><td colspan="2" style="text-align: center;">Aucun vote pour le moment...</td></tr>`;
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
        voterSelectMenu.innerHTML = '<option value="">-- Mon Vote --</option>';
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
            score.textContent = count ? `${count} · ${pct}%` : '-';

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
        if (adminBox) adminBox.style.display = window.currentUserIsAdmin ? 'block' : 'none';
    }

    // --- NOUVELLE LAN --------------------------------------------------------

    // Archive le classement en cours puis remet le cycle à zéro : votes effacés,
    // votes rouverts, LAN active désactivée. On ne touche ni aux événements, ni
    // aux kocktails, ni aux bibliothèques Steam : ils survivent d'une LAN à l'autre.
    async function startNewLan(newName) {
        const sortedGames = calculateScores(globalVotes);
        const previousName = globalSettings.lanName || 'LAN Demain';

        // Tout ce qui appartient à une soirée est archivé avec elle, puis effacé :
        // sans ça, la nouvelle LAN héritait des événements et des kocktails
        // de la précédente.
        const [eventsSnap, cocktailsSnap] = await Promise.all([
            db.ref('lan/events').once('value'),
            db.ref('lan/cocktails/oneshot').once('value')
        ]);

        const hadContent = sortedGames.length > 0 || eventsSnap.exists() || cocktailsSnap.exists();

        if (hadContent) {
            await db.ref('lan/history').push().set({
                name: previousName,
                date: new Date().toLocaleDateString('fr-FR'),
                timestamp: firebase.database.ServerValue.TIMESTAMP,
                topGames: sortedGames.slice(0, globalSettings.topGamesCount || 10),
                votes: globalVotes,
                events: eventsSnap.val() || null,
                oneshotCocktails: cocktailsSnap.val() || null
            });
        }

        // Seule la carte officielle des kocktails survit : c'est un acquis
        // curé par les admins. Les bibliothèques, elles, bougent entre deux
        // soirées (achats, abonnements), donc on repart d'une liste fraîche.
        await Promise.all([
            db.ref('lan/votes').remove(),
            db.ref('lan/events').remove(),
            db.ref('lan/cocktails/oneshot').remove(),
            db.ref('lan/cocktails/orders').remove(),
            db.ref('lan/polls').remove(),
            db.ref('lan/foodRuns').remove(),
            db.ref('lan/steamLibraries').remove()
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
            "Archiver la soirée en cours (classement, événements, créations kocktails, sondages, commandes) puis repartir de zéro ? Les bibliothèques Steam sont également effacées. Seule la carte officielle des kocktails est conservée.",
            { title: '🎉 Nouvelle LAN', danger: true, confirmLabel: 'Démarrer' }
        );
        if (!ok) return;

        try {
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

        renderList('closed-download-list');
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

        if (sortedGames.length === 0) {
            container.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Aucun vote enregistré.</p>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'results-table';
        table.style.width = '100%';
        table.innerHTML = `
            <thead>
                <tr>
                    <th style="text-align:left; padding: 12px; border-bottom: 2px solid rgba(255,255,255,0.1);">Jeu</th>
                    <th style="text-align:right; padding: 12px; border-bottom: 2px solid rgba(255,255,255,0.1); width: 100px;">Points</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');
        sortedGames.forEach((game, index) => {
            const row = document.createElement('tr');
            row.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
            row.innerHTML = `
                <td style="padding: 12px; color: var(--primary-text); display: flex; align-items: center; gap: 10px;">
                    <span style="color:var(--accent-color); font-weight:bold; min-width:25px;">#${index + 1}</span>
                    ${escapeHtml(game.name)}
                </td>
                <td style="padding: 12px; text-align:right; color: var(--secondary-text); font-weight: bold;">${game.score}</td>
            `;
            tbody.appendChild(row);
        });

        container.appendChild(table);
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

    async function renderMarquee() {
        // Use any of the marquee tracks defined in HTML
        const track = document.getElementById('waiting-marquee-1');
        if (!track || track.childElementCount > 0) return;

        const sortedGames = calculateScores(globalVotes);
        let gamesForMarquee = sortedGames.slice(0, 5).map(g => g.name);

        const topSteamGames = [
            "Counter-Strike 2", "Dota 2", "PUBG: BATTLEGROUNDS",
            "Apex Legends", "Helldivers 2", "Palworld", "Grand Theft Auto V",
            "Team Fortress 2", "Rust", "Baldur's Gate 3", "Cyberpunk 2077",
            "ELDEN RING", "War Thunder", "Left 4 Dead 2", "Terraria",
            "Stardew Valley", "Rainbow Six Siege", "ARK: Survival Evolved",
            "The Witcher 3", "Path of Exile", "Rocket League", "Destiny 2",
            "Garry's Mod", "Fallout 4", "Dead by Daylight", "Red Dead Redemption 2",
            "Age of Empires II", "Phasmophobia", "Hollow Knight", "Lethal Company",
            "Among Us", "Halo Infinite", "Borderlands 3"
        ];

        for (let game of topSteamGames) {
            if (!gamesForMarquee.includes(game)) {
                gamesForMarquee.push(game);
            }
        }

        gamesForMarquee = gamesForMarquee.sort(() => 0.5 - Math.random()).slice(0, 25);

        const createCard = async (gameName) => {
            const imgUrl = await getGameImage(gameName);
            if (imgUrl === DEFAULT_GAME_ICON) return null;
            const card = document.createElement('div');
            card.className = 'marquee-card';
            card.style.backgroundImage = `url(${imgUrl})`;
            return card;
        };

        const cards = [];
        for (const name of gamesForMarquee) {
            const c = await createCard(name);
            if (c) cards.push(c);
        }

        if (cards.length === 0) return;

        // Populate all 4 marquee tracks with shuffled versions
        const tracks = ['waiting-marquee-1', 'waiting-marquee-2', 'waiting-marquee-3', 'waiting-marquee-4'];
        tracks.forEach(trackId => {
            const t = document.getElementById(trackId);
            if (!t) return;
            const shuffled = [...cards].sort(() => 0.5 - Math.random());
            const allCards = [...shuffled, ...shuffled.map(c => c.cloneNode(true)), ...shuffled.map(c => c.cloneNode(true))];
            allCards.forEach(c => t.appendChild(c));
        });
    }

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
            if (targetId === 'lan-kocktails' && window._latestCocktailsData) {
                renderCocktails(window._latestCocktailsData, auth.currentUser);
            }
            if (targetId === 'lan-events' && window._latestEventsData) {
                renderEvents(window._latestEventsData, auth.currentUser);
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

    document.getElementById('btn-create-event')?.addEventListener('click', openCreateEventModal);
    document.getElementById('btn-create-event-calendar')?.addEventListener('click', openCreateEventModal);

    document.getElementById('btn-goto-calendar')?.addEventListener('click', () => {
        document.querySelector('.lan-nav-list .nav-item[data-target="lan-calendar"]')?.click();
    });

    bindScheduleForms();

    document.getElementById('cancel-event-btn')?.addEventListener('click', () => {
        const createModal = document.getElementById('create-event-modal');
        if (createModal) createModal.style.display = 'none';
    });

    document.getElementById('close-player-votes-btn')?.addEventListener('click', () => {
        const playerModal = document.getElementById('player-votes-modal');
        if (playerModal) playerModal.style.display = 'none';
    });

    // --- HISTORIQUE ---
    document.getElementById('btn-lan-history')?.addEventListener('click', () => {
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
    });

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

    /* --- Quand & où ------------------------------------------------------ */

    const WHEN_WHERE_MOUNTS = ['when-where-voting', 'when-where-waiting', 'when-where-calendar'];

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
                hint.textContent = 'Ni date ni lieu annoncés. Renseignez-les dans « Quand & où », au panneau Admin.';
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

    // --- RENDER EVENTS ---
    function renderEvents(eventsData, currentUser) {
        const eventsList = document.getElementById('events-list');
        const previewList = document.getElementById('upcoming-events-preview');
        if (!eventsList || !previewList) return;

        eventsList.innerHTML = '';
        previewList.innerHTML = '';

        // Ordre du programme, et non ordre de création : la liste se lit comme
        // la soirée se déroule, jour par jour puis heure par heure.
        const now = new Date();
        const agenda = buildAgenda(eventsData, globalSettings.lanDate || '');
        const eventsArray = flattenAgenda(agenda);

        if (eventsArray.length === 0) {
            eventsList.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Aucun événement actuellement.</p>';
            previewList.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Rien de prévu pour le moment.</p>';
            return;
        }

        let previewCount = 0;

        eventsArray.forEach(evt => {
            // Create the card
            const card = document.createElement('div');
            card.className = `event-card ${evt.isGlobal ? 'global' : ''}`;

            const titleContainer = document.createElement('div');
            titleContainer.className = 'event-header';
            const title = document.createElement('h3');
            title.innerHTML = `${evt.isGlobal ? '🌍 ' : ''}${escapeHtml(evt.title)} <span style="font-size: 0.6em; color: var(--secondary-text); font-family: 'Outfit'; font-weight: normal; margin-left: 10px;">par ${escapeHtml(evt.creatorName || 'Inconnu')}</span>`;
            titleContainer.appendChild(title);
            card.appendChild(titleContainer);

            const meta = document.createElement('div');
            meta.className = 'event-meta';
            if (evt.game) meta.innerHTML += `<span>🎮 ${escapeHtml(evt.game)}</span>`;
            // Le jour n'apparaît que s'il n'est pas celui de la LAN : sur une
            // soirée d'un seul soir, le répéter sur chaque carte est du bruit.
            if (evt.dayKey && evt.dayKey !== (globalSettings.lanDate || '')) {
                meta.innerHTML += `<span>📅 ${escapeHtml(formatDayLabel(evt.dayKey, now))}</span>`;
            }
            if (evt.time) meta.innerHTML += `<span>🕒 ${escapeHtml(evt.time)}</span>`;

            const rsvpCount = evt.rsvps ? Object.values(evt.rsvps).filter(v => v === 'accepted').length : 0;
            if (evt.slots > 0) {
                meta.innerHTML += `<span>👥 ${rsvpCount} / ${escapeHtml(String(evt.slots))}</span>`;
            } else {
                meta.innerHTML += `<span>👥 ${rsvpCount} participant(s)</span>`;
            }
            if (evt.isAlcohol) {
                meta.innerHTML += `<span style="color: #ff9800; font-weight: bold;">🥃 Jeu à boire</span>`;
            }
            card.appendChild(meta);

            if (evt.description || (evt.isAlcohol && evt.alcoholRules)) {
                const descBox = document.createElement('div');
                descBox.className = 'desc-box';
                if (evt.description) descBox.innerHTML += `<div>${escapeHtml(evt.description)}</div>`;
                if (evt.isAlcohol && evt.alcoholRules) {
                    descBox.innerHTML += `<div style="margin-top: 5px; color: #ff9800; font-size: 0.85em;"><strong>Règles:</strong> ${escapeHtml(evt.alcoholRules)}</div>`;
                }
                card.appendChild(descBox);
            }

            // Action buttons (RSVP)
            const actions = document.createElement('div');
            actions.className = 'row-actions';

            const hasAccepted = evt.rsvps && evt.rsvps[currentUser.uid] === 'accepted';
            const isCreator = evt.creatorId === currentUser.uid;

            if (hasAccepted) {
                const acceptedBadge = document.createElement('span');

                if (isCreator) {
                    // Static non-interactive badge for creator
                    acceptedBadge.className = 'badge badge--accent';
                    acceptedBadge.textContent = '✓ Organisateur';
                    acceptedBadge.title = "Vous êtes le créateur.";
                } else {
                    // Muted green badge : clickable to un-register
                    acceptedBadge.className = 'badge badge--success badge--clickable';
                    acceptedBadge.textContent = '✓ Inscrit';
                    acceptedBadge.title = "Cliquer pour annuler votre participation";
                    acceptedBadge.addEventListener('click', () => {
                        db.ref(`lan/events/${evt.id}/rsvps/${currentUser.uid}`).remove();
                    });
                }
                actions.appendChild(acceptedBadge);
            } else {
                const rsvpBtn = document.createElement('button');
                rsvpBtn.className = 'gold-link-btn';
                rsvpBtn.textContent = 'Participer';
                rsvpBtn.addEventListener('click', () => {
                    db.ref(`lan/events/${evt.id}/rsvps/${currentUser.uid}`).set('accepted');
                    // On demande l'autorisation ici : c'est le moment où le rappel
                    // devient utile, et un clic est nécessaire pour que le
                    // navigateur accepte d'afficher la demande.
                    requestReminderPermission();
                });
                actions.appendChild(rsvpBtn);
            }

            // Admin or Creator can delete
            if (window.currentUserIsAdmin || isCreator) {
                const delBtn = document.createElement('button');
                delBtn.className = 'danger-link-btn';
                delBtn.textContent = 'Supprimer';
                delBtn.addEventListener('click', () => {
                    askConfirm(`Supprimer l'événement « ${evt.title} » ?`, { danger: true }).then(ok => {
                        if (ok) db.ref(`lan/events/${evt.id}`).remove();
                    });
                });
                actions.appendChild(delBtn);
            }

            // Distribute shot if alcohol game
            if (evt.isAlcohol && (window.currentUserIsAdmin || isCreator)) {
                const shotBtn = document.createElement('button');
                shotBtn.className = 'gold-btn';
                shotBtn.style.padding = '8px 15px';
                shotBtn.style.fontSize = '0.9em';
                shotBtn.style.background = '#ff9800';
                shotBtn.style.color = '#fff';
                shotBtn.innerHTML = '🥃 Shot !';
                shotBtn.addEventListener('click', () => {
                    if (evt.rsvps) {
                        const rsvpUids = Object.entries(evt.rsvps).filter(([uid, status]) => status === 'accepted').map(([uid]) => uid);
                        rsvpUids.forEach(uid => {
                            sendNotification(uid, `🥃 SHOT ! L'organisateur de "${evt.title}" vient de lancer un shot ! SANTÉ !`, 'alert');
                        });
                        showToast(`Shot lancé à ${rsvpUids.length} participants !`, "success");
                    } else {
                        showToast("Personne n'a encore rejoint l'événement.", "error");
                    }
                });
                actions.appendChild(shotBtn);
            }

            card.appendChild(actions);
            eventsList.appendChild(card);
        });

        /* Aperçu du tableau de bord : ce qui reste à venir. Une soirée entière
           déjà jouée retombe sur les derniers événements, faute de mieux. */
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
            previewCount++;
        });

        if (previewCount === 0 && eventsArray.length > 0) {
            previewList.innerHTML = '<p style="color:var(--secondary-text); font-style:italic;">Consultez l\'onglet Événements.</p>';
        }
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

    function sendNotification(targetUid, message, type = 'info') {
        const notifRef = db.ref(`lan/notifications/${targetUid}`).push();
        return notifRef.set({
            message: message,
            timestamp: firebase.database.ServerValue.TIMESTAMP,
            read: false,
            type: type,
            // Les règles Firebase exigent senderId === auth.uid : une notif est
            // toujours attribuable à l'expéditeur réel (fin de l'usurpation anonyme).
            senderId: (auth.currentUser && auth.currentUser.uid) || null
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
        btnNotif.style.display = 'inline-flex';

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

});
