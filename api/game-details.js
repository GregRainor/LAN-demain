// Détails enrichis d'un jeu Steam : résumé FR, prix EUR, genres, tags et bande-annonce.
// Accepte ?appid=1091500 (direct) ou ?name=cyberpunk (recherche d'abord).
// Comme get-game-image, tout est mis en cache sur le CDN Vercel : sans ça, chaque
// visiteur qui ouvre une fiche déclenche un appel serverless -> Steam.

const CACHE_HEADER = 'public, s-maxage=86400, stale-while-revalidate=604800';

// Retrouve l'appId à partir d'un nom, via le même endpoint public que get-game-image
async function findAppId(gameName) {
    const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=french&cc=fr`;
    const res = await fetch(searchUrl);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.total > 0 && Array.isArray(data.items) && data.items.length > 0) {
        return data.items[0].id;
    }
    return null;
}

// Steam expose plusieurs résolutions ; on prend la 480p (légère) et on garde max en secours
function pickTrailer(movies) {
    if (!Array.isArray(movies) || movies.length === 0) return null;
    const m = movies[0];
    return {
        name: m.name || null,
        thumbnail: m.thumbnail || null,
        mp4: (m.mp4 && (m.mp4['480'] || m.mp4.max)) || null,
        webm: (m.webm && (m.webm['480'] || m.webm.max)) || null
    };
}

export default async function handler(request, response) {
    const { appid, name } = request.query;

    if (!appid && !name) {
        return response.status(400).json({ error: 'Un appid ou un nom de jeu est requis' });
    }

    try {
        const resolvedAppId = appid || await findAppId(name);
        if (!resolvedAppId) {
            return response.status(404).json({ error: 'Jeu non trouvé sur Steam' });
        }

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
