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

/* Une priorité de bulletin, ramenée à une liste sûre.
   Firebase ne rend un tableau que si les clés sont 0,1,2… : un bulletin écrit
   à la main (clés arbitraires, ou même une simple chaîne) revient sous une
   forme sur laquelle .forEach() n'existe pas, et l'exception emportait tout
   le rendu — chez TOUS les joueurs, pas seulement chez l'auteur. On normalise
   donc au lieu de faire confiance.

   Le plafond reprend celui qu'imposent les règles Firebase — les clés d'une
   priorité y sont limitées à deux chiffres, donc à cent entrées. Le tenir
   identique des deux côtés évite qu'un bulletin légitime soit tronqué ici en
   silence : c'est la règle qui refuse, visiblement, et pas l'affichage qui
   oublie. Sans plafond, chaque entrée de p1 valant cinq points, un bulletin de
   cinq cents titres pèserait cinq cents fois un bulletin honnête. */
const MAX_VOTES_PER_PRIORITY = 100;
const BALLOT_PRIORITIES = ['p1', 'p2', 'p3', 'p_other'];

const voteList = (value) => {
    if (Array.isArray(value)) return value.slice(0, MAX_VOTES_PER_PRIORITY);
    if (value && typeof value === 'object') return Object.values(value).slice(0, MAX_VOTES_PER_PRIORITY);
    if (typeof value === 'string' && value) return [value];
    return [];
};
/* Canonical ballot shape shared by desktop, mobile and tests. */
function emptyBallot() {
    return { p1: [], p2: [], p3: [], p_other: [] };
}

function normalizeBallot(value) {
    const source = value || {};
    const ballot = emptyBallot();
    const seen = new Set();
    BALLOT_PRIORITIES.forEach(priority => {
        const limit = priority === 'p1' ? 1 : MAX_VOTES_PER_PRIORITY;
        voteList(source[priority]).forEach(game => {
            if (ballot[priority].length >= limit) return;
            const clean = String(game || '').trim().replace(/\s+/g, ' ');
            const key = normalizeGameName(clean);
            if (!key || seen.has(key)) return;
            seen.add(key);
            ballot[priority].push(clean);
        });
    });
    return ballot;
}

function ballotCount(value) {
    const ballot = normalizeBallot(value);
    return BALLOT_PRIORITIES.reduce((sum, priority) => sum + ballot[priority].length, 0);
}

function ballotFingerprint(value) {
    const ballot = normalizeBallot(value);
    return JSON.stringify(BALLOT_PRIORITIES.map(priority => ballot[priority].map(normalizeGameName)));
}

function activeVoteRoundId(settings) {
    const explicit = settings && settings.voteRoundId;
    return (typeof explicit === 'string' && explicit) ? explicit : 'legacy-current';
}

function createVoteRoundId(now) {
    const stamp = Number(now) || Date.now();
    const random = Math.random().toString(36).slice(2, 10);
    return `round-${stamp.toString(36)}-${random}`;
}

