const normalizeGameName = (name) => {
    if (typeof name !== 'string') return '';
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
};

// Échappe le HTML pour éviter les injections (XSS) dans les contenus saisis par les joueurs
const escapeHtml = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};

function levenshtein(s1, s2) { s1 = s1.toLowerCase(); s2 = s2.toLowerCase(); const costs = []; for (let i = 0; i <= s1.length; i++) { let lastValue = i; for (let j = 0; j <= s2.length; j++) { if (i === 0) costs[j] = j; else if (j > 0) { let newValue = costs[j - 1]; if (s1.charAt(i - 1) !== s2.charAt(j - 1)) newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1; costs[j - 1] = lastValue; lastValue = newValue; } } if (i > 0) costs[s2.length] = lastValue; } return costs[s2.length]; }

function checkTypos(newGames, currentVotes) {
    const suggestions = [];
    const masterGameList = new Set();
    Object.values(currentVotes).forEach(voteData => {
        if (voteData.votes) Object.values(voteData.votes).forEach(games => games.forEach(game => masterGameList.add(normalizeGameName(game))));
    });
    const masterArray = Array.from(masterGameList);
    newGames.forEach(newGame => {
        if (masterGameList.has(newGame)) return;
        for (const masterGame of masterArray) {
            const distance = levenshtein(newGame, masterGame);
            if (distance > 0 && distance <= 2) {
                suggestions.push({ original: newGame, suggestion: masterGame });
                return;
            }
        }
    });
    return suggestions;
}

