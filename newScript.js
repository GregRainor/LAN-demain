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
    let globalUsers = {}; // Store all users for the event creation UI & avatars
    let appInitialized = false;
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
        const body = document.body;
        if (!sidebar) return;

        sidebar.innerHTML = '';
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
        }
    }

    function showPlayerVotesModal(uid, userName, votesData) {
        const modal = document.getElementById('player-votes-modal');
        const nameEl = document.getElementById('player-votes-name');
        const listEl = document.getElementById('player-votes-list');

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
        const isAdmin = user.uid === ADMIN_UID;
        window.currentUserIsAdmin = isAdmin;

        if (isAdmin) {
            document.getElementById('admin-panel').style.display = 'block';
        }

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
            renderEvents(snapshot.val() || {}, user);
        });

        cocktailsRef.on('value', (snapshot) => {
            renderCocktails(snapshot.val() || {}, user);
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

                const openLanBtn = document.getElementById('start-active-lan-btn');
                if (openLanBtn) {
                    if (globalSettings.isLanActive) {
                        openLanBtn.style.display = 'none';
                    } else if (!globalSettings.isVotingOpen) {
                        openLanBtn.style.display = 'block';
                    } else {
                        openLanBtn.style.display = 'none';
                    }
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
        const message = document.getElementById('voting-closed-message');

        if (viewVotingOpen) viewVotingOpen.style.display = 'none';
        if (viewWaitingClosed) viewWaitingClosed.style.display = 'none';
        if (viewAdminDashboard) viewAdminDashboard.style.display = 'none';
        if (viewLanActive) viewLanActive.style.display = 'none';
        if (adminPanelOpen) adminPanelOpen.style.display = 'none';

        document.getElementById('final-results-modal').style.display = 'none';

        if (globalSettings.isLanActive) {
            if (viewLanActive) viewLanActive.style.display = 'block';
            // Stop the marquee if it was running.
            const track = document.getElementById('waiting-marquee');
            if (track) track.innerHTML = '';
            return;
        }

        if (globalSettings.isVotingOpen) {
            if (viewVotingOpen) viewVotingOpen.style.display = 'block';
            if (form) form.style.display = 'flex';
            if (message) message.style.display = 'none';
            if (window.currentUserIsAdmin && adminPanelOpen) {
                adminPanelOpen.style.display = 'block';
            }
        } else {
            if (form) form.style.display = 'none';
            if (message) message.style.display = 'block';

            if (window.currentUserIsAdmin) {
                if (viewAdminDashboard) viewAdminDashboard.style.display = 'block';
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

        db.ref('lan/settings').set({
            isVotingOpen: newIsOpen,
            topGamesCount: newCount
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
                    document.getElementById('final-results-modal').style.display = 'none';
                    showToast("La LAN est officiellement ouverte !", "success");
                });
        }
    });

    document.getElementById('save-config-btn')?.addEventListener('click', () => {
        const countEl = document.getElementById('dashboard-top-games-count');
        const newCount = countEl ? (parseInt(countEl.value) || 10) : 10;
        db.ref('lan/settings').set({
            isVotingOpen: globalSettings.isVotingOpen,
            topGamesCount: newCount
        }).then(() => showToast("Configuration sauvegardée", "success"))
            .catch(e => showToast("Erreur: " + e.message, "error"));
    });

    document.getElementById('close-results-btn')?.addEventListener('click', () => {
        document.getElementById('final-results-modal').style.display = 'none';
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
        const track = document.getElementById('waiting-marquee');
        if (!track || track.childElementCount > 0) return;

        const sortedGames = calculateScores(globalVotes);
        let gamesForMarquee = sortedGames.slice(0, 5).map(g => g.name);

        const topSteamGames = [
            "Counter-Strike 2", "Dota 2", "PUBG: BATTLEGROUNDS",
            "Apex Legends", "Helldivers 2", "Palworld", "Grand Theft Auto V",
            "Team Fortress 2", "Rust", "Baldur's Gate 3", "Cyberpunk 2077",
            "ELDEN RING", "War Thunder", "Left 4 Left 2", "Terraria",
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

        const allCards = [...cards, ...cards.map(c => c.cloneNode(true)), ...cards.map(c => c.cloneNode(true))];
        allCards.forEach(c => track.appendChild(c));
    }

    // --- PHASE 4: ACTIVE LAN LOGIC ---

    // 1. Navigation
    document.querySelectorAll('.lan-nav-list .nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            // Deactivate all
            document.querySelectorAll('.lan-nav-list .nav-item').forEach(nav => nav.classList.remove('active'));
            document.querySelectorAll('.lan-subview').forEach(view => {
                view.style.display = 'none';
                view.classList.remove('active');
            });

            // Activate target
            e.target.classList.add('active');
            const targetId = e.target.getAttribute('data-target');
            const targetView = document.getElementById(targetId);
            if (targetView) {
                targetView.style.display = 'block';
                targetView.classList.add('active');
            }
        });
    });

    // 2. Modals (Events & Kocktails)
    document.getElementById('btn-create-event')?.addEventListener('click', () => {
        document.getElementById('create-event-modal').style.display = 'flex';
        if (window.currentUserIsAdmin) {
            document.getElementById('event-global-toggle-container').style.display = 'flex';
        }
    });

    document.getElementById('cancel-event-btn')?.addEventListener('click', () => {
        document.getElementById('create-event-modal').style.display = 'none';
    });

    document.getElementById('close-player-votes-btn')?.addEventListener('click', () => {
        document.getElementById('player-votes-modal').style.display = 'none';
    });

    // Handle Event Creation
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
            const isGlobal = document.getElementById('event-is-global')?.checked || false;

            const newEvent = {
                title: title,
                game: game || '',
                time: time || '',
                slots: slots ? parseInt(slots) : 0,
                creatorId: user.uid,
                creatorName: user.displayName,
                isGlobal: isGlobal,
                rsvps: {},
                createdAt: firebase.database.ServerValue.TIMESTAMP
            };

            // By default, the creator RSVPs "yes"
            newEvent.rsvps[user.uid] = 'accepted';

            const newEventRef = eventsRef.push();
            newEventRef.set(newEvent)
                .then(() => {
                    showToast("Événement créé avec succès !", "success");
                    document.getElementById('create-event-modal').style.display = 'none';
                    createEventForm.reset();
                })
                .catch(err => {
                    showToast("Erreur lors de la création de l'événement.", "error");
                    console.error(err);
                });
        });
    }

    // 3. Dummy Notifications toggle
    const btnNotifications = document.getElementById('btn-notifications');
    const notifPanel = document.getElementById('notifications-panel');
    btnNotifications?.addEventListener('click', () => {
        if (notifPanel.style.display === 'none' || !notifPanel.style.display) {
            notifPanel.style.display = 'block';
        } else {
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
            card.appendChild(meta);

            // Action buttons (RSVP)
            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.gap = '10px';
            actions.style.marginTop = '15px';

            const hasAccepted = evt.rsvps && evt.rsvps[currentUser.uid] === 'accepted';
            const isCreator = evt.creatorId === currentUser.uid;

            if (hasAccepted) {
                const acceptedBtn = document.createElement('button');
                acceptedBtn.className = 'gold-btn';
                acceptedBtn.style.padding = '8px 15px';
                acceptedBtn.style.fontSize = '0.9em';
                acceptedBtn.textContent = '✓ Accepté';
                acceptedBtn.dataset.eventId = evt.id;

                // Allow un-accepting if not creator
                if (!isCreator) {
                    acceptedBtn.addEventListener('click', () => {
                        db.ref(`lan/events/${evt.id}/rsvps/${currentUser.uid}`).remove();
                    });
                } else {
                    acceptedBtn.style.cursor = 'default';
                    acceptedBtn.title = "Vous êtes le créateur.";
                }
                actions.appendChild(acceptedBtn);
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

        if (!masterList || !oneShotList) return;

        masterList.innerHTML = '';
        oneShotList.innerHTML = '';
        if (ordersList) ordersList.innerHTML = '';

        const master = cocktailsData.masterList || {};
        const oneShots = cocktailsData.oneShot || {};
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
        if (window.currentUserIsAdmin && queuePanel) {
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
                        sendNotification(order.userId, `Votre cocktail "${order.cocktailName}" est prêt au bar ! 🍹`);
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

    function sendNotification(targetUid, message) {
        const notifRef = db.ref(`lan/notifications/${targetUid}`).push();
        notifRef.set({
            message: message,
            timestamp: firebase.database.ServerValue.TIMESTAMP,
            read: false
        });
    }

    // --- RENDER NOTIFICATIONS ---
    function renderNotifications(notifsData, currentUser) {
        const notifList = document.getElementById('notifications-list');
        const badge = document.getElementById('notif-badge');
        const btnNotif = document.getElementById('btn-notifications');

        if (!notifList || !badge || !btnNotif) return;

        // Show the bell icon since LAN is active and we have the listener running
        if (globalSettings.isLanActive) btnNotif.style.display = 'inline-flex';

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
            const item = document.createElement('div');
            item.className = `notif-item ${!notif.read ? 'unread' : ''}`;

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
