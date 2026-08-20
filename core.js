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

function buildLanIcs(settings) {
    const config = settings || {};
    const schedule = describeLanSchedule(config, new Date());
    if (!schedule || !schedule.startKey) return null;

    const name = (config.lanName || 'LAN Demain').trim();
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//LAN Demain//Programme//FR',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:lan-${schedule.startKey}-${Math.random().toString(36).slice(2, 10)}@lan-demain`,
        `DTSTAMP:${icsDateTime(new Date())}`,
        `SUMMARY:${icsEscape(name)}`
    ];

    if (schedule.time && schedule.startsAt) {
        // Sans heure de fin annoncée on réserve la soirée : six heures, plutôt
        // qu'un créneau d'une heure qui ne dirait rien de juste.
        const endDate = new Date(schedule.startsAt.getTime());
        endDate.setHours(endDate.getHours() + 6);
        lines.push(`DTSTART:${icsDateTime(schedule.startsAt)}`);
        lines.push(`DTEND:${icsDateTime(endDate)}`);
    } else {
        // En journée entière, DTEND est exclusif : il pointe le lendemain.
        const lastKey = schedule.endKey || schedule.startKey;
        lines.push(`DTSTART;VALUE=DATE:${schedule.startKey.replace(/-/g, '')}`);
        lines.push(`DTEND;VALUE=DATE:${shiftDayKey(lastKey, 1).replace(/-/g, '')}`);
    }

    if (schedule.place) lines.push(`LOCATION:${icsEscape(schedule.place)}`);
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
    CURRENCY: 'PO',
    CATEGORIES: [
        { key: 'privilege', label: 'Privilèges', icon: '👑' },
        { key: 'handicap', label: 'Handicaps', icon: '🎯' },
        { key: 'cosmetic', label: 'Cosmétiques', icon: '✨' },
        { key: 'fun', label: 'Divers', icon: '🎲' }
    ]
};

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

function ledgerTotal(economy, uid) {
    const ledger = (economy && economy.ledger) || {};
    let total = 0;
    Object.values(ledger).forEach(entry => {
        if (entry && entry.uid === uid) total += Number(entry.delta) || 0;
    });
    return total;
}