function calculateScores(votes) {
    const gameScores = {};
    const displayNames = {}; // garde la "vraie" casse du nom (ex: "PUBG" et pas "Pubg")
    const upperCount = (s) => (s.match(/[A-Z]/g) || []).length;
    const pointsMapping = { p1: 5, p2: 3, p3: 2, p_other: 1 };
    for (const userId in votes) {
        const voteData = votes[userId];
        if (voteData && voteData.votes) {
            for (const priority in voteData.votes) {
                voteData.votes[priority].forEach(game => {
                    const normalizedGame = normalizeGameName(game);
                    if (normalizedGame) {
                        gameScores[normalizedGame] = (gameScores[normalizedGame] || 0) + pointsMapping[priority];
                        const candidate = String(game).trim().replace(/\s+/g, ' ');
                        const current = displayNames[normalizedGame];
                        if (!current || upperCount(candidate) > upperCount(current)) {
                            displayNames[normalizedGame] = candidate;
                        }
                    }
                });
            }
        }
    }

    return Object.keys(gameScores).map(name => {
        // Si aucune casse d'origine n'est connue (anciens votes en minuscules), on capitalise chaque mot
        const stored = displayNames[name];
        const displayName = (stored && /[A-Z]/.test(stored))
            ? stored
            : name.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        return { name: displayName, score: gameScores[name] };
    }).sort((a, b) => b.score - a.score);
}

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

    logoutBtn.addEventListener('click', () => {
        const user = auth.currentUser;
        if (user) {
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

    function renderActiveUsers(users) {
        const sidebar = document.getElementById('active-users-sidebar');
        const roleSelect = document.getElementById('role-user-select');
        const body = document.body;
        if (!sidebar) return;

        sidebar.innerHTML = '';
        ['role-user-select', 'role-user-select-lan'].forEach(id => {
            const sel = document.getElementById(id);
            if (sel) sel.innerHTML = '<option value="">Sélectionner un joueur...</option>';
        });

        const userCount = users ? Object.keys(users).length : 0;

        if (userCount > 0) {
            sidebar.classList.add('visible');
            body.classList.add('sidebar-visible');
        } else {
            sidebar.classList.remove('visible');
            body.classList.remove('sidebar-visible');
        }

        for (const uid in users) {
            const user = users[uid];
            const img = document.createElement('img');
            img.src = user.avatar;
            img.title = user.name;
            img.className = 'user-avatar-icon';

            img.addEventListener('click', () => {
                showPlayerVotesModal(uid, user.name, globalVotes);
            });

            sidebar.appendChild(img);

            // Populate both role selects (View 3 admin panel + Active LAN admin panel)
            ['role-user-select', 'role-user-select-lan'].forEach(selectId => {
                const sel = document.getElementById(selectId);
                if (sel) {
                    const opt = document.createElement('option');
                    opt.value = uid;
                    opt.textContent = user.name;
                    sel.appendChild(opt);
                }
            });
        }
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
                    row.innerHTML = `<span style="color: var(--primary-text);">${escapeHtml(displayGameName(g))}</span>`;
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

        const userStatusRef = db.ref('/status/' + user.uid);
        const connectedRef = db.ref('.info/connected');

        connectedRef.on('value', (snap) => {
            if (snap.val() === true) {
                const userData = { name: user.displayName, avatar: user.photoURL };
                userStatusRef.set(userData);
                userStatusRef.onDisconnect().remove();
            }
        });

        votesRef = db.ref('lan/votes');
        settingsRef = db.ref('lan/settings');
        eventsRef = db.ref('lan/events');
        cocktailsRef = db.ref('lan/cocktails');
        notificationsRef = db.ref('lan/notifications/' + user.uid);

        db.ref('/status').on('value', snapshot => {
            globalUsers = snapshot.val() || {};
            renderActiveUsers(globalUsers);
        });

        eventsRef.on('value', (snapshot) => {
            const eventsData = snapshot.val() || {};
            window._latestEventsData = eventsData;
            renderEvents(eventsData, user);
            checkEventReminders(eventsData, user);
        });

        // Check reminders every 60 seconds
        setInterval(() => {
            if (window._latestEventsData && auth.currentUser) {
                checkEventReminders(window._latestEventsData, auth.currentUser);
            }
        }, 60000);

        cocktailsRef.on('value', (snapshot) => {
            const cocktailsData = snapshot.val() || {};
            window._latestCocktailsData = cocktailsData;
            renderCocktails(cocktailsData, user);
        });

        notificationsRef.on('value', (snapshot) => {
            renderNotifications(snapshot.val() || {}, user);
        });

        // Bibliothèques Steam, indexées par compte Steam
        db.ref('lan/steamLibraries').on('value', (snapshot) => {
            groupLibraries = snapshot.val() || {};
            renderGroupLibrary();
        });

        settingsRef.on('value', (snapshot) => {
            const newSettings = snapshot.val() || { isVotingOpen: true, topGamesCount: 10, isLanActive: false };

            if (appInitialized && globalSettings.isVotingOpen === true && newSettings.isVotingOpen === false) {
                showToast("Les votes sont terminés ! Voici les résultats...", "success");
                showFinalResults();
            }

            globalSettings = newSettings;
            updateVotingUIState();

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

        if (viewVotingOpen) viewVotingOpen.style.display = 'none';
        if (viewWaitingClosed) viewWaitingClosed.style.display = 'none';
        if (viewAdminDashboard) viewAdminDashboard.style.display = 'none';
        if (viewLanActive) viewLanActive.style.display = 'none';
        if (adminPanelOpen) adminPanelOpen.style.display = 'none';

        const finalResultsModal = document.getElementById('final-results-modal');
        if (finalResultsModal) finalResultsModal.style.display = 'none';

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
        voteForm.addEventListener('input', () => {
            if (voterSelectMenu.value === '' || (auth.currentUser && voterSelectMenu.value === auth.currentUser.uid)) {
                isEditing = true;
            }
        });

        voteForm.addEventListener('click', (e) => {
            if (e.target.classList.contains('add-game-btn')) {
                const list = e.target.previousElementSibling;
                createInput('', false, list);
            }
            if (e.target.classList.contains('remove-game-btn')) {
                e.target.closest('.game-input-wrapper').remove();
            }
            const searchButton = e.target.closest('.steam-search-btn');
            if (searchButton) {
                handleSteamSearch(searchButton);
            }
        });

        voteForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const user = auth.currentUser;
            if (!user) return;
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
            const response = await fetch(`/api/get-game-image?name=${encodeURIComponent(searchTerm)}`);
            if (response.ok) {
                const data = await response.json();
                inputField.value = data.name;
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

    // --- NOUVELLE LAN --------------------------------------------------------

    // Archive le classement en cours puis remet le cycle à zéro : votes effacés,
    // votes rouverts, LAN active désactivée. On ne touche ni aux événements, ni
    // aux kocktails, ni aux bibliothèques Steam — ils survivent d'une LAN à l'autre.
    async function startNewLan(newName) {
        const sortedGames = calculateScores(globalVotes);

        if (sortedGames.length > 0) {
            const previousName = globalSettings.lanName || 'LAN Demain';
            await db.ref('lan/history').push().set({
                name: previousName,
                date: new Date().toLocaleDateString('fr-FR'),
                timestamp: firebase.database.ServerValue.TIMESTAMP,
                topGames: sortedGames.slice(0, globalSettings.topGamesCount || 10),
                votes: globalVotes
            });
        }

        await db.ref('lan/votes').remove();

        const settings = { isVotingOpen: true, isLanActive: false };
        if (newName) settings.lanName = newName;
        await db.ref('lan/settings').update(settings);

        return sortedGames.length;
    }

    document.getElementById('btn-new-lan')?.addEventListener('click', async () => {
        const input = document.getElementById('new-lan-name');
        const newName = (input?.value || '').trim();

        const ok = await askConfirm(
            "Archiver le classement actuel, effacer tous les votes et rouvrir les votes ? Les événements, kocktails et bibliothèques sont conservés.",
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
            row.href = deal.url || '#';
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

    // Fiche pour un jeu absent de Steam : infos Wikipédia, pas de tags Steam,
    // mais on tente quand même le comparateur de prix par titre.
    function renderWikiCard(gameName, wiki) {
        const body = document.getElementById('game-details-body');

        document.getElementById('game-details-title').textContent = wiki.title || gameName;
        document.getElementById('game-details-desc').textContent = wiki.description || '';
        document.getElementById('game-details-tags').innerHTML = '';

        const notice = document.getElementById('game-details-notice');
        notice.textContent = `Pas disponible sur Steam — informations issues de Wikipédia${wiki.lang === 'en' ? ' (en anglais)' : ''}.`;
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
        steamLink.href = wiki.url || '#';
        steamLink.textContent = 'Wikipédia';
        document.getElementById('game-details-ig').href =
            `https://www.instant-gaming.com/fr/rechercher/?q=${storeQuery}`;
        document.getElementById('game-details-itad').href =
            `https://isthereanydeal.com/search/?q=${storeQuery}`;

        renderDeals(null);
        getDeals({ title: wiki.title || gameName }).then(renderDeals);

        body.style.display = 'block';
    }

    async function openGameDetails(gameName) {
        const modal = document.getElementById('game-details-modal');
        if (!modal) return;

        const loading = document.getElementById('game-details-loading');
        const body = document.getElementById('game-details-body');
        const errorBox = document.getElementById('game-details-error');

        modal.style.display = 'flex';
        loading.style.display = 'block';
        body.style.display = 'none';
        errorBox.style.display = 'none';

        const details = await getGameDetails(gameName);

        // Pas de correspondance exacte sur Steam : on bascule sur Wikipédia
        // plutôt que d'afficher la fiche d'un autre jeu.
        if (!details || !details.exactMatch) {
            const wiki = await getWikiInfo(gameName);
            loading.style.display = 'none';

            if (!wiki || !wiki.found) {
                errorBox.style.display = 'block';
                return;
            }
            renderWikiCard(gameName, wiki);
            return;
        }

        loading.style.display = 'none';

        document.getElementById('game-details-title').textContent = details.name || gameName;
        document.getElementById('game-details-desc').textContent = details.shortDescription || '';
        renderTags(document.getElementById('game-details-tags'), details, 8);
        document.getElementById('game-details-notice').style.display = 'none';

        // Les prix arrivent après coup : la fiche s'affiche sans attendre
        renderDeals(null);
        getDeals({ appId: details.appId }).then(renderDeals);

        // Steam ne sert la bande-annonce qu'en HLS. Attention : Chrome répond
        // "maybe" à canPlayType pour ce type MIME alors qu'il ne sait pas le lire
        // (le lecteur reste bloqué à readyState 0). Seul "probably" — Safari —
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
        row.addEventListener('click', () => openGameDetails(game.name));
        return row;
    }

    // Agrège les bibliothèques liées et compte les propriétaires de chaque jeu
    function aggregateLibraries(players) {
        const owners = new Map();
        players.forEach(player => {
            // Set : un même jeu ne doit compter qu'une fois par joueur
            const seen = new Set();
            (player.games || []).forEach(g => {
                if (seen.has(g.appId)) return;
                seen.add(g.appId);
                const entry = owners.get(g.appId) || { name: g.name, count: 0, minutes: 0 };
                entry.count += 1;
                entry.minutes += g.playtimeMinutes || 0;
                owners.set(g.appId, entry);
            });
        });
        return [...owners.entries()].map(([appId, e]) => ({ appId, ...e }));
    }

    // Le panneau apparaît dans deux vues (vote et LAN active). On l'injecte dans
    // chaque point de montage plutôt que de dupliquer le markup : des ID en double
    // ne câbleraient que la première copie — c'est exactement le bug B1.
    const LIBRARY_PANEL_HTML = `
        <h3 class="section-title">🎮 Bibliothèques Steam</h3>
        <p class="panel-section__hint js-library-summary">Aucune bibliothèque liée.</p>
        <div class="filter-bar js-library-filter"></div>
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

        const libraries = Object.values(groupLibraries).filter(p => Array.isArray(p.games) && p.games.length);
        const playerCount = libraries.length;
        const names = libraries.map(p => p.personaName).filter(Boolean);

        container.innerHTML = '';

        if (playerCount === 0) {
            if (summary) summary.textContent = 'Aucune bibliothèque Steam ajoutée pour l\'instant.';
            if (filterBar) filterBar.innerHTML = '';
            container.innerHTML = '<p style="font-style:italic; color:var(--secondary-text);">Ajoutez un profil Steam ci-dessous — le vôtre ou celui d\'un ami.</p>';
            return;
        }

        const all = aggregateLibraries(libraries);
        const shared = all.filter(g => g.count > 1);

        if (summary) {
            summary.textContent = playerCount === 1
                ? `1 bibliothèque : ${names[0]} (${all.length} jeux). Ajoutez celle d'un ami pour comparer.`
                : `${playerCount} bibliothèques — ${shared.length} jeux en commun sur ${all.length}.`;
        }

        // Onglets : en commun, tous, puis un par personne
        if (filterBar) {
            filterBar.innerHTML = '';
            const chips = [];
            if (playerCount > 1) chips.push({ mode: 'common', label: 'En commun' });
            chips.push({ mode: 'all', label: 'Tous' });
            libraries.forEach(lib => chips.push({ mode: lib.steamId, label: lib.personaName || 'Joueur' }));

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
            const lib = groupLibraries[libraryMode];
            countBasis = 1;
            list = lib && Array.isArray(lib.games)
                ? lib.games
                    .map(g => ({ appId: g.appId, name: g.name, count: 1, minutes: g.playtimeMinutes || 0 }))
                    .sort((a, b) => b.minutes - a.minutes)
                : [];
        }

        if (list.length === 0) {
            container.innerHTML = '<p style="font-style:italic; color:var(--secondary-text);">Aucun jeu à afficher ici.</p>';
            return;
        }

        list.slice(0, 60).forEach((game, index) => {
            container.appendChild(buildLibraryRow(game, index, countBasis));
        });

        renderLinkedLibrariesAdmin(libraries, mount);
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

            const name = document.createElement('span');
            name.className = 'player-row__name';
            // Une bibliothèque est un instantané : sans date, impossible de
            // savoir si elle date d'avant les derniers achats.
            name.textContent = `${lib.personaName} — ${(lib.games || []).length} jeux · ${formatAge(lib.updatedAt)}`;
            name.title = lib.addedByName ? `Ajoutée par ${lib.addedByName}` : '';

            const del = document.createElement('button');
            del.className = 'danger-link-btn';
            del.textContent = 'Retirer';
            del.style.marginLeft = 'auto';
            del.addEventListener('click', () => {
                askConfirm(`Retirer la bibliothèque de ${lib.personaName} ?`, { danger: true }).then(ok => {
                    if (!ok) return;
                    db.ref(`lan/steamLibraries/${lib.steamId}`).remove()
                        .then(() => showToast(`Bibliothèque de ${lib.personaName} retirée.`, 'success'))
                        .catch(err => showToast('Erreur : ' + err.message, 'error'));
                });
            });

            row.append(name, del);
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

    // Tags sélectionnés (clé en minuscules) — un jeu doit tous les porter
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

    // Event Reminders — toast when a registered event is coming up within 15 minutes
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

        Object.entries(eventsData).forEach(([id, evt]) => {
            if (!evt.time || remindedEventIds.has(id)) return;
            // Only remind if the user has accepted this event
            if (!evt.rsvps || evt.rsvps[currentUser.uid] !== 'accepted') return;
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
                    `Ça commence à ${evt.time} — dans ${diff} minute(s).`
                );
            }
        });
    }

    // 4. Navigation — re-render data on tab switch
    document.querySelectorAll('.lan-nav-list .nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const targetId = e.currentTarget.dataset.target;
            if (targetId === 'lan-kocktails' && window._latestCocktailsData) {
                renderCocktails(window._latestCocktailsData, auth.currentUser);
            }
            if (targetId === 'lan-events' && window._latestEventsData) {
                renderEvents(window._latestEventsData, auth.currentUser);
            }
            // Deactivate all
            document.querySelectorAll('.lan-nav-list .nav-item').forEach(nav => nav.classList.remove('active'));
            document.querySelectorAll('.lan-subview').forEach(view => {
                view.style.display = 'none';
                view.classList.remove('active');
            });

            // Activate target — reuse targetId already declared above
            e.currentTarget.classList.add('active');
            const targetView = document.getElementById(targetId);
            if (targetView) {
                targetView.style.display = 'block';
                targetView.classList.add('active');
            }
        });
    });

    // 2. Modals (Events & Kocktails)
    document.getElementById('btn-create-event')?.addEventListener('click', () => {
        const createModal = document.getElementById('create-event-modal');
        if (createModal) createModal.style.display = 'flex';

        if (window.currentUserIsAdmin) {
            const toggleContainer = document.getElementById('event-global-toggle-container');
            if (toggleContainer) toggleContainer.style.display = 'flex';
        }
    });

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

    // Active LAN admin panel — role assignment
    document.getElementById('btn-assign-role-lan')?.addEventListener('click', () => {
        const uid = document.getElementById('role-user-select-lan').value;
        const role = document.getElementById('role-type-select-lan').value;
        if (!uid) { showToast('Veuillez sélectionner un joueur.', 'error'); return; }

        db.ref('lan/roles/' + uid).set(role)
            .then(() => showToast('Rôle mis à jour avec succès !', 'success'))
            .catch(err => showToast('Erreur: ' + err.message, 'error'));
    });

    // Active LAN admin panel — toggle voting button
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
                        Object.keys(users).forEach(uid => {
                            if (uid !== user.uid) {
                                sendNotification(uid,
                                    `${emoji} ${user.displayName} a créé un événement : "${title}" ${time ? 'à ' + time : ''}`,
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

    // --- RENDER EVENTS ---
    function renderEvents(eventsData, currentUser) {
        const eventsList = document.getElementById('events-list');
        const previewList = document.getElementById('upcoming-events-preview');
        if (!eventsList || !previewList) return;

        eventsList.innerHTML = '';
        previewList.innerHTML = '';

        const eventsArray = Object.entries(eventsData).map(([id, data]) => ({ id, ...data }));
        // Sort by creation time descending for now
        eventsArray.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

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
                    // Muted green badge — clickable to un-register
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

            // Add to preview up to 3
            if (previewCount < 3) {
                const previewItem = document.createElement('div');
                previewItem.className = 'list-item';
                previewItem.innerHTML = `
                       <div>
                           <div style="color: var(--primary-text); font-weight: 500;">${evt.isGlobal ? '🌍 ' : ''}${escapeHtml(evt.title)}</div>
                           <div style="font-size: 0.85em; color: var(--secondary-text);">${escapeHtml(evt.game || '')} ${evt.time ? 'à ' + escapeHtml(evt.time) : ''}</div>
                       </div>
                       <div style="font-size: 0.85em; color: var(--accent-color);">👥 ${rsvpCount}</div>
                   `;
                previewList.appendChild(previewItem);
                previewCount++;
            }
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
            type: type
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
