// Normalise pour comparer : minuscules, sans accents, sans ™/®, sans ponctuation
function normalize(str) {
    return String(str)
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[™®©]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

export default async function handler(request, response) {
    const gameName = request.query.name;
    // Deux besoins opposés sur le même endpoint :
    //  - les vignettes exigent une correspondance exacte (sinon League of
    //    Legends hérite de la jaquette de Ruined King) ;
    //  - le bouton « Vérifier » doit au contraire deviner : on tape « civ 6 »
    //    pour obtenir « Sid Meier's Civilization VI ».
    const fuzzy = request.query.fuzzy === '1';

    if (!gameName) {
        return response.status(400).json({ error: 'Un nom de jeu est requis' });
    }

    try {
        // Endpoint public Steam : aucune clé API n'est nécessaire ici
        const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=french&cc=fr`;
        const steamResponse = await fetch(searchUrl);

        if (!steamResponse.ok) {
            return response.status(steamResponse.status).json({ error: 'Erreur de l\'API Steam' });
        }

        const data = await steamResponse.json();

        // On exige une correspondance exacte : prendre le premier résultat
        // affichait la jaquette de Ruined King pour « League of Legends »
        // et celle de Minecraft Dungeons pour « Minecraft ».
        const target = normalize(gameName);
        const items = Array.isArray(data.items) ? data.items : [];
        const exact = items.find(item => normalize(item.name) === target);
        const match = exact || (fuzzy ? items[0] : null);

        if (match) {
            const appId = match.id;
            const officialName = match.name; // On récupère le nom officiel
            const imageUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

            // Cache sur le CDN Vercel : 24h de fraîcheur, 7 jours en stale-while-revalidate.
            // Sans ça, chaque visiteur déclenche des dizaines d'appels serverless -> Steam
            // (la marquee seule en fait ~25) et on se fait rate-limiter par Steam.
            response.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');

            // On renvoie l'URL de l'image, le nom officiel ET l'appId (utile pour les liens Steam à venir)
            return response.status(200).json({ imageUrl, name: officialName, appId, exactMatch: !!exact });
        } else {
            return response.status(404).json({ error: 'Jeu non trouvé sur Steam' });
        }

    } catch (error) {
        console.error('Erreur interne du serveur:', error);
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