/* Le solde qui fait foi : registre + présence. */
function economyBalance(economy, uid) {
    if (!uid) return 0;
    return ledgerTotal(economy, uid) + tickPoints(economy, uid);
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
    return economyBalance(economy, uid) - pendingSpend(economy, uid);
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
    FLEX_SHOWCASE: 0.08,
    FLEX_EPIC: 0.25,
    /* L'emplacement brillant penche vers le bas du set : sa surprise est
       qu'une commune sorte holographique, pas qu'elle sorte prestige. */
    FOIL_SLOT_WEIGHTS: { common: 60, uncommon: 25, rare: 10, epic: 4, showcase: 1 },

    /* Filet de consolation : une prestige garantie au bout de N paquets
       ouverts sans. Riftbound n'en a pas ; entre amis, une longue série sèche
       fait juste décrocher. */
    PITY: 8,
    /* Plafond par côté d'un échange. Six cartes tiennent sur un écran de
       téléphone, et une proposition qu'on ne lit pas ne s'accepte pas. */
    TRADE_MAX: 6,

    /* Du plus rare au plus commun. `share` est la part du set, reprise des
       proportions d'Origins. */
    RARITIES: [
        { key: 'showcase', label: 'Prestige',    short: 'PRS', share: 0.153 },
        { key: 'epic',     label: 'Épique',      short: 'EPQ', share: 0.119 },
        { key: 'rare',     label: 'Rare',        short: 'RAR', share: 0.238 },
        { key: 'uncommon', label: 'Peu commune', short: 'PCO', share: 0.238 },
        { key: 'common',   label: 'Commune',     short: 'COM', share: 0.252 }
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

/* Chemin de l'illustration dessinée, ou null pour retomber sur Steam. */
function cardArt(gameKey) {
    const file = TCG.ART[gameKey];
    return file ? 'cards/' + file : null;
}

/* --------------------------------------------------------------------------
   Composer le set
   -------------------------------------------------------------------------- */

/* Tous les jeux qu'on connaît au-delà de ceux qui ont été votés : les
   bibliothèques Steam du groupe, et les soirées passées. C'est ce qui donne au
   set sa profondeur. Un set de trente cartes se complète en trois boosters et
   n'a plus rien à raconter ; une bibliothèque de groupe en fournit plusieurs
   centaines. Le vote garde la main sur la rareté : ce que les joueurs ont
   demandé occupe le haut du set, ce qui dort dans les bibliothèques en forme
   le fond. */
function knownGameNames(sources) {
    const names = new Map();
    const add = (name) => {
        const key = cardKey(name);
        if (!key || names.has(key)) return;
        names.set(key, String(name).trim().replace(/\s+/g, ' '));
    };

    Object.values((sources && sources.libraries) || {}).forEach(library => {
        const games = (library && library.games) || [];
        // Firebase rend parfois un tableau creux sous forme d'objet.
        Object.values(Array.isArray(games) ? games : games).forEach(game => {
            if (game && game.name) add(game.name);
        });
    });

    Object.values((sources && sources.history) || {}).forEach(lan => {
        const top = (lan && lan.topGames) || [];
        Object.values(Array.isArray(top) ? top : top).forEach(game => {
            if (game && game.name) add(game.name);
        });
    });

    return Array.from(names.values());
}

/* Le set de la soirée. Le classement des votes occupe le haut, les jeux
   seulement connus des bibliothèques remplissent le reste, et la part de
   chaque rareté est celle d'Origins.

   Deux règles de justice :
   - deux jeux à égalité de votes prennent la même rareté, la plus basse du
     groupe. Sans ça, un set où tout le monde a un point deviendrait
     entièrement prestige ;
   - les jeux sans vote échappent à cette règle. Ils sont tous à zéro, et les
     regrouper ferait de tout le bas du set une seule rareté. On les range
     dans un ordre tiré de leur nom : stable d'un client à l'autre, mais sans
     rapport avec l'alphabet — sinon toutes les prestiges iraient aux jeux qui
     commencent par A. */
function buildCardSet(scores, extraNames) {
    const byKey = new Map();

    (scores || []).forEach(game => {
        if (!game || !game.name) return;
        const key = cardKey(game.name);
        if (!key) return;
        const score = Number(game.score) || 0;
        const known = byKey.get(key);
        if (!known || score > known.score) {
            byKey.set(key, { key, name: String(game.name).trim().replace(/\s+/g, ' '), score });
        }
    });

    (extraNames || []).forEach(name => {
        const key = cardKey(name);
        if (!key || byKey.has(key)) return;
        byKey.set(key, { key, name: String(name).trim().replace(/\s+/g, ' '), score: 0 });
    });

    const all = Array.from(byKey.values());
    const ranked = all.filter(game => game.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr'))
        .concat(all.filter(game => game.score <= 0)
            .sort((a, b) => tcgHash(a.key) - tcgHash(b.key) || (a.key < b.key ? -1 : 1)));

    const total = ranked.length;
    if (!total) return {};

    const bands = new Array(total);
    let index = 0;
    let cumulative = 0;
    TCG.RARITIES.forEach((rarity, i) => {
        cumulative += rarity.share;
        const isLast = i === TCG.RARITIES.length - 1;
        /* On réserve une place à chacune des raretés qui suivent : sur un set
           de six jeux, un arrondi naïf laisserait des raretés vides et les
           boosters n'auraient plus rien à tirer. */
        const room = total - (TCG.RARITIES.length - 1 - i);
        const upTo = isLast ? total : Math.max(index + 1, Math.min(room, Math.round(total * cumulative)));
        while (index < upTo) bands[index++] = i;
    });

    let start = 0;
    while (start < total) {
        let end = start + 1;
        if (ranked[start].score > 0) {
            while (end < total && ranked[end].score === ranked[start].score) end++;
            const band = bands[end - 1];
            for (let j = start; j < end; j++) bands[j] = band;
        }
        start = end;
    }

    const cards = {};
    ranked.forEach((game, i) => {
        cards[game.key] = { name: game.name, rarity: TCG.RARITIES[bands[i]].key, score: game.score };
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

/* Le sceau d'un paquet : son identifiant, l'horodatage serveur de son achat,
   et son propriétaire. Aucun des trois ne peut être rejoué à volonté — le
   nœud du paquet est en écriture unique. */
function packSeed(packId, pack) {
    return tcgHash(packId + '|' + ((pack && pack.sealedAt) || 0) + '|' + ((pack && pack.uid) || ''));
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
            if (opts.pity) rarity = nearest('showcase');
            else if (roll < TCG.FLEX_SHOWCASE) rarity = nearest('showcase');
            else if (roll < TCG.FLEX_SHOWCASE + TCG.FLEX_EPIC) rarity = nearest('epic');
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
        streak = drawn.some(card => card.rarity === 'showcase') ? 0 : streak + 1;
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
        streaks[pack.uid] = drawn.some(card => card.rarity === 'showcase') ? 0 : streak + 1;

        drawn.forEach(card => {
            cards.push({
                id: pack.id + '#' + card.slot,
                packId: pack.id,
                setId: pack.setId || '',
                slot: card.slot,
                gameKey: card.gameKey,
                name: (set[card.gameKey] && set[card.gameKey].name) || card.gameKey,
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
                copies,
                owned: copies.length > 0,
                foil: copies.some(copy => copy.foil)
            };
        })
        .sort((a, b) => rarityIndex(a.rarity) - rarityIndex(b.rarity)
            || b.score - a.score
            || a.name.localeCompare(b.name, 'fr'));
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
    const catalog = (economy && economy.catalog) || {};
    return Object.entries((economy && economy.purchases) || {})
        .map(([id, purchase]) => Object.assign({ id }, purchase))
        .filter(purchase => purchase.uid === uid
            && purchase.status === 'granted'
            && isPackItem(catalog[purchase.itemId])
            && !packs[purchase.id])
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}
