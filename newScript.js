const normalizeGameName = (name) => {
    if (typeof name !== 'string') return '';
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
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
    const pointsMapping = { p1: 5, p2: 3, p3: 2, p_other: 1 };
    for (const userId in votes) {
        const voteData = votes[userId];
        if (voteData && voteData.votes) {
            for (const priority in voteData.votes) {
                voteData.votes[priority].forEach(game => {
                    const normalizedGame = normalizeGameName(game);
                    if (normalizedGame) {
                        gameScores[normalizedGame] = (gameScores[normalizedGame] || 0) + pointsMapping[priority];
                    }
                });
            }
        }
    }

    const finalScores = {};
    Object.keys(gameScores).forEach(name => {
        const capitalizedName = name.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        finalScores[capitalizedName] = gameScores[name];
    });

    return Object.entries(finalScores).map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score);
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

    async function getGameImage(gameName) {
        const normalizedName = gameName.toLowerCase().trim();
        if (imageCache.has(normalizedName)) {
            return imageCache.get(normalizedName);
        }

        try {
            const response = await fetch(`/api/get-game-image?name=${encodeURIComponent(normalizedName)}`);
            if (response.ok) {
                const data = await response.json();
                imageCache.set(normalizedName, data.imageUrl);
                return data.imageUrl;
            } else {
                imageCache.set(normalizedName, DEFAULT_GAME_ICON);
                return DEFAULT_GAME_ICON;
            }
        } catch (error) {
            console.error("API Error:", error);
        }
        imageCache.set(normalizedName, DEFAULT_GAME_ICON);
        return DEFAULT_GAME_ICON;
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

            const createSection = (title, gamesArray, color) => {
                if (!gamesArray || gamesArray.length === 0) return;
                const sec = document.createElement('div');
                sec.style.marginBottom = '15px';
                sec.innerHTML = `<h5 style="color: ${color}; margin-bottom: 5px; font-family: 'Outfit'; font-size: 0.9em;">${title}</h5>`;
                gamesArray.forEach(g => {
                    const row = document.createElement('div');
                    row.style.cssText = "display: flex; align-items: center; gap: 10px; margin-bottom: 5px; font-size: 0.9em;";
                    row.innerHTML = `<span style="color: var(--primary-text);">${g}</span>`;
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
            const adminPanel = document.getElementById('admin-dashboard');
            const lanAdminNav = document.getElementById('lan-nav-admin');
            if (window.currentUserIsAdmin) {
                const adminPanelEl = document.getElementById('admin-panel');
                if (adminPanelEl) adminPanelEl.style.display = 'block';
                if (lanAdminNav) lanAdminNav.style.display = 'block';
            } else {
                if (lanAdminNav) lanAdminNav.style.display = 'none';
            }
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

        settingsRef.on('value', (snapshot) => {
            const newSettings = snapshot.val() || { isVotingOpen: true, topGamesCount: 10, isLanActive: false };

            if (appInitialized && globalSettings.isVotingOpen === true && newSettings.isVotingOpen === false) {
                showToast("Les votes sont terminés ! Voici les résultats...", "success");
                showFinalResults();
            }

            globalSettings = newSettings;
            updateVotingUIState();

            if (isAdmin) {
                const toggleBtns = document.querySelectorAll('#toggle-voting-btn, #toggle-voting-btn-open, #toggle-voting-btn-dashboard');
                toggleBtns.forEach(btn => btn && (btn.textContent = globalSettings.isVotingOpen ? "Clôturer le Vote" : "Ouvrir le Vote"));
                const countInputs = document.querySelectorAll('#top-games-count, #dashboard-top-games-count');
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

    document.getElementById('toggle-voting-btn')?.addEventListener('click', handleToggleVoting);
    document.getElementById('toggle-voting-btn-open')?.addEventListener('click', handleToggleVoting);
    document.getElementById('toggle-voting-btn-dashboard')?.addEventListener('click', handleToggleVoting);

    document.getElementById('start-active-lan-btn')?.addEventListener('click', () => {
        const confirmLan = confirm("Êtes-vous sûr de vouloir démarrer la LAN en mode actif ? Cela fermera le mode attente pour tout le monde.");
        if (confirmLan) {
            db.ref('lan/settings').update({ isLanActive: true })
                .then(() => {
                    const finalModal = document.getElementById('final-results-modal');
                    if (finalModal) finalModal.style.display = 'none';
                    showToast("La LAN est officiellement ouverte !", "success");
                });
        }
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

    document.getElementById('reset-all-votes-btn')?.addEventListener('click', () => {
        const confirmation = prompt("Cette action est irréversible et supprimera TOUS les votes. Pour confirmer, tapez 'RESET'.");
        if (confirmation === 'RESET') {
            db.ref('lan/votes').remove()
                .then(() => showToast("Tous les votes ont été réinitialisés.", "success"))
                .catch((err) => showToast("Erreur lors de la réinitialisation: " + err.message, "error"));
        } else if (confirmation !== null) {
            showToast("Action annulée.");
        }
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
                    const game = normalizeGameName(input.value);
                    if (game) {
                        playerVotes[priority].push(game);
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
            li.innerHTML = `Remplacer votre saisie <em>${sugg.original}</em> par le jeu déjà existant <strong>${sugg.suggestion}</strong> ?`;
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
        db.ref('lan/history').push(historyEntry)
            .then(() => showToast('Résultats archivés dans l\'historique !', 'success'))
            .catch(err => console.error('Archive error:', err));
    }

    // Populate closed-voting game lists (both user and admin views)
    function renderClosedResults(sortedGames) {
        const count = globalSettings.topGamesCount || 10;
        const topGames = sortedGames.slice(0, count);

        const renderList = async (containerId) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';

            for (let i = 0; i < topGames.length; i++) {
                const game = topGames[i];
                const item = document.createElement('div');
                item.style.cssText = `display: flex; align-items: center; background: rgba(20,20,20,0.8); border: 1px solid var(--border-color); padding: 12px 15px; border-radius: 4px; gap: 15px;`;

                const img = document.createElement('img');
                img.src = DEFAULT_GAME_ICON;
                img.style.cssText = "width: 80px; height: 37px; object-fit: cover; border-radius: 2px;";
                getGameImage(game.name).then(url => img.src = url);

                const rank = document.createElement('div');
                rank.style.cssText = "font-family: 'Playfair Display'; font-size: 1.5em; color: var(--accent-color); min-width: 35px;";
                rank.textContent = `#${i + 1}`;

                const info = document.createElement('div');
                info.style.flex = '1';
                info.innerHTML = `<div style="font-weight:500; color:var(--primary-text);">${game.name}</div><div style="font-size:0.85em; color:var(--secondary-text);">${game.score} points</div>`;

                item.appendChild(rank);
                item.appendChild(img);
                item.appendChild(info);
                container.appendChild(item);
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

        topGames.forEach((game, index) => {
            const row = document.createElement('div');
            row.style.cssText = "display: flex; align-items: center; gap: 15px; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);";

            const img = document.createElement('img');
            img.src = DEFAULT_GAME_ICON;
            img.style.cssText = "width: 60px; height: 28px; object-fit: cover; border-radius: 2px;";
            getGameImage(game.name).then(url => img.src = url);

            const rank = document.createElement('span');
            rank.style.cssText = "color: var(--accent-color); font-weight: bold; min-width: 30px;";
            rank.textContent = `#${index + 1}`;

            const name = document.createElement('span');
            name.style.cssText = "flex: 1; color: var(--primary-text);";
            name.textContent = game.name;

            const score = document.createElement('span');
            score.style.cssText = "color: var(--secondary-text); font-size: 0.9em;";
            score.textContent = `${game.score} pts`;

            row.appendChild(rank);
            row.appendChild(img);
            row.appendChild(name);
            row.appendChild(score);
            container.appendChild(row);
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
                    ${game.name}
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
            topGames.forEach((game, index) => {
                const item = document.createElement('div');
                item.style.cssText = `display: flex; align-items: center; background: rgba(20,20,20,0.8); border: 1px solid var(--border-color); padding: 15px; border-radius: 4px; gap: 20px; opacity: 0; animation: etherealFadeInUp 0.5s forwards ${index * 0.1}s;`;

                const img = document.createElement('img');
                img.src = DEFAULT_GAME_ICON;
                img.style.cssText = "width: 120px; height: 56px; object-fit: cover; border-radius: 2px; box-shadow: 0 2px 10px rgba(0,0,0,0.5);";
                getGameImage(game.name).then(url => img.src = url);

                const rank = document.createElement('div');
                rank.style.cssText = "font-family: 'Playfair Display'; font-size: 2em; color: var(--accent-color); min-width: 40px;";
                rank.textContent = `#${index + 1}`;

                const details = document.createElement('div');
                details.style.flex = "1";
                const title = document.createElement('div');
                title.style.cssText = "font-family: 'Playfair Display'; font-size: 1.3em; color: var(--primary-text); margin-bottom: 5px;";
                title.textContent = game.name;
                const scoreDesc = document.createElement('div');
                scoreDesc.style.cssText = "font-size: 0.9em; color: var(--secondary-text);";
                scoreDesc.textContent = `${game.score} points`;

                details.appendChild(title);
                details.appendChild(scoreDesc);

                item.appendChild(rank);
                item.appendChild(img);
                item.appendChild(details);

                listContainer.appendChild(item);
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
                card.style.cssText = "background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: 4px; padding: 20px;";

                const header = document.createElement('div');
                header.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;";
                header.innerHTML = `<h3 style="margin:0; color: var(--accent-color);">${entry.name || 'LAN'}</h3><span style="color:var(--secondary-text); font-size:0.9em;">${entry.date || ''}</span>`;
                card.appendChild(header);

                if (entry.topGames && entry.topGames.length > 0) {
                    const list = document.createElement('div');
                    list.style.cssText = "display: flex; flex-direction: column; gap: 8px;";
                    entry.topGames.slice(0, 5).forEach((game, i) => {
                        const row = document.createElement('div');
                        row.style.cssText = "display: flex; align-items: center; gap: 10px; font-size: 0.9em;";
                        row.innerHTML = `<span style="color:var(--accent-color); min-width:25px; font-weight:bold;">#${i + 1}</span><span style="color:var(--primary-text);">${game.name}</span><span style="color:var(--secondary-text); margin-left:auto;">${game.score} pts</span>`;
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
        const confirmLan = confirm("Êtes-vous sûr de vouloir ouvrir la LAN en mode actif ? Tout le monde passera en mode LAN active.");
        if (confirmLan) {
            db.ref('lan/settings').update({ isLanActive: true })
                .then(() => showToast("La LAN est officiellement ouverte ! 🔥", "success"));
        }
    });

    // --- ADMIN BROADCAST NOTIFICATION ---
    document.getElementById('btn-send-broadcast')?.addEventListener('click', () => {
        const msgInput = document.getElementById('broadcast-message');
        if (!msgInput) return;
        const message = msgInput.value.trim();
        if (!message) { showToast('Saisissez un message d\'abord.', 'error'); return; }

        db.ref('/status').once('value').then(snapshot => {
            const users = snapshot.val() || {};
            const sends = Object.keys(users).map(uid => sendNotification(uid, `🍊 Admin: ${message}`));
            Promise.all(sends).then(() => {
                showToast(`Message envoyé à ${sends.length} joueur(s) !`, 'success');
                msgInput.value = '';
            });
        });
    });

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
    btnNotifications?.addEventListener('click', () => {
        if (!notifPanel) return;
        notifPanel.style.display = (notifPanel.style.display === 'none' || !notifPanel.style.display) ? 'block' : 'none';
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
            title.innerHTML = `${evt.isGlobal ? '🌍 ' : ''}${evt.title} <span style="font-size: 0.6em; color: var(--secondary-text); font-family: 'Outfit'; font-weight: normal; margin-left: 10px;">par ${evt.creatorName || 'Inconnu'}</span>`;
            titleContainer.appendChild(title);
            card.appendChild(titleContainer);

            const meta = document.createElement('div');
            meta.className = 'event-meta';
            if (evt.game) meta.innerHTML += `<span>🎮 ${evt.game}</span>`;
            if (evt.time) meta.innerHTML += `<span>🕒 ${evt.time}</span>`;

            const rsvpCount = evt.rsvps ? Object.values(evt.rsvps).filter(v => v === 'accepted').length : 0;
            if (evt.slots > 0) {
                meta.innerHTML += `<span>👥 ${rsvpCount} / ${evt.slots}</span>`;
            } else {
                meta.innerHTML += `<span>👥 ${rsvpCount} participant(s)</span>`;
            }
            if (evt.isAlcohol) {
                meta.innerHTML += `<span style="color: #ff9800; font-weight: bold;">🥃 Jeu à boire</span>`;
            }
            card.appendChild(meta);

            if (evt.description || (evt.isAlcohol && evt.alcoholRules)) {
                const descBox = document.createElement('div');
                descBox.style.cssText = "font-size: 0.9em; color: var(--secondary-text); background: rgba(255,255,255,0.03); padding: 10px; border-radius: 4px; margin-top: 10px; border-left: 2px solid var(--border-color);";
                if (evt.description) descBox.innerHTML += `<div>${evt.description}</div>`;
                if (evt.isAlcohol && evt.alcoholRules) {
                    descBox.innerHTML += `<div style="margin-top: 5px; color: #ff9800; font-size: 0.85em;"><strong>Règles:</strong> ${evt.alcoholRules}</div>`;
                }
                card.appendChild(descBox);
            }

            // Action buttons (RSVP)
            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.gap = '10px';
            actions.style.marginTop = '15px';

            const hasAccepted = evt.rsvps && evt.rsvps[currentUser.uid] === 'accepted';
            const isCreator = evt.creatorId === currentUser.uid;

            if (hasAccepted) {
                const acceptedBadge = document.createElement('span');
                acceptedBadge.style.cssText = 'padding: 6px 14px; font-size: 0.9em; border-radius: 15px; display: inline-flex; align-items: center; gap: 5px;';

                if (isCreator) {
                    // Static non-interactive badge for creator
                    acceptedBadge.style.background = 'rgba(212,175,55,0.12)';
                    acceptedBadge.style.color = 'var(--accent-color)';
                    acceptedBadge.style.border = '1px solid rgba(212,175,55,0.3)';
                    acceptedBadge.textContent = '✓ Organisateur';
                    acceptedBadge.title = "Vous êtes le créateur.";
                } else {
                    // Muted green badge — clickable to un-register
                    acceptedBadge.style.background = 'rgba(76,175,80,0.12)';
                    acceptedBadge.style.color = '#81c784';
                    acceptedBadge.style.border = '1px solid rgba(76,175,80,0.3)';
                    acceptedBadge.style.cursor = 'pointer';
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
                });
                actions.appendChild(rsvpBtn);
            }

            // Admin or Creator can delete
            if (window.currentUserIsAdmin || isCreator) {
                const delBtn = document.createElement('button');
                delBtn.className = 'danger-link-btn';
                delBtn.textContent = 'Supprimer';
                delBtn.addEventListener('click', () => {
                    if (confirm("Supprimer cet événement ?")) {
                        db.ref(`lan/events/${evt.id}`).remove();
                    }
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
                previewItem.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255,255,255,0.02); border-left: 2px solid var(--accent-color); border-radius: 2px;";
                previewItem.innerHTML = `
                       <div>
                           <div style="color: var(--primary-text); font-weight: 500;">${evt.isGlobal ? '🌍 ' : ''}${evt.title}</div>
                           <div style="font-size: 0.85em; color: var(--secondary-text);">${evt.game || ''} ${evt.time ? 'à ' + evt.time : ''}</div>
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
                        <h4>${kocktail.name}</h4>
                        <p style="font-size: 0.8em; color: var(--secondary-text); margin-bottom: 15px;">${kocktail.ingredients || 'Secret du barman'}</p>
                   `;
                const orderBtn = document.createElement('button');
                orderBtn.className = 'gold-link-btn';
                orderBtn.textContent = 'Commander';
                orderBtn.addEventListener('click', () => orderCocktail(kocktail.name, currentUser));
                card.appendChild(orderBtn);
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
                        <h4>${kocktail.name}</h4>
                        <p style="font-size: 0.8em; color: var(--secondary-text); margin-bottom: 5px;">Proposé par: ${kocktail.creatorName}</p>
                        <p style="font-size: 0.8em; color: var(--accent-color); margin-bottom: 15px;">${kocktail.recipe || ''}</p>
                   `;
                const orderBtn = document.createElement('button');
                orderBtn.className = 'gold-link-btn';
                orderBtn.textContent = 'Commander';
                orderBtn.addEventListener('click', () => orderCocktail(kocktail.name, currentUser));
                card.appendChild(orderBtn);
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
                    item.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(187,134,252,0.1); border: 1px solid rgba(187,134,252,0.3); border-radius: 4px;";
                    item.innerHTML = `
                             <div>
                                  <strong>${order.cocktailName}</strong> pour <span style="color: var(--primary-text);">${order.userName}</span>
                                  <div style="font-size: 0.8em; color: var(--secondary-text);">${new Date(order.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                             </div>
                        `;
                    const doneBtn = document.createElement('button');
                    doneBtn.className = 'gold-link-btn';
                    doneBtn.style.borderColor = '#bb86fc';
                    doneBtn.style.color = '#bb86fc';
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

    function orderCocktail(cocktailName, user) {
        if (!confirm(`Commander un ${cocktailName} ?`)) return;
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
            text.innerHTML = notif.message;
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
