// Repli pour les jeux absents de Steam (League of Legends, Fortnite, Riftbound…).
// Utilise l'API REST de Wikipédia : aucune clé requise.
//
// Stratégie : on tente le résumé direct en français, puis en anglais, et si le
// titre exact n'existe pas on passe par la recherche (Riftbound n'a pas de page
// FR mais est trouvable via la recherche EN).

const CACHE_HEADER = 'public, s-maxage=86400, stale-while-revalidate=604800';

// Wikipédia impose un User-Agent descriptif et rejette les requêtes anonymes
// vers l'API action (w/api.php) : sans lui, la recherche échoue en production.
const WIKI_HEADERS = {
    'accept': 'application/json',
    'user-agent': 'LANDemain/1.0 (https://lan-demain.vercel.app)'
};

// Les titres Wikipédia commencent par une majuscule : « fortnite » ne résout pas.
function capitalize(str) {
    const s = String(str).trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

async function fetchSummary(lang, title) {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    // Les pages d'homonymie ne décrivent aucun jeu
    if (!data.extract || data.type === 'disambiguation') return null;
    return data;
}

// Recherche le titre le plus pertinent en ajoutant « jeu vidéo » au besoin
async function searchTitle(lang, query, hint) {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + ' ' + hint)}&format=json&srlimit=1`;
    const res = await fetch(url, { headers: WIKI_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.query?.search?.[0]?.title || null;
}

export default async function handler(request, response) {
    const { name } = request.query;

    if (!name) {
        return response.status(400).json({ error: 'Un nom de jeu est requis' });
    }

    try {
        const titleCandidate = capitalize(name);

        let summary = await fetchSummary('fr', titleCandidate);
        let lang = 'fr';

        if (!summary) {
            summary = await fetchSummary('en', titleCandidate);
            lang = 'en';
        }

        if (!summary) {
            const frTitle = await searchTitle('fr', name, 'jeu vidéo');
            if (frTitle) {
                summary = await fetchSummary('fr', frTitle);
                lang = 'fr';
            }
        }

        if (!summary) {
            const enTitle = await searchTitle('en', name, 'video game');
            if (enTitle) {
                summary = await fetchSummary('en', enTitle);
                lang = 'en';
            }
        }

        if (!summary) {
            return response.status(404).json({ error: 'Aucune fiche Wikipédia trouvée', found: false });
        }

        response.setHeader('Cache-Control', CACHE_HEADER);

        return response.status(200).json({
            found: true,
            lang,
            title: summary.title,
            description: summary.extract,
            image: summary.thumbnail?.source || summary.originalimage?.source || null,
            url: summary.content_urls?.desktop?.page || null
        });

    } catch (error) {
        console.error('Erreur interne du serveur:', error);
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
