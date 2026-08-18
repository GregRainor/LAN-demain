// Logique partagée entre l'interface bureau (newScript.js) et l'interface
// téléphone (mobile.js). Aucune de ces fonctions ne touche au DOM ni à Firebase :
// c'est ce qui garantit qu'un score calculé sur téléphone est identique au score
// calculé sur PC. Toute règle de comptage se modifie ici, et nulle part ailleurs.

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

/* Présence multi-appareils.
   /status/{uid} contient une entrée par session ouverte (PC, téléphone, second
   onglet), chacune effacée par son propre onDisconnect. Une seule fiche par
   joueur ne marchait pas : fermer le téléphone effaçait le nœud entier et le
   PC, toujours connecté, passait pour absent.
   Pendant le déploiement, les clients encore sur l'ancienne version écrivent
   une fiche à plat : les deux formes doivent se lire. */
function statusIdentity(node) {
    if (!node || typeof node !== 'object') return null;

    // Ancienne forme : les champs sont directement sur le nœud du joueur.
    if (typeof node.name === 'string' || node.avatar || node.photo) return node;

    const sessions = Object.values(node).filter(s => s && typeof s === 'object');
    if (!sessions.length) return null;

    // La session qui porte une photo l'emporte : une seule des deux interfaces
    // l'a parfois enregistrée.
    return sessions.find(s => s.avatar || s.photo) || sessions[0];
}
