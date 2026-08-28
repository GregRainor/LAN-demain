// Détails enrichis d'un jeu Steam : résumé FR, prix EUR, genres, tags et bande-annonce.
// Accepte ?appid=1091500 (direct) ou ?name=cyberpunk (recherche d'abord).
// Comme get-game-image, tout est mis en cache sur le CDN Vercel : sans ça, chaque
// visiteur qui ouvre une fiche déclenche un appel serverless -> Steam.

// Les fiches contiennent aussi le prix Steam : une journée de cache rendait les
// promotions trompeuses. Quinze minutes gardent les appels raisonnables sans
// figer une remise après son début ou sa fin.
const CACHE_HEADER = 'public, s-maxage=900, stale-while-revalidate=3600';

// Normalise pour comparer : minuscules, sans accents, sans ™/®, sans ponctuation
function normalize(str) {
    return String(str)
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[™®©]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// Retrouve l'appId à partir d'un nom.
// Prendre le premier résultat est trompeur : « minecraft » renvoie Minecraft
// Dungeons, « league of legends » renvoie Ruined King. On exige donc une
// correspondance exacte, et on signale au client quand ce n'est qu'une approximation.
async function findApp(gameName) {
    const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=french&cc=fr`;
    const res = await fetch(searchUrl);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.total || !Array.isArray(data.items) || data.items.length === 0) return null;

    const target = normalize(gameName);
    const exact = data.items.find(item => normalize(item.name) === target);
    if (exact) return { id: exact.id, exactMatch: true };

    return { id: data.items[0].id, exactMatch: false };
}

// Steam ne fournit plus de mp4/webm direct : les bandes-annonces sont servies
// en HLS (.m3u8) et DASH (.mpd). Seul Safari lit le HLS nativement dans une
// balise <video> ; ailleurs il faudrait hls.js. On renvoie donc aussi la
// vignette, que le client utilise comme repli sans dépendance externe.
function pickTrailer(movies) {
    if (!Array.isArray(movies) || movies.length === 0) return null;
    const m = movies[0];
    return {
        name: m.name || null,
        thumbnail: m.thumbnail || null,
        hls: m.hls_h264 || null,
        dash: m.dash_h264 || null
    };
}

import { guard } from './_guard.js';

export default async function handler(request, response) {
    // Endpoint public (données Steam publiques) : contrôle d'origine seul,
    // pas de rate-limit — la marquee tire beaucoup d'images en rafale.
    if (guard(request, response)) return;

    const { appid, name } = request.query;

    if (!appid && !name) {
        return response.status(400).json({ error: 'Un appid ou un nom de jeu est requis' });
    }

    try {
        const match = appid ? { id: appid, exactMatch: true } : await findApp(name);
        if (!match) {
            return response.status(404).json({ error: 'Jeu non trouvé sur Steam' });
        }
        const resolvedAppId = match.id;

        const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(resolvedAppId)}&l=french&cc=fr`;
        const steamResponse = await fetch(detailsUrl);

        if (!steamResponse.ok) {
            return response.status(steamResponse.status).json({ error: 'Erreur de l\'API Steam' });
        }

        const payload = await steamResponse.json();
        const entry = payload && payload[resolvedAppId];

        if (!entry || !entry.success || !entry.data) {
            return response.status(404).json({ error: 'Détails indisponibles pour ce jeu' });
        }

        const d = entry.data;

        // Genres et catégories forment nos "tags" : les vrais tags communautaires
        // ne sont pas exposés par l'API officielle.
        const genres = Array.isArray(d.genres) ? d.genres.map(g => g.description) : [];
        const categories = Array.isArray(d.categories) ? d.categories.map(c => c.description) : [];

        let price = null;
        if (d.is_free) {
            price = { free: true, formatted: 'Gratuit', discountPercent: 0 };
        } else if (d.price_overview) {
            price = {
                free: false,
                formatted: d.price_overview.final_formatted || null,
                initialFormatted: d.price_overview.initial_formatted || null,
                discountPercent: d.price_overview.discount_percent || 0
            };
        }

        response.setHeader('Cache-Control', CACHE_HEADER);

        return response.status(200).json({
            appId: resolvedAppId,
            // false => le jeu demandé n'existe pas tel quel sur Steam et ce
            // résultat est une approximation (à ne pas présenter comme la fiche du jeu)
            exactMatch: match.exactMatch,
            name: d.name,
            shortDescription: d.short_description || '',
            headerImage: d.header_image || null,
            genres,
            categories,
            price,
            trailer: pickTrailer(d.movies),
            steamUrl: `https://store.steampowered.com/app/${resolvedAppId}/`
        });

    } catch (error) {
        console.error('Erreur interne du serveur:', error);
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
