// Comparateur de prix via IsThereAnyDeal (Instant Gaming, Fanatical, GOG, Steam…).
//
// Accepte ?appid=<steam appid> (recommandé : plus fiable que le titre)
// ou ?title=<nom du jeu>.
//
// Nécessite ITAD_API_KEY dans les variables d'environnement Vercel.

const CACHE_HEADER = 'public, s-maxage=3600, stale-while-revalidate=86400';
const ITAD = 'https://api.isthereanydeal.com';

// Prix en euros et boutiques disponibles en France
const COUNTRY = 'FR';

import { guard } from './_guard.js';

export default async function handler(request, response) {
    // Consomme ITAD_API_KEY : origine + rate-limit
    if (guard(request, response, { limit: 100 })) return;

    const { appid, title } = request.query;

    if (!appid && !title) {
        return response.status(400).json({ error: 'Un appid ou un titre est requis' });
    }

    const apiKey = process.env.ITAD_API_KEY;
    if (!apiKey) {
        return response.status(503).json({
            error: 'ITAD_API_KEY absente des variables d\'environnement Vercel',
            missingKey: true
        });
    }

    try {
        // 1. Retrouver l'identifiant ITAD du jeu
        const lookupParams = new URLSearchParams({ key: apiKey });
        if (appid) lookupParams.set('appid', String(appid));
        else lookupParams.set('title', title);

        const lookupRes = await fetch(`${ITAD}/games/lookup/v1?${lookupParams}`);
        if (!lookupRes.ok) {
            return response.status(lookupRes.status).json({ error: 'Erreur de l\'API IsThereAnyDeal' });
        }

        const lookup = await lookupRes.json();
        if (!lookup.found || !lookup.game) {
            return response.status(404).json({ error: 'Jeu inconnu chez IsThereAnyDeal', found: false });
        }

        // 2. Récupérer les prix actuels de toutes les boutiques
        const priceParams = new URLSearchParams({ key: apiKey, country: COUNTRY, capacity: '0' });
        const priceRes = await fetch(`${ITAD}/games/prices/v3?${priceParams}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([lookup.game.id])
        });

        if (!priceRes.ok) {
            return response.status(priceRes.status).json({ error: 'Erreur de l\'API IsThereAnyDeal' });
        }

        const priceData = await priceRes.json();
        const entry = Array.isArray(priceData) ? priceData[0] : null;
        const deals = (entry && Array.isArray(entry.deals)) ? entry.deals : [];

        // Du moins cher au plus cher
        const sorted = deals
            .map(d => ({
                shop: d.shop?.name || '?',
                price: d.price?.amount ?? null,
                currency: d.price?.currency || 'EUR',
                regular: d.regular?.amount ?? null,
                cut: d.cut || 0,
                url: d.url || null
            }))
            .filter(d => d.price !== null)
            .sort((a, b) => a.price - b.price);

        response.setHeader('Cache-Control', CACHE_HEADER);

        return response.status(200).json({
            found: true,
            itadId: lookup.game.id,
            title: lookup.game.title,
            itadUrl: lookup.game.slug ? `https://isthereanydeal.com/game/${lookup.game.slug}/info/` : null,
            historyLow: entry?.historyLow?.all?.amount ?? null,
            deals: sorted.slice(0, 8)
        });

    } catch (error) {
        console.error('Erreur interne du serveur:', error);
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
