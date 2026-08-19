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
