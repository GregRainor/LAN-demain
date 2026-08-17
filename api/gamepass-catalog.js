// Catalogue PC Game Pass, pour compter comme "possédés" les jeux d'un abonné.
//
// Il n'existe pas d'API publique officielle. On utilise les deux endpoints du
// site Game Pass lui-même :
//   1. catalog.gamepass.com/sigls/v2 : la liste des identifiants produit
//   2. displaycatalog.mp.microsoft.com : les titres correspondants
// Non contractuels, donc susceptibles de changer sans préavis : le client doit
// tolérer une réponse vide.

const CACHE_HEADER = 'public, s-maxage=86400, stale-while-revalidate=604800';

// Collection "PC Game Pass"
const PC_COLLECTION = 'fdd9e2a7-0fee-49f6-ad69-4354098401ff';

// displaycatalog n'accepte pas 500 identifiants d'un coup
const BATCH_SIZE = 20;

// « 9 Kings (Aperçu) » ne correspondrait jamais à « 9 Kings » sur Steam
function cleanTitle(title) {
    return String(title)
        .replace(/\s*\((aperçu|preview|game preview|windows|pc)\)\s*$/i, '')
        // « A Plague Tale: Requiem - Windows » doit pouvoir matcher Steam
        .replace(/\s*[-–]\s*(windows|pc)(\s+edition)?\s*$/i, '')
        .trim();
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export default async function handler(request, response) {
    const market = (request.query.market || 'FR').toUpperCase();
    const language = request.query.language || 'fr-fr';

    try {
        const siglsUrl = `https://catalog.gamepass.com/sigls/v2?id=${PC_COLLECTION}&language=${encodeURIComponent(language)}&market=${encodeURIComponent(market)}`;
        const siglsRes = await fetch(siglsUrl);
        if (!siglsRes.ok) {
            return response.status(siglsRes.status).json({ error: 'Catalogue Game Pass indisponible' });
        }

        const sigls = await siglsRes.json();
        const ids = (Array.isArray(sigls) ? sigls : [])
            .map(entry => entry && entry.id)
            .filter(Boolean);

        if (ids.length === 0) {
            return response.status(200).json({ games: [], count: 0 });
        }

        const games = [];
        // Séquentiel par lots : Microsoft limite les requêtes parallèles agressives
        for (const batch of chunk(ids, BATCH_SIZE)) {
            const url = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${batch.join(',')}`
                + `&market=${encodeURIComponent(market)}&languages=${encodeURIComponent(language)}&MS-CV=DGU1mcuYo0WMMp+F.1`;
            const res = await fetch(url);
            if (!res.ok) continue;

            const data = await res.json();
            (data.Products || []).forEach(p => {
                const title = p.LocalizedProperties && p.LocalizedProperties[0]
                    && p.LocalizedProperties[0].ProductTitle;
                if (title) games.push({ id: p.ProductId, name: cleanTitle(title) });
            });
        }

        response.setHeader('Cache-Control', CACHE_HEADER);
        return response.status(200).json({ games, count: games.length });

    } catch (error) {
        console.error('Erreur interne du serveur:', error);
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
