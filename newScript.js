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
    let globalVotes = {};
    let globalSettings = { isVotingOpen: true, topGamesCount: 10 };
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
            sidebar.appendChild(img);
        }
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

        db.ref('/status').on('value', snapshot => renderActiveUsers(snapshot.val()));

        votesRef = db.ref('lan/votes');
        settingsRef = db.ref('lan/settings');

        settingsRef.on('value', (snapshot) => {
            const newSettings = snapshot.val() || { isVotingOpen: true, topGamesCount: 10 };

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
        const adminPanelOpen = document.getElementById('admin-panel-open');
        const form = document.getElementById('vote-form');
        const message = document.getElementById('voting-closed-message');

        if (viewVotingOpen) viewVotingOpen.style.display = 'none';
        if (viewWaitingClosed) viewWaitingClosed.style.display = 'none';
        if (viewAdminDashboard) viewAdminDashboard.style.display = 'none';
        if (adminPanelOpen) adminPanelOpen.style.display = 'none';

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
});