function voteHistoryKey(roundId) {
    return String(roundId || 'legacy-current').replace(/[.#$\[\]\/]/g, '-').slice(0, 120) || 'legacy-current';
}

function ballotRecordForRound(record, settings) {
    if (!record || typeof record !== 'object') return null;
    const expected = activeVoteRoundId(settings);
    if (!record.roundId) return settings && settings.voteRoundId ? null : record;
    return record.roundId === expected ? record : null;
}

function ballotRevision(record) {
    return Math.max(0, Math.floor(Number(record && record.revision) || 0));
}

function voterIds(votes, settings) {
    return Object.entries(votes || {})
        .filter(([, record]) => {
            const current = ballotRecordForRound(record, settings);
            return current && ballotCount(current.votes) > 0;
        })
        .map(([uid]) => uid);
}

/* Compare-and-set for a whole ballot. A stale device aborts instead of silently
   replacing a newer PC/mobile submission. */
function saveBallotWithRevision(ref, options) {
    const opts = options || {};
    const roundId = String(opts.roundId || 'legacy-current');
    const draft = normalizeBallot(opts.votes);
    const count = ballotCount(draft);
    const expectedRevision = Math.max(0, Math.floor(Number(opts.baseRevision) || 0));
    let conflict = null;
    return new Promise((resolve, reject) => {
        ref.transaction(current => {
            conflict = null;
            const currentRecord = current && typeof current === 'object' ? current : null;
            const currentRound = currentRecord && currentRecord.roundId ? String(currentRecord.roundId) : roundId;
            const currentRevision = ballotRevision(currentRecord);
            if (currentRound !== roundId || (!opts.force && currentRevision !== expectedRevision)) {
                conflict = currentRecord;
                return;
            }
            if (count === 0) return null;
            return {
                name: String(opts.name || 'Joueur').trim().slice(0, 100) || 'Joueur',
                votes: draft,
                roundId: roundId,
                revision: currentRevision + 1,
                updatedAt: opts.serverTimestamp == null ? Date.now() : opts.serverTimestamp,
                updatedByDevice: opts.device === 'mobile' ? 'mobile' : 'desktop'
            };
        }, (error, committed, snapshot) => {
            if (error) return reject(error);
            if (!committed) return resolve({ ok: false, conflict: conflict });
            resolve({ ok: true, record: snapshot ? snapshot.val() : null });
        }, false);
    });
}

function newLanResetUpdates(newRoundId, newName) {
    const updates = {
        votes: null,
        events: null,
        'cocktails/oneshot': null,
        'cocktails/orders': null,
        polls: null,
        foodRuns: null,
        steamLibraries: null,
        installed: null,
        'economy/ledger': null,
        'economy/ticks': null,
        'economy/purchases': null,
        'economy/duels': null,
        claims: null,
        'settings/isVotingOpen': true,
        'settings/isLanActive': false,
        'settings/lanFinished': false,
        'settings/lanClosedAt': null,
        'settings/voteRoundId': newRoundId
    };
    if (newName) updates['settings/lanName'] = newName;
    return updates;
}

async function archiveAndResetLan(db, roundId, historyEntry, resetUpdates) {
    const historyRef = db.ref('lan/history/' + voteHistoryKey(roundId));
    await historyRef.transaction(current => current || historyEntry);
    await db.ref('lan').update(resetUpdates);
}

// N'accepte qu'une URL http(s) avant de la poser sur un href/src. Les URL de
// liens nous viennent d'API tierces (ITAD, Wikipédia) : si l'une d'elles était
// compromise, un `javascript:` posé sur un href s'exécuterait au clic. Toute
// URL non http(s) est remplacée par un « # » inerte.
const safeHttpUrl = (url, fallback = '#') => {
    if (typeof url !== 'string') return fallback;
    try {
        const parsed = new URL(url, window.location.origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : fallback;
    } catch (_e) {
        return fallback;
    }
};

/* Un avatar vient de la base, donc d'un autre joueur : c'est une URL qu'il
   choisit et que le navigateur de TOUS les autres ira chercher. Laissée libre,
   elle devient un mouchard — un compte compromis relèverait l'adresse IP de
   tout le groupe à chaque affichage de la liste. On n'accepte donc que les
   hôtes qui hébergent réellement des photos de profil, plus nos propres
   vignettes en data: (inertes par nature). Tout le reste retombe sur
   l'avatar généré localement. */
const AVATAR_HOSTS = [
    'lh3.googleusercontent.com', 'lh4.googleusercontent.com',
    'lh5.googleusercontent.com', 'lh6.googleusercontent.com',
    'avatars.steamstatic.com', 'avatars.akamai.steamstatic.com',
    'avatars.cloudflare.steamstatic.com'
];

const safeAvatarUrl = (url, fallback) => {
    if (typeof url !== 'string' || !url) return fallback;
    if (url.slice(0, 11) === 'data:image/') return url;
    try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.origin === window.location.origin) return parsed.href;
        if (parsed.protocol !== 'https:') return fallback;
        return AVATAR_HOSTS.indexOf(parsed.host) !== -1 ? parsed.href : fallback;
    } catch (_e) {
        return fallback;
    }
};

function levenshtein(s1, s2) { s1 = s1.toLowerCase(); s2 = s2.toLowerCase(); const costs = []; for (let i = 0; i <= s1.length; i++) { let lastValue = i; for (let j = 0; j <= s2.length; j++) { if (i === 0) costs[j] = j; else if (j > 0) { let newValue = costs[j - 1]; if (s1.charAt(i - 1) !== s2.charAt(j - 1)) newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1; costs[j - 1] = lastValue; lastValue = newValue; } } if (i > 0) costs[s2.length] = lastValue; } return costs[s2.length]; }

function checkTypos(newGames, currentVotes) {
    const suggestions = [];
    const masterGameList = new Set();
    Object.values(currentVotes).forEach(voteData => {
        if (voteData && voteData.votes) Object.values(voteData.votes).forEach(games => voteList(games).forEach(game => masterGameList.add(normalizeGameName(game))));
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

/* Le dernier bulletin qu'un joueur a déposé lors d'une LAN archivée.
   Chaque entrée d'historique garde le instantané complet des votes : on peut
   donc reproposer à quelqu'un ce qu'il avait choisi la dernière fois, plutôt
   que de lui faire retaper huit titres. On rend le plus récent qui contienne
   vraiment quelque chose — une LAN où il n'a pas voté ne l'intéresse pas. */
function lastBallotFor(history, uid) {
    if (!uid) return null;
    const entries = Object.values(history || {})
        .filter(Boolean)
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

    for (const entry of entries) {
        const mine = ((entry.votes || {})[uid] || {}).votes;
        if (!mine) continue;
        const ballot = {};
        let total = 0;
        BALLOT_PRIORITIES.forEach(key => {
            ballot[key] = voteList(mine[key]);
            total += ballot[key].length;
        });
        if (total > 0) {
            return { name: entry.name || 'LAN précédente', date: entry.date || '', votes: ballot, count: total };
        }
    }
    return null;
}

function calculateScores(votes) {
    const gameScores = {};
    const displayNames = {}; // garde la "vraie" casse du nom (ex: "PUBG" et pas "Pubg")
    const upperCount = (s) => (s.match(/[A-Z]/g) || []).length;
    const pointsMapping = { p1: 5, p2: 3, p3: 2, p_other: 1 };
    for (const userId in votes) {
        const voteData = votes[userId];
        if (voteData && voteData.votes) {
            const ballot = normalizeBallot(voteData.votes);
            BALLOT_PRIORITIES.forEach(priority => {
                const points = pointsMapping[priority];
                voteList(ballot[priority]).forEach(game => {
                    const normalizedGame = normalizeGameName(game);
                    if (normalizedGame) {
                        gameScores[normalizedGame] = (gameScores[normalizedGame] || 0) + points;
                        const candidate = String(game).trim().replace(/\s+/g, ' ');
                        const current = displayNames[normalizedGame];
                        if (!current || upperCount(candidate) > upperCount(current)) {
                            displayNames[normalizedGame] = candidate;
                        }
                    }
                });
            });
        }    }

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

/* Qui figure dans la bande de présence : les connectés, ceux qui ont voté pour
   cette soirée, et ceux qu'on a simplement vus récemment.

   Ce dernier cas manquait. Un joueur passé dans la journée sans voter n'était
   ni dans /status (il s'efface en partant) ni dans les votes : il disparaissait
   de la bande, alors qu'il apparaissait bien dans les listes de l'économie, qui
   ne filtrent rien. Sa fiche `lan/users/{uid}` porte pourtant un `lastSeen`,
   réécrit à chaque connexion depuis les deux interfaces. */
const ROSTER_SEEN_MS = 7 * 24 * 60 * 60 * 1000;

function isRostered(uid, sources, now) {
    const data = sources || {};
    if (statusIdentity((data.status || {})[uid])) return true;
    if ((data.votes || {})[uid]) return true;
    const profile = (data.profiles || {})[uid];
    const seen = Number(profile && profile.lastSeen) || 0;
    return seen > 0 && (now || Date.now()) - seen < ROSTER_SEEN_MS;
}

/* ==========================================================================
   AGENDA
   Quand a lieu la LAN, et à quelle journée appartient chaque événement.
   Comme le reste de ce fichier : aucun DOM, aucun Firebase, pour que le
   programme se lise à l'identique sur PC et sur téléphone.
   ========================================================================== */

/* Une LAN déborde sur la nuit. Un événement annoncé à 01:00 se joue dans la
   nuit qui prolonge la soirée : il doit fermer le programme du samedi, pas
   ouvrir celui du dimanche. Tout ce qui commence avant 6 h appartient donc
   encore à la journée précédente. */
const DAY_START_HOUR = 6;

// "YYYY-MM-DD" → Date locale à minuit. On passe par le constructeur numérique :
// new Date("2026-09-12") est lu en UTC et recule d'un jour à l'ouest de Greenwich.
function parseDayKey(dayKey) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || '').trim());
    if (!parts) return null;
    const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    return isNaN(date.getTime()) ? null : date;
}

function toDayKey(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "HH:MM" → minutes depuis minuit, ou null si l'heure est absente ou illisible.
function parseClock(time) {
    const parts = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
    if (!parts) return null;
    const hours = Number(parts[1]);
    const minutes = Number(parts[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

// Minutes comptées depuis 6 h du matin : ordonne une soirée qui passe minuit
// sans la couper en deux.
function nightMinutes(time) {
    const minutes = parseClock(time);
    if (minutes === null) return null;
    return minutes < DAY_START_HOUR * 60 ? minutes + 24 * 60 : minutes;
}

// Journée de programme en cours : avant 6 h, on est encore « hier soir ».
function currentDayKey(now) {
    const reference = now instanceof Date ? new Date(now.getTime()) : new Date();
    if (reference.getHours() < DAY_START_HOUR) reference.setDate(reference.getDate() - 1);
    return toDayKey(reference);
}

function shiftDayKey(dayKey, days) {
    const date = parseDayKey(dayKey);
    if (!date) return '';
    date.setDate(date.getDate() + days);
    return toDayKey(date);
}

// Nombre de jours calendaires entre deux journées de programme.
function dayKeyDistance(fromKey, toKey) {
    const from = parseDayKey(fromKey);
    const to = parseDayKey(toKey);
    if (!from || !to) return null;
    return Math.round((to.getTime() - from.getTime()) / 86400000);
}

/* Journée d'un événement : la sienne si elle est renseignée, sinon celle de la
   LAN. Les événements créés au fil de la soirée n'en portent pas, et tombent
   ainsi naturellement le jour de la LAN. */
function eventDayKey(evt, fallbackDayKey) {
    if (evt && parseDayKey(evt.date)) return String(evt.date).trim();
    return fallbackDayKey || '';
}

/* Programme trié : une liste de journées, chacune avec ses événements dans
   l'ordre où ils se jouent. Un événement sans heure ferme sa journée (il est
   « quelque part dans la soirée »), et ceux dont le jour reste inconnu forment
   un dernier groupe à caler. */
function buildAgenda(eventsData, fallbackDayKey) {
    const days = new Map();

    Object.entries(eventsData || {}).forEach(([id, evt]) => {
        if (!evt || typeof evt !== 'object') return;
        const dayKey = eventDayKey(evt, fallbackDayKey);
        if (!days.has(dayKey)) days.set(dayKey, []);
        days.get(dayKey).push(Object.assign({}, evt, {
            id,
            dayKey,
            order: nightMinutes(evt.time)
        }));
    });

    return Array.from(days.entries())
        .map(([dayKey, events]) => ({
            dayKey,
            events: events.sort((a, b) => {
                if (a.order === null && b.order === null) return (a.createdAt || 0) - (b.createdAt || 0);
                if (a.order === null) return 1;
                if (b.order === null) return -1;
                return a.order - b.order;
            })
        }))
        .sort((a, b) => {
            // Le groupe sans date ferme le programme.
            if (!a.dayKey) return 1;
            if (!b.dayKey) return -1;
            return a.dayKey < b.dayKey ? -1 : 1;
        });
}

// Tous les événements dans l'ordre du programme, journées confondues.
function flattenAgenda(agenda) {
    return (agenda || []).reduce((all, day) => all.concat(day.events), []);
}

/* Le prochain événement au sens de qui regarde l'écran : celui qui n'a pas
   encore commencé aujourd'hui, sinon le premier des jours suivants. Renvoie
   null quand tout est passé. */
function nowNightMinutes(now) {
    const reference = now instanceof Date ? now : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return nightMinutes(`${pad(reference.getHours())}:${pad(reference.getMinutes())}`);
}

/* Un événement est passé quand sa journée l'est, ou quand son heure est
   dépassée aujourd'hui. Sans date connue on ne présume rien : il reste au
   programme plutôt que de disparaître silencieusement. */
function isEventPast(evt, now) {
    const reference = now instanceof Date ? now : new Date();
    const dayKey = (evt && evt.dayKey) || '';
    const distance = dayKey ? dayKeyDistance(currentDayKey(reference), dayKey) : null;
    if (distance === null) return false;
    if (distance !== 0) return distance < 0;
    const order = evt.order !== undefined ? evt.order : nightMinutes(evt.time);
    return order !== null && order < nowNightMinutes(reference);
}

function nextEventInAgenda(agenda, now) {
    const reference = now instanceof Date ? now : new Date();
    const today = currentDayKey(reference);
    const nowMinutes = nowNightMinutes(reference);

    for (const day of (agenda || [])) {
        // Sans date, impossible de dire si c'est passé : on ne l'annonce pas.
        if (!day.dayKey) continue;
        const distance = dayKeyDistance(today, day.dayKey);
        if (distance === null || distance < 0) continue;
        for (const evt of day.events) {
            if (distance > 0) return evt;
            if (evt.order !== null && evt.order >= nowMinutes) return evt;
        }
    }
    return null;
}

function formatDayLabel(dayKey, now) {
    const date = parseDayKey(dayKey);
    if (!date) return 'Sans date';

    const distance = dayKeyDistance(currentDayKey(now), dayKey);
    const label = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const capitalized = label.charAt(0).toUpperCase() + label.slice(1);

    if (distance === 0) return `Aujourd'hui · ${capitalized}`;
    if (distance === 1) return `Demain · ${capitalized}`;
    if (distance === -1) return `Hier · ${capitalized}`;
    return capitalized;
}

/* Début de la LAN, heure comprise. Sans heure annoncée on part de 18 h : une
   LAN ne commence pas à minuit, et un compte à rebours calé sur 00:00
   annoncerait la soirée avec presque un jour d'avance. */
const DEFAULT_LAN_HOUR = 18;

function lanStartDate(settings) {
    const date = parseDayKey(settings && settings.lanDate);
    if (!date) return null;
    const minutes = parseClock(settings && settings.lanStartTime);
    if (minutes === null) date.setHours(DEFAULT_LAN_HOUR, 0, 0, 0);
    else date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return date;
}

/* Résumé « quand & où » prêt à afficher. Renvoie null tant que l'admin n'a
   rien renseigné : l'interface masque alors le bandeau au lieu d'afficher un
   cadre vide. */
function describeLanSchedule(settings, now) {
    const config = settings || {};
    const reference = now instanceof Date ? now : new Date();

    const startKey = parseDayKey(config.lanDate) ? String(config.lanDate).trim() : '';
    const endKey = parseDayKey(config.lanEndDate) ? String(config.lanEndDate).trim() : '';
    const place = typeof config.lanPlace === 'string' ? config.lanPlace.trim() : '';
    const startTime = parseClock(config.lanStartTime) !== null ? String(config.lanStartTime).trim() : '';

    if (!startKey && !place) return null;

    const start = parseDayKey(startKey);
    const end = parseDayKey(endKey);
    // Une date de fin antérieure au début est une faute de saisie : on l'ignore
    // plutôt que d'afficher « du 13 au 12 ».
    const hasSpan = !!(start && end && endKey > startKey);

    let when = '';
    if (start && hasSpan) {
        const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
        const from = start.toLocaleDateString('fr-FR', sameMonth
            ? { weekday: 'long', day: 'numeric' }
            : { weekday: 'long', day: 'numeric', month: 'long' });
        const to = end.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
        when = `Du ${from} au ${to}`;
    } else if (start) {
        const label = start.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
        when = label.charAt(0).toUpperCase() + label.slice(1);
    }

    const lastKey = hasSpan ? endKey : startKey;
    const distance = startKey ? dayKeyDistance(currentDayKey(reference), startKey) : null;
    const startsAt = lanStartDate(config);

    let countdown = '';
    let state = 'unknown';
    if (distance !== null) {
        const untilEnd = dayKeyDistance(currentDayKey(reference), lastKey);
        if (distance > 1) {
            countdown = `Dans ${distance} jours`;
            state = 'upcoming';
        } else if (distance === 1) {
            countdown = 'Demain';
            state = 'upcoming';
        } else if (distance === 0) {
            const minutesLeft = startsAt ? Math.round((startsAt.getTime() - reference.getTime()) / 60000) : 0;
            if (minutesLeft > 90) {
                countdown = `Aujourd'hui, dans ${Math.round(minutesLeft / 60)} h`;
                state = 'today';
            } else if (minutesLeft > 0) {
                countdown = `Aujourd'hui, dans ${minutesLeft} min`;
                state = 'today';
            } else {
                // L'heure annoncée est passée : « dans -3 h » n'aurait aucun sens.
                countdown = 'En cours';
                state = 'live';
            }
        } else if (untilEnd !== null && untilEnd >= 0) {
            countdown = 'En cours';
            state = 'live';
        } else {
            countdown = 'Terminée';
            state = 'past';
        }
    }

    return {
        when,
        time: startTime,
        place,
        countdown,
        state,
        startKey,
        endKey: hasSpan ? endKey : '',
        startsAt
    };
}

/* Fichier .ics de la LAN, pour la poser dans son propre agenda. Sans heure
   annoncée on émet une « journée entière » : c'est ce que l'agenda attend
   quand seule la date est connue. */
function icsEscape(text) {
    return String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}

function icsDateTime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}

/* Tous les exports d'agenda partent du même objet. Ainsi Google, Outlook,
   Yahoo et le fichier .ics ne peuvent pas diverger sur la durée ou sur la
   règle « date de fin exclusive » des journées entières. */
function buildLanCalendarEvent(settings) {
    const config = settings || {};
    const schedule = describeLanSchedule(config, new Date());
    if (!schedule || !schedule.startKey) return null;

    const title = String(config.lanName || 'LAN Demain').trim() || 'LAN Demain';
    const description = 'Retrouve les informations et le programme sur LAN Demain.';
    const allDay = !(schedule.time && schedule.startsAt);
    const event = {
        title,
        description,
        location: schedule.place,
        allDay,
        startKey: schedule.startKey,
        endKey: schedule.endKey || schedule.startKey,
        start: null,
        end: null
    };

    if (allDay) {
        event.exclusiveEndKey = shiftDayKey(event.endKey, 1);
    } else {
        event.start = new Date(schedule.startsAt.getTime());
        // L'admin annonce une date de fin, mais pas son heure. On place donc
        // la fin six heures après l'heure de départ SUR LE DERNIER JOUR : une
        // LAN du 28 au 30 reste bien un événement du 28 au 30, à 14 h–20 h.
        const finalDay = parseDayKey(event.endKey);
        finalDay.setHours(event.start.getHours(), event.start.getMinutes(), 0, 0);
        event.end = new Date(finalDay.getTime() + (6 * 60 * 60 * 1000));
    }

    return event;
}

function compactCalendarDay(dayKey) {
    return String(dayKey || '').replace(/-/g, '');
}

function utcCalendarDateTime(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function calendarUrl(base, params) {
    const url = new URL(base);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, String(value));
    });
    return url.toString();
}

/* Liens de composition : rien n'est écrit sans l'accord du joueur. Chaque
   fournisseur ouvre un événement prérempli que l'utilisateur peut encore
   relire, modifier puis enregistrer dans son propre agenda. */
function buildLanCalendarLinks(settings) {
    const event = buildLanCalendarEvent(settings);
    if (!event) return null;

    const start = event.allDay ? compactCalendarDay(event.startKey) : utcCalendarDateTime(event.start);
    const end = event.allDay ? compactCalendarDay(event.exclusiveEndKey) : utcCalendarDateTime(event.end);
    const outlookStart = event.allDay ? event.startKey : event.start.toISOString();
    const outlookEnd = event.allDay ? event.exclusiveEndKey : event.end.toISOString();

    return {
        google: calendarUrl('https://calendar.google.com/calendar/render', {
            action: 'TEMPLATE',
            text: event.title,
            dates: `${start}/${end}`,
            details: event.description,
            location: event.location
        }),
        outlook: calendarUrl('https://outlook.live.com/calendar/0/deeplink/compose', {
            path: '/calendar/action/compose',
            rru: 'addevent',
            subject: event.title,
            startdt: outlookStart,
            enddt: outlookEnd,
            allday: event.allDay ? 'true' : 'false',
            body: event.description,
            location: event.location
        }),
        yahoo: calendarUrl('https://calendar.yahoo.com/', {
            v: '60',
            view: 'd',
            type: '20',
            title: event.title,
            st: start,
            et: end,
            dur: event.allDay ? 'allday' : '',
            desc: event.description,
            in_loc: event.location
        })
    };
}

function buildLanIcs(settings) {
    const event = buildLanCalendarEvent(settings);
    if (!event) return null;

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//LAN Demain//Programme//FR',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:lan-${event.startKey}-${Math.random().toString(36).slice(2, 10)}@lan-demain`,
        `DTSTAMP:${icsDateTime(new Date())}`,
        `SUMMARY:${icsEscape(event.title)}`,
        `DESCRIPTION:${icsEscape(event.description)}`
    ];

    if (!event.allDay) {
        lines.push(`DTSTART:${icsDateTime(event.start)}`);
        lines.push(`DTEND:${icsDateTime(event.end)}`);
    } else {
        lines.push(`DTSTART;VALUE=DATE:${compactCalendarDay(event.startKey)}`);
        lines.push(`DTEND;VALUE=DATE:${compactCalendarDay(event.exclusiveEndKey)}`);
    }

    if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
    lines.push('END:VEVENT', 'END:VCALENDAR');

    // Le format impose des fins de ligne CRLF.
    return lines.join('\r\n') + '\r\n';
}

/* ==========================================================================
   Économie de la soirée : points, boutique, achats
   Aucun solde n'est stocké. Un solde est toujours recalculé à partir du
   registre (lan/economy/ledger) et du compteur de présence (lan/economy/ticks).
   C'est ce qui rend la triche structurellement impossible : le registre est en
   écriture unique et réservé aux maîtres du jeu, et le compteur est plafonné
   par les règles Firebase, pas par le client.
   ========================================================================== */

const ECONOMY = {
    /* Un point toutes les dix minutes de présence, pendant la LAN seulement.
       Ce filet n'est pas une stratégie : plafonné à dix heures, il garantit
       juste que celui qui ne court pas après les défis a de quoi dépenser.

       ATTENTION : ces deux nombres sont aussi écrits en dur dans
       database.rules.json (600000 ms et 60 tranches), parce qu'un fichier de
       règles ne peut ni importer ni commenter. Ce sont les règles qui font
       foi — elles seules empêchent un client bricolé d'accélérer le compteur.
       Changer l'un sans l'autre rend le plafond affiché faux, ou fait échouer
       silencieusement chaque tranche. */
    TICK_INTERVAL_MS: 10 * 60 * 1000,
    TICK_VALUE: 5,
    MAX_TICKS: 60,
    /* Le zloty : « złoty » veut dire « en or » en polonais, et le pluriel qu'on
       lit sur les billets est « złotych ». Un clin d'oeil qui tombe juste — la
       monnaie de la soirée est littéralement de l'or. */
    CURRENCY: 'zł',
    CURRENCY_LONG: 'złotych',
    CATEGORIES: [
        { key: 'privilege', label: 'Privilèges', icon: '👑' },
        /* Les bonus sont l'inverse des handicaps : ceux-là protègent ou
           avantagent CELUI QUI LES ACHÈTE, là où un handicap s'inflige à
           quelqu'un d'autre. Sans eux, la boutique ne savait que nuire. */
        { key: 'boost', label: 'Bonus', icon: '🛡️' },
        { key: 'handicap', label: 'Handicaps', icon: '🎯' },
        { key: 'cosmetic', label: 'Cosmétiques', icon: '✨' },
        { key: 'fun', label: 'Divers', icon: '🎲' }
    ]
};

/* Repères d'équilibrage : la présence rapporte 30 zł par heure et un booster
   standard en coûte 100. Une LAN de dix heures paie donc trois boosters même
   sans courir après les défis ; les défis servent à accélérer ou à acheter
   les privilèges plus chers. */
const BOOSTER_STANDARD_PRICE = 100;

function passivePointsPerHour() {
    return Math.round((60 * 60 * 1000 / ECONOMY.TICK_INTERVAL_MS) * ECONOMY.TICK_VALUE);
}

function categoryLabel(key) {
    const found = ECONOMY.CATEGORIES.find(c => c.key === key);
    return found ? found.label : 'Divers';
}

function categoryIcon(key) {
    const found = ECONOMY.CATEGORIES.find(c => c.key === key);
    return found ? found.icon : '🎲';
}

function formatPoints(value) {
    const n = Math.round(Number(value) || 0);
    return `${n} ${ECONOMY.CURRENCY}`;
}

/* Points gagnés passivement. Le compteur ne retient que le nombre de tranches
   validées par les règles : le client ne choisit jamais leur valeur. */
function tickPoints(economy, uid) {
    const node = (economy && economy.ticks && economy.ticks[uid]) || null;
    if (!node) return 0;
    const count = Math.max(0, Math.min(Number(node.count) || 0, ECONOMY.MAX_TICKS));
    return count * ECONOMY.TICK_VALUE;
}

/* Les mouvements crédités par un maître du jeu (dons, défis relevés).
   Les lignes de type « purchase » sont volontairement ignorées ici : elles
   sont signées par le joueur lui-même, et rien dans les règles Firebase ne
   peut exiger qu'il en écrive une en même temps que son achat. On compte donc
   la dépense sur le nœud `purchases`, qui est le seul que le joueur DOIT
   écrire pour recevoir son article. */
function ledgerTotal(economy, uid) {
    const ledger = (economy && economy.ledger) || {};
    let total = 0;
    Object.values(ledger).forEach(entry => {
        if (entry && entry.uid === uid && entry.type !== 'purchase') total += Number(entry.delta) || 0;
    });
    return total;
}

/* Ce qui a été effectivement dépensé : la somme des achats accordés. C'est le
   débit qui fait foi, parce qu'il est adossé à l'article reçu. */
function grantedSpend(economy, uid) {
    const purchases = (economy && economy.purchases) || {};
    let total = 0;
    Object.values(purchases).forEach(p => {
        if (p && p.uid === uid && p.status === 'granted') total += Math.abs(Number(p.price) || 0);
    });
    return total;
}

/* Le solde qui fait foi : crédits + présence − achats accordés. */
function economyBalance(economy, uid) {
    if (!uid) return 0;
    return ledgerTotal(economy, uid) + tickPoints(economy, uid) - grantedSpend(economy, uid);
}

/* Ce qui est déjà engagé dans des achats non tranchés. Un achat ne débite
   qu'une fois validé par le maître du jeu, sinon un refus laisserait le joueur
   débité ; en attendant, la somme reste réservée pour qu'il ne la dépense pas
   deux fois. */
function pendingSpend(economy, uid) {
    const purchases = (economy && economy.purchases) || {};
    let total = 0;
    Object.values(purchases).forEach(p => {
        if (p && p.uid === uid && p.status === 'pending') total += Number(p.price) || 0;
    });
    return total;
}

/* Ce que le joueur peut réellement engager maintenant. */
function availablePoints(economy, uid) {
    return economyBalance(economy, uid) - pendingSpend(economy, uid) - duelReservedSpend(economy, uid);
}

/* Une mise n'est débitée qu'au verdict, mais elle cesse d'être disponible dès
   que le duel l'engage. Avant acceptation seul le défiant réserve sa mise ;
   après acceptation, les deux joueurs la réservent. */
function duelReservedSpend(economy, uid) {
    const duels = (economy && economy.duels) || {};
    let total = 0;
    Object.values(duels).forEach(duel => {
        if (!duel || !uid) return;
        const wager = Math.max(0, Number(duel.wager) || 0);
        if (duel.status === 'pending' && duel.challengerUid === uid) total += wager;
        if (duel.status === 'accepted'
            && (duel.challengerUid === uid || duel.opponentUid === uid)) total += wager;
    });
    return total;
}

function economyDuels(economy) {
    return Object.entries((economy && economy.duels) || {})
        .map(([id, duel]) => Object.assign({ id: id }, duel))
        .filter(duel => duel && duel.challengerUid && duel.opponentUid)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/* Les bonus et handicaps achetés deviennent des jetons. Leur reçu d'achat est
   aussi leur certificat : pas de second nœud forgeable, et une source unique
   pour le prix, le propriétaire et l'état du jeton. */
function isInventoryCatalogItem(item) {
    return !!item && (item.storable === true
        || item.category === 'boost' || item.category === 'handicap');
}

function inventoryItems(economy, uid) {
    const catalog = (economy && economy.catalog) || {};
    return Object.entries((economy && economy.purchases) || {})
        .map(([id, purchase]) => {
            const snapshot = {
                name: purchase && purchase.itemName,
                description: purchase && purchase.itemDescription,
                category: purchase && purchase.itemCategory,
                storable: purchase && purchase.storable
            };
            const item = Object.assign(snapshot, catalog[purchase && purchase.itemId] || {});
            return Object.assign({ id: id, catalogItem: item }, purchase || {});
        })
        .filter(token => token.status === 'granted'
            && token.inventoryStatus === 'ready'
            && token.inventoryOwnerUid === uid
            && isInventoryCatalogItem(token.catalogItem))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/* Un article épuisé ne se commande plus. Les achats refusés ne consomment pas
   de stock : seuls ceux qui tiennent encore comptent. */
function itemStockLeft(economy, itemId, item) {
    const stock = Number(item && item.stock);
    if (!Number.isFinite(stock) || stock <= 0) return null; // illimité
    const purchases = (economy && economy.purchases) || {};
    const taken = Object.values(purchases).filter(p =>
        p && p.itemId === itemId && (p.status === 'pending' || p.status === 'granted')).length;
    return Math.max(0, stock - taken);
}

function canBuy(economy, uid, itemId, item) {
    if (!item || item.active === false) return { ok: false, why: 'Article retiré de la boutique.' };
    const left = itemStockLeft(economy, itemId, item);
    if (left === 0) return { ok: false, why: 'Épuisé.' };
    const price = Number(item.price) || 0;
    if (availablePoints(economy, uid) < price) return { ok: false, why: 'Pas assez de points.' };
    return { ok: true, why: '' };
}

/* Le registre, du plus récent au plus ancien. */
function economyFeed(economy, limit) {
    const ledger = (economy && economy.ledger) || {};
    const rows = Object.entries(ledger)
        .map(([id, entry]) => Object.assign({ id }, entry))
        .filter(entry => entry && entry.uid)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return limit ? rows.slice(0, limit) : rows;
}

/* Classement des fortunes. On ne montre que les joueurs qui ont bougé : une
   liste de zéros n'apprend rien. */
function economyLeaderboard(economy, uids) {
    return (uids || [])
        .map(uid => ({ uid, balance: economyBalance(economy, uid) }))
        .filter(row => row.balance !== 0)
        .sort((a, b) => b.balance - a.balance);
}

function pendingPurchases(economy) {
    const purchases = (economy && economy.purchases) || {};
    return Object.entries(purchases)
        .map(([id, p]) => Object.assign({ id }, p))
        .filter(p => p.status === 'pending')
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/* Un rôle qui peut créditer, valider un achat et tenir la boutique. L'admin
   l'est toujours : il ne faut pas qu'une soirée se bloque parce que le maître
   du jeu est parti dormir. */
function isGamemaster(role, uid, adminUid) {
    return role === 'admin' || role === 'gamemaster' || uid === adminUid;
}

/* ==========================================================================
   LES CARTES DE LA SOIRÉE
   Un jeu de collection dont le set est frappé par le vote : les jeux que les
   joueurs ont demandés deviennent les cartes, et leur rareté est leur score.
   La rareté ne raconte donc pas une invention, elle raconte la soirée.

   Trois principes, hérités de l'économie :

   1. Aucune collection n'est stockée. Elle est REJOUÉE depuis les paquets
      ouverts et les échanges acceptés. Un inventaire modifiable serait un
      inventaire qu'on se fabrique.
   2. Le contenu d'un paquet n'est pas stocké non plus : il se recalcule à
      partir de son sceau. Le sceau, c'est l'horodatage écrit par le serveur
      Firebase à l'achat — la seule valeur de cette application que le client
      ne choisit pas. Le tirage est donc à la fois imprévisible (personne ne
      connaît la milliseconde du serveur) et vérifiable (tout le monde
      recalcule le même paquet). Pas de serveur de tirage à écrire.
   3. Un échange malhonnête n'est pas refusé, il est SANS EFFET. Les règles
      Firebase ne savent pas vérifier qui possède quoi ; le rejeu, si. Ce qui
      compte n'est pas ce qu'on écrit, c'est l'interprétation — et
      l'interprétation est déterministe, partagée et publique.
   ========================================================================== */

/* Les proportions, la composition du booster et le traitement brillant sont
   calqués sur Riftbound (le JCC League of Legends de Riot). Son set Origins
   compte 353 cartes réparties en 89 communes, 84 peu communes, 84 rares,
   42 épiques et 54 prestige, et son booster de 14 cartes tient en sept
   communes, trois peu communes, trois emplacements brillants et un jeton.
   On reprend la structure telle quelle : elle est éprouvée, et elle a le bon
   goût de garantir du brillant à chaque ouverture. */
const TCG = {
    /* Quatorze cartes, comme un booster Riftbound. Le quatorzième emplacement
       y est un jeton ; nous n'avons pas de jetons, il devient une commune de
       plus. */
    PACK_SIZE: 14,

    /* La composition, emplacement par emplacement.
       - `flex` : rare par défaut, épique une fois sur quatre, prestige une
         fois sur douze — chez Riftbound l'épique « mange » un emplacement rare.
       - `foil` : n'importe quelle rareté, mais toujours brillante. C'est lui
         qui produit la commune brillante, la petite trouvaille du paquet. */
    PACK_SLOTS: [
        'common', 'common', 'common', 'common', 'common', 'common', 'common', 'common',
        'uncommon', 'uncommon', 'uncommon',
        'flex', 'rare', 'foil'
    ],
    /* La Signature est au-dessus de la Showcase, donc plus rare qu'elle : une
       ouverture sur cinquante. Avec huit cartes seulement dans cette rareté,
       c'est une vraie chasse — et c'est le seul endroit du booster où elle
       peut sortir, avec l'emplacement brillant. */
    FLEX_SIGNATURE: 0.02,
    FLEX_SHOWCASE: 0.08,
    FLEX_EPIC: 0.25,
    /* L'emplacement brillant penche vers le bas du set : sa surprise est
       qu'une commune sorte holographique, pas qu'elle sorte signature. */
    FOIL_SLOT_WEIGHTS: { common: 60, uncommon: 25, rare: 10, epic: 4, showcase: 1, signature: 0.3 },

    /* Filet de consolation : une prestige garantie au bout de N paquets
       ouverts sans. Riftbound n'en a pas ; entre amis, une longue série sèche
       fait juste décrocher. */
    PITY: 8,
    /* Plafond par côté d'un échange. Six cartes tiennent sur un écran de
       téléphone, et une proposition qu'on ne lit pas ne s'accepte pas. */
    TRADE_MAX: 6,

    /* Ce qui décide de la rareté d'un jeu (voir cardWeight). Le terrain commun
       et l'envie pèsent pareil à plein régime : un jeu que TOUT le groupe
       possède vaut un jeu choisi en premier par un joueur (5 points de vote). */
    OWNERSHIP_WEIGHT: 10,
    VOTE_WEIGHT: 2,

    /* Combien de cartes reçoivent une illustration dessinée pour elles. C'est
       le sommet du set : les jeux que tout le groupe possède et réclame. Huit,
       parce que c'est le nombre qu'on peut faire générer à chaque nouveau set
       sans que ça pèse (moins d'un euro), et que huit cartes de chasse restent
       une chasse — au-delà, ça devient un catalogue.
       Les illustrations sont mises en cache par jeu : une signature déjà
       dessinée lors d'une soirée précédente ne se regénère pas. */
    SIGNATURE_COUNT: 8,
    /* Une extension physique classique reste assez petite pour que compléter
       le set ait un sens. Les bibliothèques du groupe peuvent dépasser huit
       cents jeux : seuls les mieux classés entrent donc dans le set. */
    SET_SIZE: 236,

    /* Les noms sont ceux de Riftbound, parce que c'est le vocabulaire du
       groupe. `share` est la part du set — sauf pour la signature, dont le
       nombre est fixe (SIGNATURE_COUNT) : on n'illustre pas un pourcentage,
       on illustre un nombre de cartes.

       Les parts sont le seul endroit où l'on s'écarte d'Origins, et pour une
       bonne raison. Chez Riftbound elles sont presque plates (15 % de
       showcase) parce qu'un set y est DESSINÉ, et que ses showcases sont des
       versions alternatives de cartes existantes. Notre set, lui, est un
       relevé : sur cinq cents jeux de bibliothèques, une quinzaine à peine
       sont réellement partagés par le groupe. Garder 15 % remplirait la rareté
       la plus haute de jeux que personne n'a en commun.

       D'où une pyramide franche. La composition du booster, elle, reste
       exactement celle de Riftbound : c'est elle qui donne la sensation. */
    RARITIES: [
        { key: 'signature', label: 'Signature', short: 'SIG', share: 0 },
        { key: 'showcase',  label: 'Showcase',  short: 'SHO', share: 0.02 },
        { key: 'epic',      label: 'Epic',      short: 'EPC', share: 0.04 },
        { key: 'rare',      label: 'Rare',      short: 'RAR', share: 0.10 },
        { key: 'uncommon',  label: 'Uncommon',  short: 'UNC', share: 0.24 },
        { key: 'common',    label: 'Common',    short: 'COM', share: 0.60 }
    ],

    /* Chez Riftbound, toute rare et au-dessus est brillante d'office. Le
       brillant n'est donc pas une rareté de plus : c'est ce qui distingue le
       haut du set, plus la trouvaille de l'emplacement brillant. */
    ALWAYS_FOIL_FROM: 'rare',

    /* Illustrations dessinées, quand il y en aura. Tant qu'un jeu n'est pas
       listé ici, sa carte porte sa jaquette Steam (api/get-game-image) : le
       set est illustré dès le premier soir, et se bonifie carte par carte.
       Clé = cardKey(nom), valeur = fichier dans cards/. */
    ART: {}
};

function rarityIndex(key) {
    const found = TCG.RARITIES.findIndex(r => r.key === key);
    return found < 0 ? TCG.RARITIES.length - 1 : found;
}

function rarityMeta(key) {
    return TCG.RARITIES[rarityIndex(key)];
}

/* L'identité d'une carte, et la clé Firebase de son nœud dans le set.
   Une clé Firebase ne supporte ni « . » ni « $ # [ ] / » : « S.T.A.L.K.E.R. »
   passé tel quel rendrait le chemin invalide et la frappe du set échouerait
   sans le moindre message. On part de normalizeGameName pour que deux
   orthographes du même jeu restent une seule carte, puis on neutralise ce qui
   gênerait le chemin. */
function cardKey(name) {
    const normalized = normalizeGameName(name).replace(/[.$#[\]/]/g, '_').trim();
    return normalized;
}

/* L'illustration et le nom du booster lui-même vivent sous la même racine que
   celles des cartes, à une clé réservée. `cardKey()` ne produit jamais de nom
   commençant par un tiret bas — aucune carte ne peut donc la percuter — et
   ça évite d'ajouter un nœud, donc de republier les règles une fois de plus. */
const PACK_ART_KEY = '__booster';

/* Le nom affiché sur l'emballage. Celui que le maître du jeu a choisi, sinon
   celui de la soirée : jamais « Booster de test », qui ne veut rien dire pour
   celui qui l'ouvre. */
function packLabel(packArt, lanName) {
    const chosen = packArt && typeof packArt.name === 'string' && packArt.name.trim();
    if (chosen) return chosen;
    return lanName ? 'Booster ' + lanName : 'Booster';
}

/* Pourquoi cette carte a cette rareté, en une phrase vraie. C'est le gain d'une
   rareté tirée du groupe plutôt qu'inventée : elle s'explique. */
function rarityReason(setCard, set) {
    if (!setCard) return '';
    const owners = Number(setCard.owners) || 0;
    const total = Number(set && set.libraries) || 0;
    const score = Number(setCard.score) || 0;
    const parts = [];

    if (total > 0 && owners >= total && total > 1) {
        parts.push('Tout le monde l\'a (' + owners + ' bibliothèques sur ' + total + ')');
    } else if (owners > 1) {
        parts.push('Possédé par ' + owners + ' joueurs' + (total ? ' sur ' + total : ''));
    } else if (owners === 1) {
        parts.push('Une seule bibliothèque l\'a');
    } else {
        parts.push('Dans aucune bibliothèque liée');
    }

    if (score > 0) parts.push(score + ' point' + (score > 1 ? 's' : '') + ' au vote de la soirée');
    return parts.join(' · ') + '.';
}

/* Chemin de l'illustration dessinée à la main, ou null. */
function cardArt(gameKey) {
    const file = TCG.ART[gameKey];
    return file ? 'cards/' + file : null;
}

/* Où une carte trouve son illustration, dans l'ordre :
     1. un fichier dessiné à la main et commité dans cards/ ;
     2. l'illustration générée pour une Signature (lan/cardArt) ;
     3. la jaquette Steam, déduite de l'appId — sans appel réseau.
   Il n'y a pas de quatrième cas : un jeu dont on ne sait pas montrer
   l'illustration n'entre pas dans le set. */
function cardImage(card, generated) {
    const drawn = cardArt(card && card.gameKey);
    if (drawn) return drawn;
    const made = generated && card && generated[card.gameKey];
    if (made) return made;
    return steamHeaderUrl(card && card.appId);
}

/* Les cartes du set qui méritent une illustration dessinée : les Signature.
   C'est cette liste qu'on envoie au générateur à la création d'un set. */
function signatureCards(setCards) {
    return Object.entries(setCards || {})
        .filter(([, card]) => card && card.rarity === 'signature')
        .map(([gameKey, card]) => ({ gameKey, name: card.name || gameKey }));
}

/* --------------------------------------------------------------------------
   Composer le set
   -------------------------------------------------------------------------- */

/* Tous les jeux que le groupe possède, et COMBIEN de joueurs possèdent chacun.

   Ce compte est le cœur de la rareté du set. Un jeu que personne d'autre n'a
   est banal : il y en a des centaines, chacun n'a que sa propre bibliothèque.
   Un jeu que TOUT LE MONDE possède est rare — et c'est en plus celui auquel on
   peut jouer ce soir sans que personne aille l'acheter. La rareté ne parle donc
   pas du jeu, elle parle du terrain commun. C'est ce qui la rend vraie.

   Le possesseur est le compte Steam, pas le joueur connecté :
   `lan/steamLibraries` est indexé par compte, et c'est ce qui permet d'ajouter
   la bibliothèque d'un ami. */
function knownGames(sources) {
    const games = new Map();
    const libraries = (sources && sources.libraries) || {};

    Object.entries(libraries).forEach(([libraryId, library]) => {
        const list = (library && library.games) || [];
        // Firebase rend parfois un tableau creux sous forme d'objet.
        Object.values(Array.isArray(list) ? list : list).forEach(game => {
            if (!game || !game.name) return;
            const key = cardKey(game.name);
            if (!key) return;
            const known = games.get(key)
                || { key, name: String(game.name).trim().replace(/\s+/g, ' '), owners: new Set(), appId: null };
            known.owners.add(libraryId);
            /* L'appId est ce qui garantit une illustration : la jaquette Steam
               s'en déduit sans le moindre appel réseau. On garde le premier
               rencontré — le catalogue Game Pass, lui, n'en fournit pas. */
            if (!known.appId && game.appId) known.appId = game.appId;
            games.set(key, known);
        });
    });

    return {
        libraries: Object.keys(libraries).length,
        games: Array.from(games.values())
            .map(game => ({ name: game.name, owners: game.owners.size, appId: game.appId }))
    };
}

/* La jaquette Steam est déterministe : un appId suffit, aucun appel d'API et
   aucun cache à tenir. C'est la raison pour laquelle un jeu sans appId n'entre
   pas dans le set — une carte sans illustration n'est pas une carte. */
function steamHeaderUrl(appId) {
    return appId ? 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + appId + '/header.jpg' : null;
}

/* Le poids qui classe une carte, et donc sa rareté. Deux forces, à parts
   égales à plein régime :

   - LE TERRAIN COMMUN : la part du groupe qui possède le jeu, de 0 à 1. Un jeu
     que tout le monde a vaut autant qu'un jeu choisi en premier par un joueur.
   - L'ENVIE : ce que le vote en a dit.

   Elles s'additionnent, donc le jeu que tout le monde possède ET que tout le
   monde réclame est en tête du set. C'est exactement la carte qu'on veut voir
   sortir d'un booster un soir de LAN. */
function cardWeight(score, owners, libraries) {
    const share = libraries > 0 ? Math.min(1, owners / libraries) : 0;
    return share * TCG.OWNERSHIP_WEIGHT + (Number(score) || 0) * TCG.VOTE_WEIGHT;
}

/* Le set de la soirée : tous les jeux du groupe, classés par ce poids, découpés
   selon les parts d'Origins.

   Les ex aequo ne sont PAS regroupés. Avec des centaines de jeux, la plupart
   partagent le même poids (un seul possesseur, aucun vote) : les regrouper
   ferait de tout le bas du set une seule rareté. Ils sont départagés par une
   empreinte de leur nom — stable d'un client à l'autre, mais sans rapport avec
   l'alphabet, sinon toutes les prestiges iraient aux jeux commençant par A. */
function buildCardSet(scores, pool) {
    const source = Array.isArray(pool) ? { games: pool, libraries: 0 } : (pool || {});
    const libraries = Number(source.libraries) || 0;
    /* Les appId retrouvés à part, pour les jeux votés à la main qui ne sont
       dans aucune bibliothèque : sans eux, le jeu que tout le monde réclame
       serait justement celui qui manquerait au set. */
    const extraArt = source.appIds || {};
    const byKey = new Map();

    (source.games || []).forEach(game => {
        if (!game || !game.name) return;
        const key = cardKey(game.name);
        if (!key) return;
        byKey.set(key, {
            key,
            name: String(game.name).trim().replace(/\s+/g, ' '),
            score: 0,
            owners: Math.max(Number(game.owners) || 0, (byKey.get(key) || {}).owners || 0),
            appId: game.appId || null
        });
    });

    (scores || []).forEach(game => {
        if (!game || !game.name) return;
        const key = cardKey(game.name);
        if (!key) return;
        const score = Number(game.score) || 0;
        const known = byKey.get(key);
        if (known) {
            // Le nom voté fait foi : c'est celui que les joueurs ont écrit.
            known.name = String(game.name).trim().replace(/\s+/g, ' ');
            known.score = Math.max(known.score, score);
        } else {
            byKey.set(key, { key, name: String(game.name).trim().replace(/\s+/g, ' '), score, owners: 0, appId: null });
        }
    });

    /* Pas d'illustration, pas de carte. Un jeu dont on ne sait pas montrer la
       jaquette ferait une silhouette grise dans la grille, et une carte grise
       n'a aucune raison d'exister. C'est le cas des entrées Game Pass (sans
       appId) et des jeux mal orthographiés que Steam ne reconnaît pas. */
    byKey.forEach((game, key) => {
        if (!game.appId && extraArt[key]) game.appId = extraArt[key];
        if (!game.appId) byKey.delete(key);
    });

    const ranked = Array.from(byKey.values())
        .map(game => Object.assign(game, { weight: cardWeight(game.score, game.owners, libraries) }))
        .sort((a, b) => b.weight - a.weight
            || tcgHash(a.key) - tcgHash(b.key)
            || (a.key < b.key ? -1 : 1))
        /* Un set n'est pas l'inventaire exhaustif des bibliothèques Steam.
           On garde les jeux les plus représentatifs du groupe : votes et
           propriété partagée pèsent déjà dans le classement ci-dessus. */
        .slice(0, TCG.SET_SIZE);

    const total = ranked.length;
    if (!total) return {};

    /* Les deux raretés de chasse sont RÉSERVÉES aux cartes qui les méritent :
       un jeu partagé par au moins deux joueurs, ou réclamé au vote. Un jeu que
       personne d'autre ne possède et que personne n'a demandé n'y entre pas,
       même s'il reste de la place. Sans cette réserve, les prestiges d'un set
       de cinq cents jeux seraient tirées au hasard et la rareté cesserait de
       dire quoi que ce soit du groupe. `ranked` étant trié par poids
       décroissant, les méritantes sont exactement les premières.

       La réserve s'arrête à « épique », et pas plus bas : le booster garantit
       un emplacement rare à chaque ouverture, et une rareté réduite à deux ou
       trois cartes servirait éternellement les mêmes. Sous l'épique, il n'y a
       de toute façon plus de signal à lire — le bas du set est la longue
       traîne des bibliothèques personnelles, que seule l'empreinte départage. */
    const deserving = ranked.filter(game => game.owners >= 2 || game.score > 0).length;
    const reservedUpTo = rarityIndex('epic');

    const bands = new Array(total);
    let index = 0;

    /* La signature se compte en cartes, pas en pourcentage : c'est le nombre
       d'illustrations qu'on accepte de faire dessiner. Elle prend le sommet du
       classement, et jamais plus que ce que le set mérite. */
    const signatures = Math.min(TCG.SIGNATURE_COUNT, deserving, total);
    while (index < signatures) bands[index++] = 0;

    const rest = total - signatures;
    let cumulative = 0;
    TCG.RARITIES.forEach((rarity, i) => {
        if (i === 0) return;   // la signature est déjà servie
        cumulative += rarity.share;
        const isLast = i === TCG.RARITIES.length - 1;
        /* On réserve une place à chacune des raretés qui suivent : sur un set
           de six jeux, un arrondi naïf laisserait des raretés vides et les
           boosters n'auraient plus rien à tirer. */
        const room = total - (TCG.RARITIES.length - 1 - i);
        let upTo = isLast
            ? total
            : Math.max(index + 1, Math.min(room, signatures + Math.round(rest * cumulative)));
        if (i <= reservedUpTo) upTo = Math.min(upTo, Math.max(index + 1, deserving));
        while (index < upTo) bands[index++] = i;
    });

    const cards = {};
    ranked.forEach((game, i) => {
        cards[game.key] = {
            name: game.name,
            rarity: TCG.RARITIES[bands[i]].key,
            score: game.score,
            // Combien de bibliothèques du groupe l'avaient le jour du set.
            // C'est ce qui explique la rareté quand on retourne la carte.
            owners: game.owners,
            // L'illustration se déduit de l'appId : rien à résoudre ensuite.
            appId: game.appId
        };
    });
    return cards;
}

/* --------------------------------------------------------------------------
   Le tirage
   Déterministe à partir du sceau, donc rejouable par n'importe qui, et
   imprévisible parce que le sceau vient du serveur.
   -------------------------------------------------------------------------- */

// FNV-1a 32 bits : court, sans dépendance, et suffisant pour semer un tirage.
function tcgHash(text) {
    const str = String(text);
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

// mulberry32 : générateur semé, identique sur tous les navigateurs.
function tcgRandom(seed) {
    let state = seed >>> 0;
    return function () {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* Le sceau d'un paquet.
   L'ancienne formule partait de l'identifiant du paquet — or c'est l'acheteur
   qui le choisit. Il pouvait donc calculer hors ligne quel identifiant sortait
   une Signature, puis l'écrire. La formule courante ne garde que des valeurs
   posées par le serveur : `sealedAt` et `openedAt` sont tous deux imposés à
   `now` par les règles Firebase, et ne s'écrivent qu'une fois. L'acheteur ne
   décide plus de rien — seulement de l'instant où il clique, à la milliseconde
   près, sans savoir ce qu'il va tirer.

   La bascule est datée : les paquets scellés avant gardent leur ancienne
   graine, donc leur contenu. Sans ça, changer la formule redistribuerait
   rétroactivement toutes les collections déjà ouvertes. */
const PACK_SEED_V2_FROM = Date.UTC(2026, 7, 24); // 24 août 2026

function packSeed(packId, pack) {
    const sealedAt = (pack && pack.sealedAt) || 0;
    const uid = (pack && pack.uid) || '';
    if (sealedAt >= PACK_SEED_V2_FROM) {
        // openedAt d'abord : c'est lui qui rend le tirage imprévisible.
        // packId reste dans le mélange pour qu'un lot de cinq boosters
        // achetés d'un même clic — donc scellés à la même milliseconde —
        // ne donne pas cinq fois le même paquet.
        return tcgHash(((pack && pack.openedAt) || 0) + '|' + sealedAt + '|' + packId + '|' + uid);
    }
    return tcgHash(packId + '|' + sealedAt + '|' + uid);
}

/* Quatorze cartes tirées du set, emplacement par emplacement, selon la
   composition d'un booster Riftbound (voir TCG.PACK_SLOTS). */
function drawPack(setCards, seed, options) {
    const opts = options || {};
    const pool = {};
    Object.entries(setCards || {}).forEach(([key, card]) => {
        const rarity = rarityMeta(card && card.rarity).key;
        (pool[rarity] = pool[rarity] || []).push(key);
    });
    /* Firebase ne promet pas l'ordre de lecture d'un objet : sans tri, deux
       clients tireraient deux paquets différents avec la même graine. */
    Object.values(pool).forEach(list => list.sort());

    const available = TCG.RARITIES.filter(rarity => (pool[rarity.key] || []).length);
    if (!available.length) return [];

    const rand = tcgRandom(seed);

    /* La rareté demandée, ou la plus proche que le set possède vraiment. Un
       petit set n'a pas forcément d'épiques : mieux vaut servir une rare que
       de rendre un emplacement vide. */
    const nearest = (key) => {
        if ((pool[key] || []).length) return key;
        const wanted = rarityIndex(key);
        let best = available[0];
        available.forEach(rarity => {
            if (Math.abs(rarityIndex(rarity.key) - wanted) < Math.abs(rarityIndex(best.key) - wanted)) best = rarity;
        });
        return best.key;
    };

    const weightedPick = (weights) => {
        const choices = available.filter(rarity => weights[rarity.key]);
        if (!choices.length) return available[available.length - 1].key;
        const totalWeight = choices.reduce((sum, rarity) => sum + weights[rarity.key], 0);
        let roll = rand() * totalWeight;
        for (const rarity of choices) {
            roll -= weights[rarity.key];
            if (roll <= 0) return rarity.key;
        }
        return choices[choices.length - 1].key;
    };

    const alwaysFoil = rarityIndex(TCG.ALWAYS_FOIL_FROM);
    const cards = [];

    TCG.PACK_SLOTS.forEach((slot, index) => {
        // Le dé est jeté à chaque emplacement, quel qu'il soit : c'est ce qui
        // garantit que deux clients rejouent la même suite de tirages.
        const roll = rand();
        let rarity;
        if (slot === 'flex') {
            const showcaseUpTo = TCG.FLEX_SIGNATURE + TCG.FLEX_SHOWCASE;
            if (opts.pity) rarity = nearest('showcase');
            else if (roll < TCG.FLEX_SIGNATURE) rarity = nearest('signature');
            else if (roll < showcaseUpTo) rarity = nearest('showcase');
            else if (roll < showcaseUpTo + TCG.FLEX_EPIC) rarity = nearest('epic');
            else rarity = nearest('rare');
        } else if (slot === 'foil') {
            rarity = weightedPick(TCG.FOIL_SLOT_WEIGHTS);
        } else {
            rarity = nearest(slot);
        }

        const list = pool[rarity];
        const gameKey = list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
        // Rare et au-dessus sortent brillantes d'office, comme chez Riftbound.
        // L'emplacement brillant, lui, l'est quelle que soit sa rareté.
        const foil = slot === 'foil' || rarityIndex(rarity) <= alwaysFoil;
        cards.push({ slot: index, gameKey, rarity, foil });
    });

    return cards;
}

/* --------------------------------------------------------------------------
   Le rejeu de la collection
   -------------------------------------------------------------------------- */

function tcgSetCards(tcg, setId) {
    const node = ((tcg && tcg.sets) || {})[setId];
    return (node && node.cards) || {};
}

function tcgCurrentSetId(tcg) {
    return (tcg && tcg.currentSet) || '';
}

function tcgCurrentSet(tcg) {
    const id = tcgCurrentSetId(tcg);
    const node = ((tcg && tcg.sets) || {})[id];
    return node ? Object.assign({ id }, node) : null;
}

function tcgPacks(tcg) {
    return Object.entries((tcg && tcg.packs) || {})
        .map(([id, pack]) => Object.assign({ id }, pack))
        .filter(pack => pack && pack.uid && pack.sealedAt);
}

function sealedPacksOf(tcg, uid) {
    return tcgPacks(tcg)
        .filter(pack => pack.uid === uid && pack.status !== 'opened')
        .sort((a, b) => (a.sealedAt || 0) - (b.sealedAt || 0));
}

/* Combien de paquets ce joueur a ouverts depuis sa dernière légendaire. Sert
   au filet de consolation, et se recalcule comme tout le reste. */
function pityCount(tcg, uid) {
    let streak = 0;
    openedPacks(tcg).filter(pack => pack.uid === uid).forEach(pack => {
        const drawn = drawPack(tcgSetCards(tcg, pack.setId), packSeed(pack.id, pack), { pity: streak >= TCG.PITY });
        streak = drawn.some(card => rarityIndex(card.rarity) <= rarityIndex('showcase')) ? 0 : streak + 1;
    });
    return streak;
}

/* L'ordre d'ouverture fait foi et vient du serveur : deux clients rejouent
   donc exactement la même suite de paquets. */
function openedPacks(tcg) {
    return tcgPacks(tcg)
        .filter(pack => pack.status === 'opened')
        .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0) || (a.id < b.id ? -1 : 1));
}

/* Toutes les cartes frappées à ce jour, avant échanges. Une carte est
   identifiée par son paquet et son emplacement : deux exemplaires du même jeu
   restent deux objets distincts, et c'est ce qui rend l'échange possible. */
function mintedCards(tcg) {
    const streaks = {};
    const cards = [];
    openedPacks(tcg).forEach(pack => {
        const set = tcgSetCards(tcg, pack.setId);
        const streak = streaks[pack.uid] || 0;
        const drawn = drawPack(set, packSeed(pack.id, pack), { pity: streak >= TCG.PITY });
        streaks[pack.uid] = drawn.some(card => rarityIndex(card.rarity) <= rarityIndex('showcase')) ? 0 : streak + 1;

        drawn.forEach(card => {
            cards.push({
                id: pack.id + '#' + card.slot,
                packId: pack.id,
                setId: pack.setId || '',
                slot: card.slot,
                gameKey: card.gameKey,
                name: (set[card.gameKey] && set[card.gameKey].name) || card.gameKey,
                appId: (set[card.gameKey] && set[card.gameKey].appId) || null,
                rarity: card.rarity,
                foil: card.foil,
                /* La provenance : qui l'a sortie du paquet, et quand. Elle ne
                   change jamais de main, même quand la carte, elle, change.
                   C'est ce qui fait qu'une carte est un souvenir de soirée et
                   pas une ligne d'inventaire. */
                mintedBy: pack.uid,
                mintedAt: pack.openedAt || pack.sealedAt || 0,
                owner: pack.uid,
                lineage: [pack.uid]
            });
        });
    });
    return cards;
}

function acceptedTrades(tcg) {
    return tcgTrades(tcg)
        .filter(trade => trade.status === 'accepted')
        .sort((a, b) => (a.resolvedAt || a.ts || 0) - (b.resolvedAt || b.ts || 0) || (a.id < b.id ? -1 : 1));
}

/* L'état du monde : toutes les cartes, chacune chez son propriétaire actuel,
   et la liste des échanges qui ont réellement eu un effet.

   Un échange dont l'émetteur ne possédait pas ce qu'il offrait est ignoré —
   pas refusé, ignoré. Il reste visible dans le journal public, marqué « sans
   effet », ce qui est la punition suffisante entre amis. */
function tcgReplay(tcg) {
    const cards = mintedCards(tcg);
    const byId = new Map(cards.map(card => [card.id, card]));
    const applied = new Set();

    acceptedTrades(tcg).forEach(trade => {
        const offer = (trade.offer || []).map(id => byId.get(id));
        const request = (trade.request || []).map(id => byId.get(id));
        if (!offer.length && !request.length) return;
        if (offer.some(card => !card || card.owner !== trade.fromUid)) return;
        if (request.some(card => !card || card.owner !== trade.toUid)) return;

        offer.forEach(card => { card.owner = trade.toUid; card.lineage.push(trade.toUid); });
        request.forEach(card => { card.owner = trade.fromUid; card.lineage.push(trade.fromUid); });
        applied.add(trade.id);
    });

    return { cards, applied };
}

function tcgCards(tcg) {
    return tcgReplay(tcg).cards;
}

function collectionOf(cards, uid) {
    return (cards || [])
        .filter(card => card.owner === uid)
        .sort((a, b) => rarityIndex(a.rarity) - rarityIndex(b.rarity)
            || a.name.localeCompare(b.name, 'fr')
            || (b.foil ? 1 : 0) - (a.foil ? 1 : 0));
}

/* Ce qu'on possède d'un set donné, jeu par jeu. Les exemplaires en trop
   restent listés : ce sont eux qui alimentent l'échange. */
function collectionBySet(setCards, cards, uid) {
    const mine = collectionOf(cards, uid);
    return Object.entries(setCards || {})
        .map(([gameKey, card]) => {
            const copies = mine.filter(owned => owned.gameKey === gameKey);
            return {
                gameKey,
                name: card.name || gameKey,
                rarity: card.rarity || 'common',
                score: Number(card.score) || 0,
                appId: card.appId || null,
                copies,
                owned: copies.length > 0,
                foil: copies.some(copy => copy.foil)
            };
        })
        .sort((a, b) => rarityIndex(a.rarity) - rarityIndex(b.rarity)
            || b.score - a.score
            || a.name.localeCompare(b.name, 'fr'));
}

function tcgArchiveSnapshot(tcg) {
    const setId = tcgCurrentSetId(tcg);
    const set = tcgCurrentSet(tcg);
    if (!setId || !set) return null;

    const cards = tcgCards(tcg)
        .filter(card => card && card.gameKey && card.owner
            && (!card.setId || card.setId === setId))
        .map(card => ({
            id: card.id || '',
            gameKey: card.gameKey,
            name: card.name || card.gameKey,
            rarity: card.rarity || 'common',
            appId: card.appId || '',
            foil: card.foil === true,
            owner: card.owner
        }));

    return {
        setId: setId,
        setName: set.name || 'Set archivé',
        setCreatedAt: Number(set.ts) || Number(set.createdAt) || 0,
        setCards: set.cards || {},
        cards: cards
    };
}

function tcgArchiveView(historyEntry, uid) {
    const archive = historyEntry && historyEntry.tcgArchive;
    if (!archive || !archive.setCards) return null;

    const cards = Array.isArray(archive.cards)
        ? archive.cards.filter(Boolean)
        : Object.values(archive.cards || {}).filter(Boolean);

    return {
        archived: true,
        cards: cards,
        applied: new Set(),
        set: {
            id: archive.setId || '',
            name: archive.setName || (historyEntry.name ? 'Set · ' + historyEntry.name : 'Set archivé'),
            createdAt: Number(archive.setCreatedAt) || 0
        },
        setCards: archive.setCards || {},
        uid: uid || ''
    };
}

function tcgArchivedSets(history) {
    return Object.entries(history || {})
        .map(([id, entry]) => {
            const archive = entry && entry.tcgArchive;
            if (!archive || !archive.setCards) return null;
            return {
                id: id,
                setName: archive.setName || 'Set archivé',
                lanName: entry.name || '',
                date: entry.date || '',
                timestamp: Number(entry.timestamp) || 0
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
}

function setProgress(setCards, cards, uid) {
    const keys = Object.keys(setCards || {});
    const owned = new Set();
    const foils = new Set();
    (cards || []).forEach(card => {
        if (card.owner !== uid || !setCards[card.gameKey]) return;
        owned.add(card.gameKey);
        if (card.foil) foils.add(card.gameKey);
    });
    return {
        total: keys.length,
        owned: owned.size,
        foils: foils.size,
        percent: keys.length ? Math.round(owned.size * 100 / keys.length) : 0,
        complete: keys.length > 0 && owned.size === keys.length
    };
}

/* Les exemplaires en trop. On garde le brillant et la plus ancienne : ce
   qu'on propose à l'échange, c'est le surplus, jamais la pièce du souvenir. */
function duplicatesOf(cards, uid) {
    const kept = new Set();
    return (cards || [])
        .filter(card => card.owner === uid)
        .sort((a, b) => (b.foil ? 1 : 0) - (a.foil ? 1 : 0) || (a.mintedAt || 0) - (b.mintedAt || 0))
        .filter(card => {
            if (!kept.has(card.gameKey)) { kept.add(card.gameKey); return false; }
            return true;
        })
        .sort((a, b) => rarityIndex(a.rarity) - rarityIndex(b.rarity) || a.name.localeCompare(b.name, 'fr'));
}

function tcgLeaderboard(setCards, cards, uids) {
    return (uids || [])
        .map(uid => Object.assign({ uid }, setProgress(setCards, cards, uid)))
        .filter(row => row.owned > 0)
        .sort((a, b) => b.owned - a.owned || b.foils - a.foils);
}

/* --------------------------------------------------------------------------
   Les échanges
   -------------------------------------------------------------------------- */

/* Les deux côtés d'un échange sont stockés en une chaîne d'identifiants
   séparés par des virgules, et non en liste. C'est ce qui permet aux règles
   Firebase de les figer d'une seule comparaison à l'acceptation : sans ça,
   celui qui accepte pourrait réécrire l'offre en sa faveur avant de signer.
   Les identifiants de carte sont des clés Firebase et un numéro, jamais de
   virgule. */
function serializeCardList(ids) {
    return (ids || []).filter(id => typeof id === 'string' && id).join(',');
}

function parseCardList(value) {
    if (Array.isArray(value)) return value.filter(id => typeof id === 'string' && id);
    return String(value || '').split(',').map(id => id.trim()).filter(Boolean);
}

function tcgTrades(tcg) {
    return Object.entries((tcg && tcg.trades) || {})
        .map(([id, trade]) => Object.assign({ id }, trade, {
            offer: parseCardList(trade && trade.offer),
            request: parseCardList(trade && trade.request)
        }))
        .filter(trade => trade && trade.fromUid && trade.toUid)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function pendingTradesFor(tcg, uid) {
    return tcgTrades(tcg).filter(trade => trade.status === 'pending' && trade.toUid === uid);
}

function pendingTradesFrom(tcg, uid) {
    return tcgTrades(tcg).filter(trade => trade.status === 'pending' && trade.fromUid === uid);
}

/* Un échange EN ATTENTE encore recevable : les deux parties possèdent
   toujours ce qu'elles ont engagé. Une carte déjà partie ailleurs rend la
   proposition caduque, et il vaut mieux le dire que de laisser accepter dans
   le vide. À ne pas utiliser sur un échange déjà conclu — les cartes ont
   changé de mains, la question n'a plus de sens : c'est `applied` du rejeu
   qui dit s'il a eu un effet. */
function tradeStillValid(cards, trade) {
    const byId = new Map((cards || []).map(card => [card.id, card]));
    const offer = (trade.offer || []).map(id => byId.get(id));
    const request = (trade.request || []).map(id => byId.get(id));
    if (!offer.length && !request.length) return false;
    if (offer.some(card => !card || card.owner !== trade.fromUid)) return false;
    if (request.some(card => !card || card.owner !== trade.toUid)) return false;
    return true;
}

/* --------------------------------------------------------------------------
   Les boosters dans la boutique
   Un booster est un article de la boutique comme un autre, marqué kind:'pack'.
   Une demande validée donne droit à exactement un paquet, dont l'identifiant
   EST celui de la demande : un achat ne peut donc pas donner deux paquets.
   -------------------------------------------------------------------------- */

function isPackItem(item) {
    return !!(item && item.kind === 'pack');
}

function packItems(economy) {
    return Object.entries((economy && economy.catalog) || {})
        .filter(([, item]) => isPackItem(item) && item.active !== false);
}

/* Les achats de booster validés qui n'ont pas encore leur paquet. Le client du
   joueur les scelle en arrivant : s'il était hors ligne au moment de la
   validation, son paquet l'attend au prochain chargement. */
function unsealedPurchases(economy, tcg, uid) {
    const packs = (tcg && tcg.packs) || {};
    const resetAt = Math.max(0, Number(tcg && tcg.resetAt) || 0);
    const catalog = (economy && economy.catalog) || {};
    return Object.entries((economy && economy.purchases) || {})
        .map(([id, purchase]) => Object.assign({ id }, purchase))
        .filter(purchase => purchase.uid === uid
            && purchase.status === 'granted'
            && Math.max(Number(purchase.resolvedAt) || 0, Number(purchase.ts) || 0) > resetAt
            && isPackItem(catalog[purchase.itemId])
            && !packs[purchase.id])
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/* ==========================================================================
   Expérience et hauts faits
   Les złotych (« złoty » veut dire « en or ») sont l'argent de la soirée : ils
   se gagnent, se dépensent et repartent à zéro à chaque LAN. L'expérience est
   l'inverse — elle ne se dépense pas et ne s'efface JAMAIS. Elle mesure les
   soirées, pas le portefeuille.
   C'est pour ça qu'elle a son propre journal, `lan/xp/awards`, que
   startNewLan() ne touche pas.

   Même principe que le registre de points : rien n'est stocké tel quel. Le
   niveau, la barre, la liste des hauts faits obtenus — tout se recalcule depuis
   un journal en écriture unique.
   ========================================================================== */

const XP = {
    /* Le palier grandit linéairement, donc le cumul est quadratique : chaque
       niveau coûte 200 XP de plus que le précédent. Une soirée bien remplie
       rapporte 400 à 600 XP, ce qui fait deux ou trois niveaux la première
       fois puis de moins en moins — un vétéran de dix LAN reste devant sans
       que le nouveau soit largué. */
    LEVEL_STEP: 200,
    /* Ce que vaut une soirée, simplement pour être venu et avoir voté. C'est
       la récompense de l'assiduité que le reste ne mesure pas. */
    LAN_ATTENDANCE: 150
};

/* Cumul nécessaire pour ATTEINDRE le niveau n (le niveau 1 est à zéro). */
function xpForLevel(level) {
    const n = Math.max(1, Math.floor(level));
    return XP.LEVEL_STEP * n * (n - 1) / 2;
}

/* Le niveau et la position dans la barre, à partir du cumul. */
function xpLevel(total) {
    const xp = Math.max(0, Math.round(Number(total) || 0));
    let level = 1;
    while (xpForLevel(level + 1) <= xp) level += 1;
    const floor = xpForLevel(level);
    const ceiling = xpForLevel(level + 1);
    const span = ceiling - floor;
    return {
        total: xp,
        level: level,
        into: xp - floor,
        span: span,
        toNext: ceiling - xp,
        ratio: span > 0 ? (xp - floor) / span : 0
    };
}

/* Le journal d'expérience, tel quel. */

/* ==========================================================================
   Les paliers
   « Quelqu'un qui joue à un jeu vidéo pue. » Le niveau 1 sent encore la
   lessive ; à force de LAN, ça se dégrade. C'est la seule échelle du jeu où
   monter est une mauvaise nouvelle, et c'est bien pour ça qu'elle est drôle.
   ========================================================================== */

const LEVEL_TITLES = [
    /* L'escalade se fait par REGISTRE, pas par adjectifs de plus en plus forts.
       On part du corps (moite, suant), on passe à l'environnement (site pollué,
       périmètre évacué), puis à l'administration (état de catastrophe
       naturelle), et on finit au droit international. C'est le décalage entre
       le sérieux de la formule et la bêtise du sujet qui fait rire — pas
       l'adjectif. */
    'Parfumé',                          // 1
    'Frais comme un gardon',            // 2
    'Propre sur soi',                   // 3
    'Légèrement tiède',                 // 4
    'Moite',                            // 5
    'Suant',                            // 6
    'Point de bascule',                 // 7
    'Fermenté',                         // 8
    'Rance',                            // 9
    'Faisandé',                         // 10
    'Détectable depuis le couloir',     // 11
    'Signalé par le voisinage',         // 12
    'Zone de confinement',              // 13
    'Périmètre évacué',                 // 14
    'Classé site pollué',               // 15
    'Fermé au public par arrêté',       // 16
    'Arme de dissuasion olfactive',     // 17
    'Crime contre l\'odorat',           // 18
    'État de catastrophe naturelle',    // 19
    'Incident diplomatique',            // 20
    'Cas d\'école en toxicologie',      // 21
    'Convention de Genève, annexe VII'  // 22
];

/* Au-delà du dernier palier, on ne peut plus descendre : on reste une légende.
   Mieux vaut un plafond assumé qu'un niveau sans nom. */
function levelTitle(level) {
    const n = Math.max(1, Math.floor(Number(level) || 1));
    return LEVEL_TITLES[Math.min(n, LEVEL_TITLES.length) - 1];
}

function xpAwards(xpNode) {
    const awards = (xpNode && xpNode.awards) || {};
    return Object.entries(awards)
        .map(([id, award]) => Object.assign({ id: id }, award))
        .filter(award => award && award.uid);
}

function xpTotal(xpNode, uid) {
    if (!uid) return 0;
    let total = 0;
    xpAwards(xpNode).forEach(award => {
        if (award.uid === uid) total += Number(award.delta) || 0;
    });
    return total;
}

function xpFeed(xpNode, limit) {
    const rows = xpAwards(xpNode).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return limit ? rows.slice(0, limit) : rows;
}

function xpLeaderboard(xpNode, uids) {
    return (uids || [])
        .map(uid => Object.assign({ uid: uid }, xpLevel(xpTotal(xpNode, uid))))
        .filter(row => row.total > 0)
        .sort((a, b) => b.total - a.total);
}

/* La clé d'une récompense est déterministe : deux maîtres du jeu en ligne
   écrivent le même nœud plutôt que deux récompenses. C'est ce qui rend
   l'attribution automatique sans risque de doublon. */
function achievementAwardId(uid, achId) {
    return uid + '__ach__' + achId;
}

function attendanceAwardId(uid, lanId) {
    return uid + '__lan__' + lanId;
}

function hasXpAward(xpNode, awardId) {
    const award = ((xpNode && xpNode.awards) || {})[awardId];
    return !!(award && award.revoked !== true);
}

function isXpAwardRevoked(xpNode, awardId) {
    const award = ((xpNode && xpNode.awards) || {})[awardId];
    return !!(award && award.revoked === true);
}

function achievementGrantRecord(uid, ach, admin, timestamp) {
    return {
        uid: uid,
        delta: ach.xp,
        type: 'achievement',
        reason: ach.label,
        refId: ach.id,
        by: admin && admin.uid || null,
        byName: admin && admin.name || 'Admin',
        ts: timestamp
    };
}

function achievementResetRecord(uid, ach, admin, timestamp) {
    return {
        uid: uid,
        delta: 0,
        type: 'achievement-reset',
        reason: 'Réinitialisé : ' + ach.label,
        refId: ach.id,
        revoked: true,
        by: admin && admin.uid || null,
        byName: admin && admin.name || 'Admin',
        ts: timestamp
    };
}

/* Réinitialiser un haut fait enlève aussi ses références de vitrine. La mise
   à jour multi-chemins évite qu'un profil conserve un titre devenu verrouillé. */
function achievementResetUpdates(uid, ach, profile, admin, timestamp) {
    const updates = {};
    updates['lan/xp/awards/' + achievementAwardId(uid, ach.id)] =
        achievementResetRecord(uid, ach, admin, timestamp);
    if (profile && profile.equippedTitleId === ach.id) {
        updates['lan/users/' + uid + '/equippedTitleId'] = null;
    }
    ['featuredAchievement1', 'featuredAchievement2', 'featuredAchievement3'].forEach(field => {
        if (profile && profile[field] === ach.id) updates['lan/users/' + uid + '/' + field] = null;
    });
    return updates;
}

/* Révélations encore à jouer pour un joueur. Le timestamp vu est stocké par
   haut fait : une réattribution après réinitialisation rejoue donc la cérémonie,
   tandis qu'un changement d'appareil ne la duplique pas indéfiniment. */
function unseenAchievementAwards(xpNode, uid, seenByAchievement, since) {
    const seen = seenByAchievement || {};
    const floor = Math.max(0, Number(since) || 0);
    return xpAwards(xpNode)
        .filter(award => award.uid === uid
            && award.type === 'achievement'
            && award.revoked !== true
            && achievementById(award.refId)
            && (Number(award.ts) || 0) >= floor
            && (Number(award.ts) || 0) > (Number(seen[award.refId]) || 0))
        .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

/* ==========================================================================
   Le catalogue des hauts faits
   Deux familles, et la différence compte.

   - Les JALONS sont absolus et monotones : « cinq achats », « une Signature ».
     Ils se calculent depuis les données du moment, et une fois obtenus ils sont
     acquis pour toujours — c'est la récompense écrite au journal qui fait foi,
     pas le calcul. Sans ça, un jalon gagné ce soir se reverrouillerait à la
     prochaine LAN, quand les compteurs de la soirée repartent à zéro.

   - Les TITRES DE SOIRÉE sont comparatifs : « le plus gros acheteur ». Ils
     n'ont de sens qu'une fois la soirée finie, donc ils sont décernés à la
     clôture et archivés avec elle.
   ========================================================================== */

const ACHIEVEMENTS = [
    /* --- La boutique --- */
    { id: 'first-buy', icon: 'cart', family: 'boutique', xp: 25,
      label: 'Premier achat', hint: 'Acheter quoi que ce soit', goal: 1 },
    { id: 'buyer-5', icon: 'cart', family: 'boutique', xp: 50,
      label: 'Client fidèle', hint: 'Cinq achats validés', goal: 5, nickname: 'Le Client' },
    { id: 'buyer-20', icon: 'cart', family: 'boutique', xp: 120,
      label: 'Pilier du comptoir', hint: 'Vingt achats validés', goal: 20, nickname: 'Le Pilier' },
    { id: 'spender-500', icon: 'coin', family: 'boutique', xp: 60,
      label: 'Dépensier', hint: 'Cinq cents złotych dépensés', goal: 500, nickname: 'Le Dépensier' },
    { id: 'spender-2000', icon: 'coin', family: 'boutique', xp: 150,
      label: 'Le PIB de la LAN', hint: 'Dépenser deux mille złotych pendant une LAN', goal: 2000, nickname: 'Le PIB de la LAN' },
    { id: 'spender-broke', icon: 'coin', family: 'boutique', xp: 100,
      label: 'La CB en PLS', hint: 'Dépenser mille złotych et finir avec moins de vingt', goal: 1000,
      nickname: 'La CB en PLS', closureOnly: true },
    { id: 'handicap-1', icon: 'target', family: 'boutique', xp: 40,
      label: 'Sale coup', hint: 'Jouer un handicap sur quelqu\'un', goal: 1, nickname: 'La Crapule' },
    { id: 'handicap-5', icon: 'target', family: 'boutique', xp: 110,
      label: 'Fléau du lobby', hint: 'Infliger cinq handicaps pendant une LAN', goal: 5, nickname: 'Le Fléau du lobby' },

    /* --- Les cartes --- */
    { id: 'pack-1', icon: 'pack', family: 'cartes', xp: 25,
      label: 'Premier paquet', hint: 'Ouvrir un booster', goal: 1 },
    { id: 'pack-10', icon: 'pack', family: 'cartes', xp: 100,
      label: 'Ouvreur compulsif', hint: 'Ouvrir dix boosters', goal: 10, nickname: 'L\'Ouvreur' },
    { id: 'cards-50', icon: 'cards', family: 'cartes', xp: 80,
      label: 'Collectionneur', hint: 'Cinquante cartes différentes', goal: 50, nickname: 'Le Collectionneur' },
    { id: 'foil-10', icon: 'spark', family: 'cartes', xp: 80,
      label: 'Ça brille', hint: 'Dix cartes brillantes', goal: 10, nickname: 'L\'Étincelant' },
    { id: 'signature-1', icon: 'signature', family: 'cartes', xp: 150,
      label: 'La Signature', hint: 'Sortir une carte Signature', goal: 1, nickname: 'Le Signataire' },
    { id: 'set-complete', icon: 'trophy', family: 'cartes', xp: 300,
      label: 'Set complet', hint: 'Compléter un set entier', goal: 1, nickname: 'Le Complétiste' },
    { id: 'trade-1', icon: 'trade', family: 'cartes', xp: 40,
      label: 'Premier échange', hint: 'Conclure un échange', goal: 1 },
    { id: 'trade-10', icon: 'trade', family: 'cartes', xp: 120,
      label: 'Négociant', hint: 'Conclure dix échanges', goal: 10, nickname: 'Le Négociant' },

    /* --- L'assiduité --- */
    { id: 'tick-max', icon: 'clock', family: 'soirée', xp: 60,
      label: 'Increvable', hint: 'Atteindre le plafond de présence', goal: ECONOMY.MAX_TICKS, nickname: 'L\'Increvable' },
    { id: 'lan-3', icon: 'flag', family: 'soirée', xp: 100,
      label: 'Le Meuble', hint: 'Participer à trois LAN', goal: 3, nickname: 'Le Meuble' },
    { id: 'lan-7', icon: 'flag', family: 'soirée', xp: 180,
      label: 'Il habite ici', hint: 'Participer à sept LAN', goal: 7, nickname: 'Il habite ici' },
    { id: 'lan-15', icon: 'flag', family: 'soirée', xp: 320,
      label: 'Le bail est à son nom', hint: 'Participer à quinze LAN', goal: 15, nickname: 'Le bail est à son nom' },
    { id: 'lan-comeback', icon: 'clock', family: 'soirée', xp: 140,
      label: 'Le Revenant', hint: 'Revenir après avoir manqué trois LAN de suite', goal: 1, nickname: 'Le Revenant' },

    /* --- Les défis --- */
    { id: 'challenge-all', icon: 'spark', family: 'défis', xp: 150,
      label: 'Le Couteau suisse', hint: 'Valider un défi de chaque catégorie pendant une LAN', goal: 5, nickname: 'Le Couteau suisse' },
    { id: 'challenge-faker', icon: 'trophy', family: 'défis', xp: 300,
      label: 'Faker', hint: 'Valider quinze défis pendant une LAN', goal: 15, nickname: 'Faker' },

    /* --- Les votes, figés uniquement à la clôture --- */
    { id: 'vote-solo-winner', icon: 'target', family: 'votes', xp: 200,
      label: 'Seul contre tous', hint: 'Faire gagner un jeu dont on était l’unique votant', goal: 1,
      nickname: 'Seul contre tous', closureOnly: true },
    { id: 'vote-kingmaker', icon: 'trophy', family: 'votes', xp: 250,
      label: 'Le Faiseur de roi', hint: 'Voir son choix numéro un gagner trois LAN', goal: 3,
      nickname: 'Le Faiseur de roi', closureOnly: true },

    /* --- Le passage ---
       Celui-là ne se calcule pas sur un compteur mais sur une époque : tant que
       l'admin laisse `lan/settings/beta` allumé, quiconque participe à une
       soirée l'obtient. Il s'éteint le jour où la bêta se termine, et devient
       alors impossible à décrocher — c'est tout l'intérêt. */
    { id: 'beta', icon: 'flag', family: 'légende', xp: 200,
      label: 'Bêta-testeur', hint: 'Avoir été là pendant la bêta', goal: 1,
      nickname: 'Le Cobaye originel' }
];

/* Un titre débloqué n'est pas une couleur choisie au hasard : c'est une petite
   direction artistique complète. Plusieurs titres peuvent partager une
   famille, mais chacun garde sa matière et son accent. La rareté règle
   l'intensité du mouvement, jamais la lisibilité. */
const PROFILE_TITLE_THEMES = {
    'buyer-5':          { rarity: 'common',    material: 'bronze',   motif: 'ledger', motion: 'commerce', accent: '#c98b4b', accent2: '#f1c27a' },
    'buyer-20':         { rarity: 'rare',      material: 'brass',    motif: 'ledger', motion: 'commerce', accent: '#d7a92f', accent2: '#ffe07a' },
    'spender-500':      { rarity: 'uncommon',  material: 'copper',   motif: 'coins', motion: 'commerce', accent: '#cf7445', accent2: '#ffd095' },
    'spender-2000':     { rarity: 'signature', material: 'platinum', motif: 'coins', motion: 'commerce', accent: '#f3ca45', accent2: '#fff4b0' },
    'spender-broke':    { rarity: 'epic',      material: 'crimson',  motif: 'fracture', motion: 'mischief', accent: '#ef6464', accent2: '#ffb36b' },
    'handicap-1':       { rarity: 'uncommon',  material: 'garnet',   motif: 'target', motion: 'mischief', accent: '#d75858', accent2: '#ff9d72' },
    'handicap-5':       { rarity: 'epic',      material: 'obsidian', motif: 'target', motion: 'mischief', accent: '#ff4b4b', accent2: '#b78cff' },
    'pack-10':          { rarity: 'uncommon',  material: 'indigo',   motif: 'cards', motion: 'collection', accent: '#9075df', accent2: '#d8c7ff' },
    'cards-50':         { rarity: 'rare',      material: 'sapphire', motif: 'cards', motion: 'collection', accent: '#4f9fd8', accent2: '#8de9ff' },
    'foil-10':          { rarity: 'epic',      material: 'prism',    motif: 'shards', motion: 'collection', accent: '#b56cff', accent2: '#64e7da' },
    'signature-1':      { rarity: 'signature', material: 'aurum',    motif: 'signature', motion: 'collection', accent: '#e3bd3b', accent2: '#fff2a3' },
    'set-complete':     { rarity: 'signature', material: 'emerald',  motif: 'crown', motion: 'collection', accent: '#54c58a', accent2: '#c6ffd9' },
    'trade-10':         { rarity: 'rare',      material: 'teal',     motif: 'exchange', motion: 'collection', accent: '#47b7aa', accent2: '#9ff5e8' },
    'tick-max':         { rarity: 'rare',      material: 'midnight', motif: 'orbit', motion: 'legacy', accent: '#7799dc', accent2: '#d0ddff' },
    'lan-3':            { rarity: 'common',    material: 'oak',      motif: 'rings', motion: 'legacy', accent: '#b88a55', accent2: '#e3bf86' },
    'lan-7':            { rarity: 'rare',      material: 'velvet',   motif: 'rings', motion: 'legacy', accent: '#9e70d9', accent2: '#e4c5ff' },
    'lan-15':           { rarity: 'signature', material: 'ivory',    motif: 'deed', motion: 'legacy', accent: '#e8d5a3', accent2: '#fff9df' },
    'lan-comeback':     { rarity: 'epic',      material: 'ember',    motif: 'orbit', motion: 'legacy', accent: '#e98042', accent2: '#ffd05c' },
    'challenge-all':    { rarity: 'epic',      material: 'spectrum', motif: 'shards', motion: 'challenge', accent: '#4ed0a0', accent2: '#e4c25e' },
    'challenge-faker':  { rarity: 'signature', material: 'imperial', motif: 'crown', motion: 'challenge', accent: '#d94242', accent2: '#f3c64f' },
    'vote-solo-winner': { rarity: 'epic',      material: 'cobalt',   motif: 'rays', motion: 'vote', accent: '#4f7ee8', accent2: '#f2d56b' },
    'vote-kingmaker':   { rarity: 'signature', material: 'royal',    motif: 'crown', motion: 'vote', accent: '#8c67d7', accent2: '#f2cd55' },
    'beta':             { rarity: 'rare',      material: 'prototype', motif: 'grid', motion: 'prototype', accent: '#63c5b5', accent2: '#e0c35a' },
    'administrator':    { rarity: 'signature', material: 'polonia',  motif: 'polonia', motion: 'polonia', accent: '#dc143c', accent2: '#fffdf7' }
};

/* La cérémonie reprend la personnalité du haut fait, pas seulement son
   pictogramme. Les deux interfaces consomment ce même portrait pour que le son,
   les couleurs et le mouvement ne divergent jamais entre le PC et le mobile.
   Le thème de titre affine une récompense précise ; la famille donne une
   identité aux petits jalons qui n'ont pas encore leur propre titre. */
const ACHIEVEMENT_REVEAL_FAMILIES = {
    boutique: { key: 'commerce', label: 'ARCHIVES DE LA BOUTIQUE', mark: 'ZŁ', accent: '#d7a92f', accent2: '#ffe07a' },
    cartes: { key: 'collection', label: 'CABINET DES COLLECTIONS', mark: '✦', accent: '#9075df', accent2: '#8de9ff' },
    'soirée': { key: 'legacy', label: 'REGISTRE DES VÉTÉRANS', mark: 'III', accent: '#7799dc', accent2: '#d0ddff' },
    'défis': { key: 'challenge', label: 'DOSSIER DES DÉFIS', mark: '⚔', accent: '#d94242', accent2: '#f3c64f' },
    votes: { key: 'vote', label: 'CHRONIQUES DU SCRUTIN', mark: '♛', accent: '#8c67d7', accent2: '#f2cd55' },
    'légende': { key: 'prototype', label: 'ARCHIVE CONFIDENTIELLE', mark: 'β', accent: '#63c5b5', accent2: '#e0c35a' }
};

function achievementRevealTheme(value) {
    const ach = typeof value === 'string' ? achievementById(value) : value;
    const family = ACHIEVEMENT_REVEAL_FAMILIES[ach && ach.family]
        || { key: 'classic', label: 'HAUT FAIT DÉBLOQUÉ', mark: '◆', accent: '#d4af37', accent2: '#ffe078' };
    const titleTheme = ach && PROFILE_TITLE_THEMES[ach.id];
    const xp = Math.max(0, Number(ach && ach.xp) || 0);
    const rarity = (titleTheme && titleTheme.rarity)
        || (xp >= 250 ? 'signature' : xp >= 150 ? 'epic' : xp >= 100 ? 'rare' : xp >= 50 ? 'uncommon' : 'common');

    return {
        family: family.key,
        familyLabel: family.label,
        mark: family.mark,
        rarity: rarity,
        accent: (titleTheme && titleTheme.accent) || family.accent,
        accent2: (titleTheme && titleTheme.accent2) || family.accent2
    };
}

/* Les titres de rôle ne sont pas des hauts faits. Ils ne donnent ni XP ni
   trophée : ils constatent une fonction réelle, vérifiée à nouveau au moment de
   l'enregistrement par les règles Firebase. */
const PROFILE_ROLE_TITLES = {
    administrator: { id: 'administrator', label: 'Administrator', achievementLabel: 'Administracja', role: 'admin', xp: 0, priority: 10000 }
};

function profileTitleById(id) {
    const ach = achievementById(id);
    const roleTitle = PROFILE_ROLE_TITLES[id];
    const theme = PROFILE_TITLE_THEMES[id];
    if (!theme || (!roleTitle && (!ach || !ach.nickname))) return null;
    return Object.assign({}, roleTitle || { id: id, label: ach.nickname, achievementLabel: ach.label }, theme);
}

function achievementById(id) {
    return ACHIEVEMENTS.find(a => a.id === id) || null;
}

/* Les titres décernés à la clôture. `pick` reçoit les compteurs de tous les
   joueurs et rend celui qui l'emporte. */
const LAN_TITLES = [
    { id: 'top-buyer', label: 'Le plus gros acheteur', xp: 100, metric: 'purchases' },
    { id: 'top-spender', label: 'Le plus dépensier', xp: 100, metric: 'spent' },
    { id: 'top-fortune', label: 'La plus grosse fortune', xp: 100, metric: 'balance' },
    { id: 'top-opener', label: 'Le plus gros ouvreur', xp: 100, metric: 'packs' },
    { id: 'top-trader', label: 'Le plus grand négociant', xp: 100, metric: 'trades' },
    { id: 'top-presence', label: 'Le plus présent', xp: 100, metric: 'ticks' }
];

/* Combien de LAN ce joueur a-t-il faites ? L'historique garde les votes de
   chaque soirée : y figurer, c'est y avoir été. La soirée en cours compte
   aussi, sinon un nouveau reste à zéro toute sa première LAN. */
function lanCountFor(history, votes, uid) {
    if (!uid) return 0;
    let count = 0;
    Object.values(history || {}).forEach(entry => {
        if (entry && entry.votes && entry.votes[uid]) count += 1;
    });
    if ((votes || {})[uid]) count += 1;
    return count;
}

function lanComebackFor(history, votes, uid) {
    if (!uid || !(votes || {})[uid]) return 0;
    const rows = Object.values(history || {})
        .filter(Boolean)
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
    if (rows.length < 3) return 0;
    return rows.slice(0, 3).every(entry => !(entry.votes || {})[uid]) ? 1 : 0;
}

function challengeCountersFor(node, uid, since) {
    const challenges = (node && node.challenges) || {};
    const byCategory = {};
    challengeCategories().forEach(category => { byCategory[category.key] = 0; });
    let count = 0;
    allClaims(node).forEach(claim => {
        if (claim.uid !== uid || claim.status !== 'granted'
            || (Number(claim.ts) || 0) <= (Number(since) || 0)) return;
        count += 1;
        const source = challenges[claim.challengeId] || {};
        const category = challengeCategory(source.category || claim.category).key;
        byCategory[category] = (byCategory[category] || 0) + 1;
    });
    return {
        count: count,
        categories: byCategory,
        categoryCount: challengeCategories().filter(category => byCategory[category.key] > 0).length
    };
}

function firstChoiceWins(voteData, winnerName) {
    const wanted = normalizeGameName(winnerName);
    const first = voteList((((voteData || {}).votes || {}).p1));
    return !!wanted && first.some(game => normalizeGameName(game) === wanted);
}

function kingmakerWins(history, uid) {
    let count = 0;
    Object.values(history || {}).forEach(entry => {
        if (!entry || !entry.topGames || !entry.topGames[0] || !entry.votes) return;
        if (firstChoiceWins(entry.votes[uid], entry.topGames[0].name)) count += 1;
    });
    return count;
}

/* Tous les compteurs d'un joueur, en une passe. C'est la seule fonction qui
   sait où vivent les données ; les hauts faits et les titres n'en lisent que
   le résultat. */
function playerCounters(data, uid) {
    const economy = data.economy || {};
    const tcg = data.tcg || {};
    const cards = data.cards || tcgCards(tcg);

    const purchases = Object.values(economy.purchases || {})
        .filter(p => p && p.uid === uid && p.status === 'granted');

    let spent = 0;
    let earned = 0;
    Object.values(economy.ledger || {}).forEach(entry => {
        if (!entry || entry.uid !== uid) return;
        const delta = Number(entry.delta) || 0;
        if (delta < 0) spent += -delta; else earned += delta;
    });

    const mine = collectionOf(cards, uid);
    const distinct = {};
    let foils = 0;
    let signatures = 0;
    mine.forEach(card => {
        distinct[card.gameKey] = true;
        if (card.foil) foils += 1;
        if (card.rarity === 'signature') signatures += 1;
    });

    const lans = lanCountFor(data.history, data.votes, uid);
    const myPacks = openedPacks(tcg).filter(pack => pack.uid === uid);
    const myTrades = acceptedTrades(tcg)
        .filter(trade => trade.fromUid === uid || trade.toUid === uid);
    const lastClosure = Object.values(data.history || {}).reduce((latest, entry) =>
        Math.max(latest, Number(entry && entry.timestamp) || 0), 0);
    const challengeStats = challengeCountersFor(data.quests, uid, lastClosure);

    /* Un set complet, c'est 100 % sur AU MOINS un set — pas sur le dernier.
       Un vétéran qui a bouclé le set de janvier le garde. */
    let anyComplete = false;
    let bestPercent = 0;
    Object.values((tcg && tcg.sets) || {}).forEach(set => {
        const progress = setProgress((set && set.cards) || {}, cards, uid);
        if (progress.complete) anyComplete = true;
        if (progress.percent > bestPercent) bestPercent = progress.percent;
    });

    return {
        purchases: purchases.length,
        handicaps: purchases.filter(p => p.targetUid && p.targetUid !== uid).length,
        spent: spent,
        earned: earned,
        balance: economyBalance(economy, uid),
        packs: myPacks.length,
        cards: Object.keys(distinct).length,
        foils: foils,
        signatures: signatures,
        trades: myTrades.length,
        setComplete: anyComplete,
        setPercent: bestPercent,
        ticks: Number(((economy.ticks || {})[uid] || {}).count) || 0,
        lans: lans,
        comeback: lanComebackFor(data.history, data.votes, uid),
        challenges: challengeStats.count,
        challengeCategories: challengeStats.categoryCount,
        kingmakerWins: kingmakerWins(data.history, uid),
        /* Le niveau est un compteur comme un autre : un haut fait peut donc en
           exiger un. Pas de boucle — la récompense s'écrit une seule fois. */
        level: xpLevel(xpTotal(data.xp, uid)).level,
        /* La bêta n'est pas un compteur mais une époque : tant que l'admin la
           laisse allumée, être venu suffit. */
        beta: ((data.settings && data.settings.beta) && lans >= 1) ? 1 : 0
    };
}

/* La progression d'un joueur sur un haut fait : où il en est, et s'il y est.
   Rien n'est écrit ici — c'est une lecture. L'attribution, elle, passe par un
   maître du jeu (voir pendingAchievements). */
function achievementProgress(counters, ach) {
    const value = {
        'first-buy': counters.purchases,
        'buyer-5': counters.purchases,
        'buyer-20': counters.purchases,
        'spender-500': counters.spent,
        'spender-2000': counters.spent,
        'spender-broke': counters.spent,
        'handicap-1': counters.handicaps,
        'handicap-5': counters.handicaps,
        'pack-1': counters.packs,
        'pack-10': counters.packs,
        'cards-50': counters.cards,
        'foil-10': counters.foils,
        'signature-1': counters.signatures,
        'set-complete': counters.setComplete ? 1 : 0,
        'trade-1': counters.trades,
        'trade-10': counters.trades,
        'tick-max': counters.ticks,
        'lan-3': counters.lans,
        'lan-7': counters.lans,
        'lan-15': counters.lans,
        'lan-comeback': counters.comeback,
        'challenge-all': counters.challengeCategories,
        'challenge-faker': counters.challenges,
        'vote-solo-winner': 0,
        'vote-kingmaker': counters.kingmakerWins,
        'beta': counters.beta
    }[ach.id];

    const current = Math.max(0, Number(value) || 0);
    const goal = Math.max(1, Number(ach.goal) || 1);
    return {
        current: Math.min(current, goal),
        goal: goal,
        ratio: Math.min(1, current / goal),
        reached: ach.id === 'spender-broke'
            ? counters.spent >= goal && counters.balance < 20
            : current >= goal
    };
}

/* L'état complet des hauts faits d'un joueur : obtenus, atteints mais pas
   encore inscrits, et le reste avec sa progression. */
function achievementState(data, uid) {
    const counters = playerCounters(data, uid);
    return ACHIEVEMENTS.map(ach => {
        const progress = achievementProgress(counters, ach);
        const awardId = achievementAwardId(uid, ach.id);
        const awarded = hasXpAward(data.xp, awardId);
        const revoked = isXpAwardRevoked(data.xp, awardId);
        return {
            ach: ach,
            current: progress.current,
            goal: progress.goal,
            ratio: progress.ratio,
            reached: progress.reached,
            /* Obtenu = inscrit au journal. Un jalon acquis le reste même quand
               les compteurs de la soirée repartent à zéro. */
            owned: awarded,
            revoked: revoked,
            pending: progress.reached && !awarded && !revoked
        };
    });
}

function achievementsOwned(data, uid) {
    return achievementState(data, uid).filter(row => row.owned);
}

/* Ce qu'un maître du jeu doit inscrire : atteint, pas encore récompensé.
   Rendu pour tous les joueurs d'un coup, parce que c'est un balayage de fond
   qui tourne sur son client. */
function pendingAchievements(data, uids) {
    const out = [];
    (uids || []).forEach(uid => {
        achievementState(data, uid).forEach(row => {
            if (row.pending && !row.ach.closureOnly) out.push({ uid: uid, ach: row.ach });
        });
    });
    return out;
}

/* Les titres de vote ne sont vrais qu'une fois le scrutin figé. Cette fonction
   est appelée juste avant l'archivage de la LAN ; elle inclut la victoire qui
   vient de se produire sans la compter deux fois dans l'historique. */
function closureAchievements(data, uid) {
    const winner = calculateScores(data.votes || {})[0];
    const ids = [];
    const counters = playerCounters(data, uid);
    if (counters.spent >= 1000 && counters.balance < 20) ids.push('spender-broke');
    if (!winner) return ids.map(achievementById).filter(Boolean);
    const winnerKey = normalizeGameName(winner.name);
    const voters = Object.entries(data.votes || {}).filter(([, voteData]) => {
        const ballot = (voteData && voteData.votes) || {};
        return BALLOT_PRIORITIES.some(priority => voteList(ballot[priority]).some(game => normalizeGameName(game) === winnerKey));
    });
    if (voters.length === 1 && voters[0][0] === uid) ids.push('vote-solo-winner');
    const wins = kingmakerWins(data.history, uid) + (firstChoiceWins((data.votes || {})[uid], winner.name) ? 1 : 0);
    if (wins >= 3) ids.push('vote-kingmaker');
    return ids.map(achievementById).filter(Boolean);
}

/* Les titres de la soirée, décernés à la clôture. Un titre sans concurrent
   n'est pas un titre : il faut au moins un compteur non nul. */
function lanTitles(data, uids) {
    const counters = {};
    (uids || []).forEach(uid => { counters[uid] = playerCounters(data, uid); });

    return LAN_TITLES.map(title => {
        let bestUid = null;
        let best = 0;
        (uids || []).forEach(uid => {
            const value = Number(counters[uid][title.metric]) || 0;
            if (value > best) { best = value; bestUid = uid; }
        });
        return bestUid ? { title: title, uid: bestUid, value: best } : null;
    }).filter(Boolean);
}

function unlockedProfileTitles(data, uid) {
    const titles = achievementState(data, uid)
        .filter(row => row.owned && profileTitleById(row.ach.id))
        .map(row => Object.assign({ xp: row.ach.xp }, profileTitleById(row.ach.id)));
    const role = ((data.roles || {})[uid]) || (uid && uid === data.adminUid ? 'admin' : '');
    Object.values(PROFILE_ROLE_TITLES).forEach(roleTitle => {
        if (role === roleTitle.role) titles.push(profileTitleById(roleTitle.id));
    });
    return titles;
}

/* Le titre est choisi librement parmi ceux réellement inscrits au journal.
   Sans choix explicite, le nom reste nu : aucun trophée ne parle à la place du
   joueur. */
function playerNickname(data, uid) {
    if (!Object.prototype.hasOwnProperty.call(data || {}, 'profiles')) {
        const legacy = unlockedProfileTitles(data, uid)
            .sort((a, b) => (Number(b.priority) || Number(b.xp) || 0) - (Number(a.priority) || Number(a.xp) || 0))[0];
        return legacy ? legacy.label : '';
    }
    const selected = (((data.profiles || {})[uid] || {}).equippedTitleId) || '';
    const unlocked = unlockedProfileTitles(data, uid).find(title => title.id === selected);
    return unlocked ? unlocked.label : '';
}

/* La couleur d'un joueur : celle du titre qu'il a choisi d'équiper.
   Un titre n'est pas qu'un mot, c'est une direction artistique — les joueurs
   la voyaient sur leur propre carte Signature et nulle part ailleurs. La
   rendre ici permet de la porter partout où l'on nomme quelqu'un, à commencer
   par la table des présents. Sans titre équipé, on ne rend rien : au dessin
   d'utiliser sa couleur par défaut plutôt qu'un or arbitraire. */
function playerAccent(data, uid) {
    if (!uid) return null;
    const selected = (((data && data.profiles || {})[uid] || {}).equippedTitleId) || '';
    if (!selected) return null;
    const title = unlockedProfileTitles(data, uid).find(t => t.id === selected);
    return title ? { accent: title.accent, accent2: title.accent2, label: title.label } : null;
}

/* Le nom complet, surnom compris. Sans surnom, on rend le nom seul — jamais
   des guillemets vides. */
function playerFullName(name, nickname) {
    const clean = (name || 'Un joueur').trim();
    return nickname ? clean + ' « ' + nickname + ' »' : clean;
}

/* La fiche d'un joueur, telle qu'elle s'affiche : ce qu'il est, ce qu'il a
   fait, ce qu'il possède. Une seule fonction pour les deux interfaces, comme
   tout ce qui compte. */
function playerProfile(data, uid) {
    const counters = playerCounters(data, uid);
    const rows = achievementState(data, uid);
    const owned = rows.filter(row => row.owned);
    const profileNode = ((data.profiles || {})[uid]) || {};
    const unlockedTitles = unlockedProfileTitles(data, uid);
    const explicitProfiles = Object.prototype.hasOwnProperty.call(data || {}, 'profiles');
    const equippedTitle = explicitProfiles
        ? (unlockedTitles.find(title => title.id === profileNode.equippedTitleId) || null)
        : (unlockedTitles.slice().sort((a, b) => b.xp - a.xp)[0] || null);
    const chosenFeatured = [1, 2, 3]
        .map(index => profileNode['featuredAchievement' + index])
        .filter(Boolean);
    const featured = chosenFeatured
        .map(id => owned.find(row => row.ach.id === id))
        .filter(Boolean);
    if (!featured.length) {
        owned.slice().sort((a, b) => b.ach.xp - a.ach.xp).slice(0, 3)
            .forEach(row => featured.push(row));
    }

    /* Ce qu'il a presque : la ligne la plus avancée parmi celles qu'il n'a pas
       encore. C'est ce qui donne envie de rouvrir la fiche. */
    const nextUp = rows
        .filter(row => !row.owned && row.ratio > 0)
        .sort((a, b) => b.ratio - a.ratio)[0] || null;

    return {
        uid: uid,
        nickname: equippedTitle ? equippedTitle.label : '',
        equippedTitle: equippedTitle,
        unlockedTitles: unlockedTitles,
        featuredAchievements: featured,
        level: xpLevel(xpTotal(data.xp, uid)),
        balance: counters.balance,
        counters: counters,
        achievements: owned,
        achievementCount: owned.length,
        achievementTotal: rows.length,
        nextUp: nextUp,
        /* Les titres de soirée déjà décernés, lus au journal : ce sont des
           récompenses inscrites, pas un calcul du moment. */
        titles: xpAwards(data.xp)
            .filter(award => award.uid === uid && award.type === 'title')
            .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    };
}

/* ==========================================================================
   La carte de départ
   Une boutique vide ne donne envie de rien, et personne n'a envie de remplir
   quinze formulaires à minuit. Voici de quoi ouvrir, en une fois.

   Les prix sont calés sur le plafond de présence (60 tranches × 5 zł = 300 zł
   pour une LAN entière passée devant l'écran) : un privilège coûte une bonne
   partie d'une soirée, un handicap se paie cher parce qu'il se joue sur
   quelqu'un, et les cosmétiques sont des objectifs de plusieurs soirées.
   ========================================================================== */

const SHOP_STARTER = [
    /* --- Privilèges : ce qu'on impose à la soirée --- */
    { name: 'Choisir le prochain jeu', price: 120, category: 'privilege',
      description: 'Tu poses le jeu suivant sur la table. Personne ne discute.' },
    { name: 'Droit de veto', price: 100, category: 'privilege',
      description: 'Un jeu de ton choix est interdit pendant une heure.' },
    { name: 'Maître de la musique', price: 60, category: 'privilege',
      description: 'Trente minutes de règne sans partage sur l\'enceinte.' },
    { name: 'Pause imposée', price: 90, category: 'privilege',
      description: 'Dix minutes de pause pour tout le monde. Va prendre l\'air.' },
    { name: 'Double vote', price: 200, category: 'privilege',
      description: 'Ton vote compte double à la prochaine soirée.' },
    { name: 'Choisir les équipes', price: 110, category: 'privilege',
      description: 'Tu composes les équipes de la prochaine partie.' },

    /* --- Bonus : ce qui te protège ou t'avantage ---
       L'exact inverse des handicaps. Un handicap se joue SUR quelqu'un ; un
       bonus se garde POUR soi, et sert souvent à répondre à un handicap. C'est
       ce qui rend la guerre des handicaps jouable au lieu d'être subie. */
    { name: 'Bouclier', price: 200, category: 'boost',
      description: 'Annule le prochain handicap joué sur toi. Annonce-le au moment où il tombe.' },
    { name: 'Miroir', price: 280, category: 'boost',
      description: 'Le prochain handicap joué sur toi repart chez celui qui l\'a acheté.' },
    { name: 'Joker', price: 150, category: 'boost',
      description: 'Refuse un défi imposé, une fois, sans avoir à te justifier.' },
    { name: 'Seconde chance', price: 120, category: 'boost',
      description: 'Retente un défi qui vient de t\'être refusé. Une seule fois.' },
    { name: 'Double ration', price: 250, category: 'boost',
      description: 'Ton prochain défi validé paie double, złotych et XP.' },
    { name: 'Assurance booster', price: 180, category: 'boost',
      description: 'Ton prochain booster sans aucune Rare t\'en fait gagner un autre.' },
    { name: 'Priorité au bar', price: 90, category: 'boost',
      description: 'Tu passes devant tout le monde pour la prochaine commande.' },
    { name: 'Immunité de sommeil', price: 160, category: 'boost',
      description: 'Personne ne te réveille, ne te filme et ne te dessine dessus. Une nuit.' },
    /* --- Handicaps : ce qu'on inflige à quelqu'un --- */
    { name: 'Une seule main', price: 180, category: 'handicap', needsTarget: true,
      description: 'La victime joue une manche entière à une main.' },
    { name: 'Écran à l\'envers', price: 220, category: 'handicap', needsTarget: true,
      description: 'Une manche, l\'écran retourné. Bon courage.' },
    { name: 'Souris de compétition', price: 160, category: 'handicap', needsTarget: true,
      description: 'Sensibilité multipliée par trois pendant une manche.' },
    { name: 'Silence radio', price: 120, category: 'handicap', needsTarget: true,
      description: 'Dix minutes sans micro. Débrouille-toi avec des gestes.' },
    { name: 'Clavier maudit', price: 140, category: 'handicap', needsTarget: true,
      description: 'AZERTY devient QWERTY, ou l\'inverse. Une manche.' },
    { name: 'Personnage imposé', price: 150, category: 'handicap', needsTarget: true,
      description: 'C\'est toi qui choisis son perso. Sois cruel.' },
    { name: 'Commentateur imposé', price: 130, category: 'handicap', needsTarget: true,
      description: 'La victime commente sa partie à voix haute, en continu.' },

    /* --- Cosmétiques : ce qui reste --- */
    { name: 'Titre personnalisé', price: 400, category: 'cosmetic',
      description: 'Ton surnom sur ton profil, écrit par toi. À vie.' },
    { name: 'Baptiser un kocktail', price: 250, category: 'cosmetic',
      description: 'Un kocktail de la carte portera ton nom.' },
    { name: 'Baptiser le prochain set', price: 500, category: 'cosmetic',
      description: 'Le set de cartes de la prochaine LAN portera le nom que tu choisis.' },

    /* --- Divers --- */
    { name: 'Relancer un vote', price: 80, category: 'fun',
      description: 'Le vote en cours repart de zéro. Chaos.' },
    { name: 'Lancer un défi', price: 150, category: 'fun',
      description: 'Tu imposes un défi de la liste à qui tu veux.' }
];

/* Ce qui manque encore à la boutique, comparé à la carte de départ. On
   compare sur le nom : regarnir deux fois ne doit pas doubler les articles. */
/* Ajouts issus des règles de table : ils restent séparés de la carte historique
   afin que le regarnissage reconnaisse aussi les boutiques déjà initialisées. */
const SHOP_STARTER_ADDITIONS = [
    { name: 'Choisir un coach', price: 190, category: 'boost',
      description: 'Choisis ton coach pour une partie : conseils, stratégie et mauvaise foi inclus.' },
    { name: 'Clavier à l\'envers', price: 230, category: 'handicap', needsTarget: true,
      description: 'Le clavier est physiquement retourné pendant une manche entière.' },
    { name: 'Sans chaise', price: 210, category: 'handicap', needsTarget: true,
      description: 'Une partie complète debout. La chaise part hors de portée.' },
    { name: 'Clavier-souris inversés', price: 260, category: 'handicap', needsTarget: true,
      description: 'Souris dans l\'autre main et clavier de l\'autre côté pendant une partie.' },
    { name: 'FPS sous rationnement', price: 280, category: 'handicap', needsTarget: true,
      description: 'Le plafond de FPS est fortement réduit pour une partie, valeur choisie par le groupe.' },
    { name: 'Réquisition de stuff', price: 320, category: 'handicap', needsTarget: true,
      description: 'Emprunte le clavier ou la souris d\'un autre joueur pendant une partie, avec son accord.' },
    { name: 'Échange de setup', price: 420, category: 'handicap', needsTarget: true,
      description: 'Échange complet de place et de périphériques avec la cible pour une partie.' },
    { name: 'Rentre chez toi maintenant', price: 1500, category: 'privilege',
      description: 'Pour une somme beaucoup trop indécente, tu ordonnes à quelqu\'un de rentrer chez lui maintenant.' }
];

function starterShopItems() {
    const durationItems = [
        { name: 'Imposer le prochain jeu — partie moyenne', price: 160, category: 'privilege',
          description: 'Pour une partie de 30 à 90 minutes : un match complet, un petit tournoi, un run.' },
        { name: 'Imposer le prochain jeu — longue session', price: 300, category: 'privilege',
          description: 'Pour 1 h 30 à 3 heures : une vraie session qui bloque la table un moment.' },
        { name: 'Imposer le prochain jeu — marathon', price: 500, category: 'privilege',
          description: 'Au-delà de 3 heures, façon Civilization VI : toute la table signe pour le voyage.' }
    ];
    const adjusted = SHOP_STARTER.map(item => {
        if (item.name === 'Choisir le prochain jeu') {
            return Object.assign({}, item, {
                price: 80,
                forcePrice: true,
                description: 'Impose une partie courte, jusqu’à 30 minutes — typiquement une game de Rocket League.'
            });
        }
        if (item.name === 'Lancer un défi') {
            return Object.assign({}, item, {
                price: 350,
                forcePrice: true,
                description: 'Tu imposes un défi de la liste à qui tu veux. Le pouvoir se paie désormais très cher.'
            });
        }
        return item;
    });
    const additions = SHOP_STARTER_ADDITIONS.map(item =>
        item.name === 'Rentre chez toi maintenant'
            ? Object.assign({}, item, { needsTarget: true })
            : item);
    return adjusted.concat(durationItems, additions);
}

function missingStarterItems(economy) {
    const have = {};
    Object.entries((economy && economy.catalog) || {}).forEach(([id, item]) => {
        if (item && item.name) have[normalizeGameName(item.name)] = { id: id, item: item };
    });
    return starterShopItems().filter(item => {
        const current = have[normalizeGameName(item.name)];
        if (!current) return true;
        return item.forcePrice === true
            && Number(current.item.price) !== Number(item.price);
    });
}

/* ==========================================================================
   Les défis
   Un haut fait se calcule ; un défi se RACONTE. « Trente pompes », « une game
   de LoL avec les touches inversées », « une bière à 9 h du matin » : aucune
   donnée de l'application ne pourra jamais les vérifier. C'est donc un humain
   qui tranche, et c'est très bien — la validation devient un moment à table
   plutôt qu'un problème de base de données.

   C'est aussi ce qui manquait à la courbe d'expérience. Les hauts faits sont
   une cagnotte qu'on vide une fois ; les défis, eux, se rejouent à chaque
   soirée. Sans eux, les niveaux se figeaient vers 6 ou 7.

   Un seul système sert trois besoins qui n'en font qu'un :
     - l'admin crée des défis ;
     - un joueur en propose, et l'admin approuve ;
     - un joueur réclame l'avoir fait, et l'admin valide.
   ========================================================================== */

const CHALLENGES = {
    /* Plafonds des propositions de joueurs. Sans eux, on pourrait se proposer
       un défi à dix mille złotych — l'admin le verrait, mais autant que les
       règles le refusent. L'admin, lui, n'est pas plafonné. */
    MAX_PROPOSED_ZL: 300,
    MAX_PROPOSED_XP: 200,

    CATEGORIES: [
        { key: 'sport', label: 'Sport', icon: '💪' },
        { key: 'jeu', label: 'Jeu', icon: '🎮' },
        { key: 'boisson', label: 'Boisson', icon: '🍺' },
        { key: 'bouffe', label: 'Bouffe', icon: '🍕' },
        { key: 'autre', label: 'Autre', icon: '🎲' }
    ]
};

function challengeCategories() {
    return CHALLENGES.CATEGORIES.concat([
        { key: 'repeatable', label: 'Répétables', icon: '🔁' }
    ]);
}

function challengeCategory(key) {
    if (key === 'intellect') return { key: 'intellect', label: 'Exercices', icon: '🧠' };
    /* Compatibilité avec les défis semés sous l'ancien nom Farming. */
    if (key === 'farm') key = 'repeatable';
    return challengeCategories().find(c => c.key === key) || CHALLENGES.CATEGORIES[4];
}

function challengeMatchesCategory(challenge, key) {
    const actual = (challenge && challenge.category) || 'autre';
    return actual === key || (key === 'repeatable' && actual === 'farm');
}

/* Les défis ouverts, prêts à être relevés. Les propositions en attente et les
   défis archivés n'y sont pas. */
function openChallenges(node) {
    return Object.entries((node && node.challenges) || {})
        .map(([id, c]) => Object.assign({ id: id }, c))
        /* Les anciens exercices éventuellement déjà semés restent en base,
           mais leur nouvelle banque a désormais son écran dédié. */
        .filter(c => c.status === 'open' && c.category !== 'intellect')
        .sort((a, b) => (Number(a.zl) || 0) - (Number(b.zl) || 0));
}

/* Ce qu'un admin doit trancher : les défis proposés par les joueurs. */
function proposedChallenges(node) {
    return Object.entries((node && node.challenges) || {})
        .map(([id, c]) => Object.assign({ id: id }, c))
        .filter(c => c.status === 'proposed')
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function allClaims(node) {
    return Object.entries((node && node.claims) || {})
        .map(([id, c]) => Object.assign({ id: id }, c))
        .filter(c => c && c.uid && c.challengeId);
}

/* Ce qu'un admin doit trancher : les réclamations en attente. */
function pendingClaims(node) {
    return allClaims(node)
        .filter(c => c.status === 'pending')
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function claimsOf(node, uid) {
    return allClaims(node)
        .filter(c => c.uid === uid)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/* Un défi non répétable déjà validé (ou en attente) ne se réclame plus : sans
   ça, on encaisserait dix fois les mêmes trente pompes. */
function claimState(node, challenge, uid) {
    const mine = allClaims(node).filter(c => c.challengeId === challenge.id && c.uid === uid);
    const pending = mine.some(c => c.status === 'pending');
    const granted = mine.filter(c => c.status === 'granted').length;
    const cap = Math.max(0, Math.floor(Number(challenge.maxPerLan) || 0));

    if (pending) return { can: false, why: 'En attente de validation', pending: true, granted: granted };
    if (cap > 0 && granted >= cap) {
        return { can: false, why: 'Plafond atteint (' + cap + '/LAN)', pending: false, granted: granted };
    }
    if (!challenge.repeatable && granted > 0) {
        return { can: false, why: 'Déjà validé', pending: false, granted: granted };
    }
    return { can: true, why: '', pending: false, granted: granted };
}

/* Combien de fois ce défi a été relevé, tous joueurs confondus. Sert à montrer
   qu'un défi est vivant — un défi que personne n'a jamais tenté se voit. */
function challengeGrantedCount(node, challengeId) {
    return allClaims(node).filter(c => c.challengeId === challengeId && c.status === 'granted').length;
}

/* Ce que les défis ont rapporté à un joueur. C'est la part de son expérience
   qui ne vient ni de sa présence ni de la cagnotte des hauts faits. */
function challengeEarnings(node, uid) {
    const challenges = (node && node.challenges) || {};
    let zl = 0;
    let xp = 0;
    let count = 0;
    allClaims(node).forEach(claim => {
        if (claim.uid !== uid || claim.status !== 'granted') return;
        const challenge = challenges[claim.challengeId] || {};
        zl += Number(claim.zl != null ? claim.zl : challenge.zl) || 0;
        xp += Number(claim.xp != null ? claim.xp : challenge.xp) || 0;
        count += 1;
    });
    return { zl: zl, xp: xp, count: count };
}

/* ---------- La boîte à idées ----------
   Un champ libre, et une réponse de l'admin. Ce n'est pas un chat : une
   conversation à deux tours suffit à « j'aimerais bien qu'on ajoute X », et un
   vrai fil de discussion demanderait des non-lus, des notifications et de la
   modération pour un besoin qui tient en deux phrases. */

function allSuggestions(node) {
    return Object.entries((node && node.suggestions) || {})
        .map(([id, s]) => Object.assign({ id: id }, s))
        .filter(s => s && s.uid && s.text)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function openSuggestions(node) {
    return allSuggestions(node).filter(s => s.status !== 'done' && s.status !== 'dismissed');
}

/* ==========================================================================
   La liste de départ
   Écrite d'après les idées des joueurs. Elle n'est pas figée : l'admin en
   ajoute, les joueurs en proposent. Elle sert à ce que la première soirée ne
   commence pas devant un écran vide.

   Les récompenses suivent une règle simple : ce qui coûte un effort physique
   ou une heure de jeu paie plus qu'un shot avalé en dix secondes. Le złoty
   sert à acheter le soir même, l'XP reste pour toujours — d'où deux montants
   plutôt qu'un.

   Tous sont répétables sauf mention contraire : un défi qu'on ne peut relever
   qu'une fois dans sa vie s'épuise, et c'est justement ce qu'on veut éviter.
   ========================================================================== */

const CHALLENGE_STARTER = [
    /* --- Sport ---
       Volontairement ATTEIGNABLES. Un défi qu'on regarde en se disant « jamais
       de la vie » ne se relève pas, et une liste que personne ne touche ne
       rapporte d'expérience à personne. Dix pompes, on les fait ; trente, on
       les remet à plus tard. */
    { title: '10 pompes', category: 'sport', zl: 60, xp: 40,
      description: 'D\'affilée. Quelqu\'un compte à voix haute, et se moque si tu triches.' },
    { title: '3 tractions', category: 'sport', zl: 70, xp: 45,
      description: 'Menton au-dessus de la barre. Trois, pas deux et demie.' },
    { title: 'La chaise, 1 minute', category: 'sport', zl: 70, xp: 45,
      description: 'Dos au mur, cuisses à l\'horizontale. Une minute complète. Ça paraît court.' },
    { title: 'Gagner un bras de fer', category: 'sport', zl: 70, xp: 45,
      description: 'Contre qui tu veux dans la soirée. Le perdant confirme, la mort dans l\'âme.' },
    { title: 'Une pompe entre chaque manche', category: 'sport', zl: 120, xp: 80,
      description: 'Toute une session. Une pompe après chaque partie perdue. Deux si tu râles.' },
    { title: '2 km de course', category: 'sport', zl: 110, xp: 70,
      description: 'Pendant la LAN. Capture d\'écran de la montre ou de l\'appli.' },
    { title: 'Un tour du pâté de maisons', category: 'sport', zl: 80, xp: 50,
      description: 'À pied, dehors, en pleine LAN. Le monde extérieur existe encore.' },

    /* La piscine. Elle est là, autant s'en servir — mais à jeun et jamais seul :
       un défi qui envoie quelqu'un dans l'eau après trois verres n'est pas un
       défi, et aucune récompense ne vaut ça. Le témoin sur le bord fait partie
       de la règle, pas de la décoration. */
    { title: 'Le plongeon des braves', category: 'sport', zl: 80, xp: 50,
      description: 'Dans l\'eau d\'un coup, sans tremper l\'orteil d\'abord. À jeun. Un témoin sur le bord.' },
    { title: 'Vingt longueurs', category: 'sport', zl: 130, xp: 80,
      description: 'En une fois, à l\'heure que tu veux. À jeun, et quelqu\'un compte depuis le bord.' },
    { title: 'L\'apnée de la soirée', category: 'sport', zl: 90, xp: 55,
      description: 'Le meilleur temps sous l\'eau. Deux témoins, dont un qui ne rigole pas.' },
    { title: 'La baignade de l\'aube', category: 'sport', zl: 140, xp: 90,
      description: 'Dans l\'eau au lever du jour, après une nuit blanche. À jeun. Quelqu\'un reste au bord.' },
    { title: 'Le sauvetage du canard', category: 'sport', zl: 60, xp: 40,
      description: 'Quelqu\'un lance un objet qui flotte au milieu. Tu vas le chercher. Habillé.' },

    /* --- Jeu --- */
    { title: 'Une manche à une main', category: 'jeu', zl: 90, xp: 55,
      description: 'L\'autre main reste sur la table. Une manche entière.' },
    { title: 'Build imposé', category: 'jeu', zl: 110, xp: 70,
      description: 'Un autre joueur choisit tes objets, un par un, pendant la partie.' },
    { title: 'Perso choisi par un autre', category: 'jeu', zl: 90, xp: 55,
      description: 'Quelqu\'un d\'autre choisit ton personnage. Il a le droit d\'être méchant.' },
    { title: 'Run de roguelite sans [au choix]', category: 'jeu', zl: 140, xp: 85,
      description: 'Finir un run privé de quelque chose : une arme, un objet, une touche. Annonce la contrainte avant.' },
    { title: 'Roguelite à quatre mains', category: 'jeu', zl: 180, xp: 110,
      description: 'Un joueur à la souris, l\'autre au clavier, même run. Les deux touchent la récompense.' },
    { title: 'Touches remappées', category: 'jeu', zl: 150, xp: 90,
      description: 'Quelqu\'un échange deux touches avant la partie. Tu joues avec, sans les remettre.' },
    { title: 'Clavier retourné', category: 'jeu', zl: 170, xp: 100,
      description: 'AZERTY passé en QWERTY, une partie complète. Regarder ses doigts ne sert plus à rien.' },
    { title: 'Gagner en aveugle', category: 'jeu', zl: 250, xp: 130,
      description: 'Une manche, l\'écran retourné ou les yeux bandés. Un copilote a le droit de parler. Pas de te toucher.' },
    { title: 'Sans interface', category: 'jeu', zl: 120, xp: 75,
      description: 'HUD coupé : pas de vie, pas de munitions, pas de minimap. Une partie entière.' },
    { title: 'Le pilote et le copilote', category: 'jeu', zl: 130, xp: 80,
      description: 'Quelqu\'un derrière toi donne les ordres. Tu exécutes sans discuter, même les mauvais.' },
    { title: 'Annoncer la victoire', category: 'jeu', zl: 160, xp: 95,
      description: 'Tu annonces que tu gagnes, avant la partie, devant tout le monde. Si tu perds, tu paies la tournée.' },
    { title: 'Le boulet volontaire', category: 'jeu', zl: 140, xp: 85,
      description: 'Tu prends la classe, le perso ou l\'arme dont personne ne veut. Et tu finis dans les trois premiers.' },
    { title: 'Une partie sans son', category: 'jeu', zl: 90, xp: 55,
      description: 'Casque débranché, volume à zéro. Une partie complète, sans râler.' },
    { title: 'Commentateur en direct', category: 'jeu', zl: 100, xp: 60,
      description: 'Tu commentes ta propre partie à voix haute, sans t\'arrêter. Ton de match télévisé exigé.' },
    { title: 'Debout toute la partie', category: 'jeu', zl: 110, xp: 70,
      description: 'Une partie entière jouée debout. Chaise repoussée, pas de triche.' },
    { title: 'Chaque mort, une gorgée', category: 'jeu', zl: 100, xp: 60,
      description: 'Une gorgée à chaque mort, toute la session. De l\'eau compte aussi, on n\'est pas des animaux.' },

    /* --- Boisson --- */
    { title: 'Une bière à 9 h du matin', category: 'boisson', zl: 80, xp: 50,
      description: 'Avec le pain au chocolat. C\'est le petit-déjeuner officiel de la LAN.' },
    { title: 'Un shot dans les 10 min du réveil', category: 'boisson', zl: 100, xp: 60,
      description: 'Un témoin obligatoire, et il doit être réveillé aussi.' },
    { title: 'Boire un one-shot inventé ce soir', category: 'boisson', zl: 70, xp: 45,
      description: 'Un kocktail de la carte « one-shot ». En entier. Sans grimacer, si possible.' },
    { title: 'Cul sec de l\'infâme', category: 'boisson', zl: 130, xp: 80,
      description: 'Quelqu\'un compose le verre avec ce qu\'il trouve. Buvable, mais à peine.' },
    { title: 'Deux litres d\'eau dans la soirée', category: 'boisson', zl: 70, xp: 45,
      description: 'Oui, c\'est un défi. Non, la bière ne compte pas.' },
    { title: 'La tournée du perdant', category: 'boisson', zl: 110, xp: 70,
      description: 'Une session entière : à chaque défaite, tu sers un verre à quelqu\'un d\'autre. Jamais deux fois le même.' },
    { title: 'Le mot interdit', category: 'boisson', zl: 90, xp: 55,
      description: 'Le groupe choisit un mot. Chaque fois qu\'il sort de ta bouche, une gorgée. Deux heures.' },
    { title: 'Le barman de la nuit', category: 'boisson', zl: 120, xp: 75,
      description: 'Tu tiens le bar une heure. Tout le monde est servi, personne n\'attend, et toi tu ne bois pas.' },
    { title: 'Le verre du dernier', category: 'boisson', zl: 100, xp: 60,
      description: 'Le dernier éliminé d\'une manche boit. Toi, tu tiens le compte de la soirée sans te tromper.' },

    /* --- Autre --- */
    { title: 'Tenir jusqu\'à 4 h du matin', category: 'autre', zl: 120, xp: 75,
      description: 'Debout, éveillé, et capable de tenir une conversation suivie.' },
    { title: 'Se lever avant 9 h', category: 'autre', zl: 100, xp: 60,
      description: 'Après une nuit de LAN. Un témoin confirme que tu étais vertical.' },
    { title: 'Le réveil du groupe', category: 'autre', zl: 110, xp: 70,
      description: 'Tu annonces une heure la veille. Le lendemain, tu lèves tout le monde à la minute près.' },
    { title: 'Une heure sans écran', category: 'autre', zl: 100, xp: 60,
      description: 'Aucun écran. Le téléphone est un écran. La montre aussi.' },
    { title: 'Accent imposé pendant une heure', category: 'autre', zl: 110, xp: 70,
      description: 'Quelqu\'un choisit l\'accent. Une heure. Y compris au téléphone.' },
    { title: 'Vouvoyer tout le monde', category: 'autre', zl: 80, xp: 50,
      description: 'Deux heures. « Vous » à tout le monde, y compris en pleine rage.' },
    { title: 'Le photographe officiel', category: 'autre', zl: 90, xp: 55,
      description: 'Dix photos de la soirée, dont une de chacun. Personne n\'est prévenu.' },
    { title: 'DJ imposé', category: 'autre', zl: 100, xp: 60,
      description: 'Tu tiens la musique une heure, et tu acceptes une demande de chaque personne présente.' },
    { title: 'Ranger la table de tout le monde', category: 'autre', zl: 90, xp: 55,
      description: 'Sans rien casser, sans se plaindre. Quelqu\'un valide le résultat.' },
    { title: 'Le discours de minuit', category: 'autre', zl: 130, xp: 80,
      description: 'Trente secondes debout sur une chaise, à minuit pile, sur un sujet donné dix secondes avant.' }
];

/* Ce qui manque encore, comparé à la liste de départ. On compare sur le titre :
   regarnir deux fois ne doit pas doubler les défis. */

/* Les exercices ne sont plus des défis semés en base : l'interface en tire un
   dans cette banque, puis envoie la réponse au maître du jeu comme une
   réclamation ordinaire. */
const EXERCISE_TYPES = [
    { key: 'math', label: 'Maths', icon: '➗' },
    { key: 'orthographe', label: 'Orthographe', icon: '✍️' },
    { key: 'culture', label: 'Culture G', icon: '🌍' }
];

const EXERCISE_BANK = [
    { id: 'math-17x6', type: 'math', label: 'Multiplication express',
      prompt: 'Combien font 17 × 6 ?', solution: '102', zl: 12, xp: 6 },
    { id: 'math-priority', type: 'math', label: 'Priorités opératoires',
      prompt: 'Calcule 144 ÷ 12 + 7.', solution: '19', zl: 12, xp: 6 },
    { id: 'math-percent', type: 'math', label: 'Pourcentage',
      prompt: 'Combien représentent 15 % de 240 ?', solution: '36', zl: 15, xp: 8 },
    { id: 'math-sequence', type: 'math', label: 'Suite logique',
      prompt: 'Quel nombre vient après 2, 6, 12, 20, 30 ?', solution: '42', zl: 15, xp: 8 },
    { id: 'math-equation', type: 'math', label: 'Petite équation',
      prompt: 'Résous 3x + 7 = 28.', solution: 'x = 7', zl: 15, xp: 8 },
    { id: 'math-die', type: 'math', label: 'Probabilité',
      prompt: 'Avec un dé à six faces, quelle est la probabilité d’obtenir strictement plus que 4 ?',
      solution: '2/6, soit 1/3', zl: 20, xp: 10 },

    { id: 'ortho-fini', type: 'orthographe', label: 'Passé composé',
      prompt: 'Complète : « Ils ___ (finir) avant minuit. »', solution: 'ont fini', zl: 12, xp: 6 },
    { id: 'ortho-avais', type: 'orthographe', label: 'Imparfait',
      prompt: 'Complète : « Si j’___ le temps, je rejouerais. »', solution: 'avais', zl: 12, xp: 6 },
    { id: 'ortho-branchees', type: 'orthographe', label: 'Accord du participe',
      prompt: 'Complète : « Les souris que j’ai ___ fonctionnent. » (brancher)',
      solution: 'branchées', zl: 18, xp: 9 },
    { id: 'ortho-fasses', type: 'orthographe', label: 'Subjonctif',
      prompt: 'Complète : « Il faut que tu ___ une pause. » (faire)', solution: 'fasses', zl: 15, xp: 8 },
    { id: 'ortho-ca', type: 'orthographe', label: 'Correction éclair',
      prompt: 'Corrige : « Sa c’est une belle victoire. »', solution: 'Ça, c’est une belle victoire.', zl: 12, xp: 6 },
    { id: 'ortho-quelques', type: 'orthographe', label: 'Quelque ou quelques',
      prompt: 'Complète : « Il reste ___ minutes avant la partie. »',
      solution: 'quelques', zl: 12, xp: 6 },

    { id: 'culture-australia', type: 'culture', label: 'Capitales',
      prompt: 'Quelle est la capitale de l’Australie ?', solution: 'Canberra', zl: 12, xp: 6 },
    { id: 'culture-au', type: 'culture', label: 'Table périodique',
      prompt: 'Quel élément chimique porte le symbole Au ?', solution: 'L’or', zl: 12, xp: 6 },
    { id: 'culture-1984', type: 'culture', label: 'Littérature',
      prompt: 'Qui a écrit 1984 ?', solution: 'George Orwell', zl: 12, xp: 6 },
    { id: 'culture-ocean', type: 'culture', label: 'Géographie',
      prompt: 'Quel est le plus grand océan du monde ?', solution: 'L’océan Pacifique', zl: 12, xp: 6 },
    { id: 'culture-foot', type: 'culture', label: 'Sport',
      prompt: 'Combien de joueurs une équipe de football aligne-t-elle sur le terrain ?',
      solution: '11', zl: 12, xp: 6 },
    { id: 'culture-zloty', type: 'culture', label: 'Question maison',
      prompt: 'Quelle est la monnaie officielle de la Pologne ?', solution: 'Le złoty', zl: 10, xp: 5 }
];

function exerciseType(key) {
    return EXERCISE_TYPES.find(type => type.key === key) || EXERCISE_TYPES[0];
}

function exercisesByType(type) {
    return EXERCISE_BANK.filter(exercise => exercise.type === type);
}

function exerciseAsChallenge(exercise) {
    const type = exerciseType(exercise.type);
    return {
        id: 'exercise__' + exercise.id,
        title: type.label + ' · ' + exercise.label,
        description: exercise.prompt,
        category: 'intellect',
        zl: exercise.zl,
        xp: exercise.xp,
        repeatable: false,
        maxPerLan: 1,
        exercisePrompt: exercise.prompt,
        exerciseSolution: exercise.solution,
        exerciseType: type.label
    };
}

/* Farming : des micro-moments drôles et fréquents, mais chacun est plafonné
   pour que le farm reste un condiment. La présence seule reste la principale
   rente fiable de la soirée. */
const CHALLENGE_FARM_STARTER = [
    { title: 'Boire une bière', category: 'farm', zl: 10, xp: 2, maxPerLan: 3,
      description: 'Une bière, avec ou sans alcool. Pas de cul-sec : le farm n’est pas un concours de vitesse.' },
    { title: 'Grand verre d’eau', category: 'farm', zl: 5, xp: 1, maxPerLan: 5,
      description: 'Un vrai grand verre. Le farm hydratation finance les mauvaises idées suivantes.' },
    { title: 'GG sans ironie', category: 'farm', zl: 5, xp: 1, maxPerLan: 5,
      description: 'Félicite sincèrement le joueur qui vient de te rouler dessus.' },
    { title: 'Défaite avec panache', category: 'farm', zl: 8, xp: 2, maxPerLan: 5,
      description: 'Perds une partie sans accuser le jeu, la connexion, la chaise ou Mercure rétrograde.' },
    { title: 'Revanche immédiate gagnée', category: 'farm', zl: 12, xp: 3, maxPerLan: 4,
      description: 'Perds, relance immédiatement le même adversaire, puis gagne.' },
    { title: 'Sauvetage de coéquipier', category: 'farm', zl: 8, xp: 2, maxPerLan: 5,
      description: 'Sauve ou relève un coéquipier au moment où tout semblait perdu.' },
    { title: 'Faire rire la table', category: 'farm', zl: 10, xp: 2, maxPerLan: 5,
      description: 'Un vrai rire collectif. Montrer un même n’est accepté qu’une fois.' },
    { title: 'Dépannage express', category: 'farm', zl: 15, xp: 4, maxPerLan: 3,
      description: 'Aide quelqu’un à installer, lancer ou réparer son jeu sans soupirer trop fort.' },
    { title: 'Ravitaillement partagé', category: 'farm', zl: 10, xp: 2, maxPerLan: 3,
      description: 'Ramène un snack ou une tournée d’eau à la table.' },
    { title: 'Ramassage de la honte', category: 'farm', zl: 15, xp: 4, maxPerLan: 2,
      description: 'Ramasse les canettes, verres et emballages de tout le groupe.' },
    { title: 'Changer de place', category: 'farm', zl: 8, xp: 2, maxPerLan: 3,
      description: 'Prête ta place ou ton périphérique cinq minutes à quelqu’un qui veut tester.' },
    { title: 'Victoire au dernier souffle', category: 'farm', zl: 12, xp: 3, maxPerLan: 4,
      description: 'Gagne avec presque plus de vie, de temps ou de dignité.' }
];

const CHALLENGE_REPEATABLE_ADDITIONS = [
    { title: 'Un verre d’alcool fort', category: 'repeatable', zl: 15, xp: 3,
      description: 'Une dose standard, tranquillement — pas cul sec. Le maître du jeu refuse les enchaînements douteux.' },
    { title: 'Un shot de la maison', category: 'repeatable', zl: 12, xp: 3,
      description: 'Un shot servi par le groupe. Une seule dose à la fois, et jamais comme course de vitesse.' },
    { title: 'Boire un kocktail maison', category: 'repeatable', zl: 12, xp: 3,
      description: 'Un kocktail de la carte, avec ou sans alcool, terminé normalement.' },
    { title: 'Tchin collectif', category: 'repeatable', zl: 8, xp: 2,
      description: 'Réunis au moins quatre personnes pour un vrai tchin synchronisé.' }
];

function repeatableStarterChallenges() {
    return CHALLENGE_FARM_STARTER.concat(CHALLENGE_REPEATABLE_ADDITIONS)
        .map(challenge => {
            const adjusted = Object.assign({}, challenge, {
                category: 'repeatable',
                repeatable: true
            });
            /* La bière est volontairement sans plafond applicatif. Chaque
               occurrence passe tout de même par la validation humaine. */
            if (challenge.title === 'Boire une bière') {
                delete adjusted.maxPerLan;
                adjusted.forceUnlimited = true;
            }
            return adjusted;
        });
}

function missingStarterChallenges(node) {
    const have = {};
    Object.entries((node && node.challenges) || {}).forEach(([id, challenge]) => {
        if (challenge && challenge.title) {
            have[normalizeGameName(challenge.title)] = { id: id, challenge: challenge };
        }
    });
    return CHALLENGE_STARTER.concat(repeatableStarterChallenges())
        .filter(c => {
            const current = have[normalizeGameName(c.title)];
            if (!current) return true;
            return c.forceUnlimited === true
                && Number(current.challenge.maxPerLan) > 0;
        });
}
