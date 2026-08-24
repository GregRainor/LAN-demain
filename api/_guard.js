// Garde partagée par les endpoints /api/*.
//
// Les fonctions étaient totalement ouvertes : n'importe qui sur Internet pouvait
// les appeler comme un proxy gratuit et consommer STEAM_API_KEY / ITAD_API_KEY.
// Deux défenses, sans toucher au client (les requêtes de l'app passent telles quelles) :
//
//   1. Liste blanche d'origine : bloque l'usage cross-site (ces endpoints
//      embarqués comme API gratuite sur un autre site). Un navigateur envoie
//      Origin (CORS/POST) ou au moins Referer sur une requête same-origin.
//   2. Rate-limit best-effort par IP, réservé aux endpoints qui consomment une
//      clé payante. Volontairement absent des endpoints publics/en rafale
//      (la marquee tire ~25 images), car une LAN partage souvent UNE IP
//      publique (NAT du lieu) : throttler à l'IP y couperait toute la soirée.
//
// Limite connue : l'état mémoire est par instance chaude (serverless), donc le
// rate-limit n'est pas dur et un abus distribué le contourne. Pour une limite
// dure, brancher un store partagé (Vercel KV / Upstash). L'origine, elle, est
// spoofable via curl : c'est une défense contre l'abus navigateur cross-site,
// complétée par le rate-limit sur les endpoints à clé.

const ALLOWED_HOSTS = ['lan-demain.vercel.app'];

// Les preview du projet, et elles seules. L'ancienne règle acceptait tout
// `*.vercel.app` : n'importe quel site hébergé chez Vercel passait la garde.
const PREVIEW_PREFIX = 'lan-demain-';

const WINDOW_MS = 60_000;
const buckets = new Map(); // ip -> { count, resetAt }

function hostAllowed(value) {
    try {
        const host = new URL(value).host;
        if (ALLOWED_HOSTS.includes(host)) return true;
        return host.startsWith(PREVIEW_PREFIX) && host.endsWith('.vercel.app');
    } catch (_e) {
        return false;
    }
}

// options.strict : exiger une provenance explicite. La page pose
// `Referrer-Policy: strict-origin-when-cross-origin`, qui envoie l'URL
// complète en Referer sur une requête same-origin : les appels de
// l'application en portent donc toujours un. Sans ce mode, un simple
// `curl` sans en-tête passait — gratuit sur les endpoints publics, mais
// c'est une clé payante qui partait sur les autres.
function sameOrigin(req, strict) {
    const origin = req.headers.origin;
    if (origin) return hostAllowed(origin);
    const referer = req.headers.referer;
    if (referer) return hostAllowed(referer);
    return !strict;
}

function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimited(req, limit) {
    const ip = clientIp(req);
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, resetAt: now + WINDOW_MS };
        buckets.set(ip, bucket);
    }
    bucket.count++;

    // Nettoyage opportuniste : évite une croissance mémoire non bornée
    if (buckets.size > 5000) {
        for (const [key, value] of buckets) if (now > value.resetAt) buckets.delete(key);
    }

    return bucket.count > limit ? Math.ceil((bucket.resetAt - now) / 1000) : 0;
}

// Renvoie true si la requête a été refusée (et la réponse déjà envoyée).
// options.limit : requêtes/minute/IP autorisées (omis => pas de throttle).
// options.strict : refuser une requête sans Origin ni Referer.
export function guard(req, res, options = {}) {
    if (!sameOrigin(req, options.strict)) {
        res.status(403).json({ error: 'Origine non autorisée' });
        return true;
    }

    if (options.limit) {
        const retryAfter = rateLimited(req, options.limit);
        if (retryAfter) {
            res.setHeader('Retry-After', String(retryAfter));
            res.status(429).json({ error: 'Trop de requêtes, réessayez dans un instant' });
            return true;
        }
    }

    return false;
}
