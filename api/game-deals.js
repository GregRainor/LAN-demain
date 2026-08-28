// Comparateur de prix via IsThereAnyDeal (Instant Gaming, Fanatical, GOG, Steam…)
// enrichi par le prix Steam direct, pour que la boutique officielle et ses
// promotions restent visibles même si ITAD tarde à les indexer.
//
// Accepte ?appid=<steam appid> (recommandé : plus fiable que le titre)
// ou ?title=<nom du jeu>.

// ITAD_API_KEY active le comparateur multi-boutiques. Sans cette clé, un appid
// permet tout de même de renvoyer l'offre Steam.

const CACHE_HEADER = 'public, s-maxage=900, stale-while-revalidate=3600';
const ITAD = 'https://api.isthereanydeal.com';

// Prix en euros et boutiques disponibles en France
const COUNTRY = 'FR';

import { guard } from './_guard.js';

function decodeSteamText(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&apos;|&#39;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&amp;/gi, '&')
        .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

// L'API appdetails expose le prix et la remise, mais pas leur échéance. Steam
// l'affiche en revanche dans le compte à rebours de la page publique du jeu.
function extractSteamPromoText(html) {
    const match = String(html || '').match(/class=["'][^"']*game_purchase_discount_countdown[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
    return match ? decodeSteamText(match[1]) : null;
}

function buildSteamDeal(appid, payload, promoEnds = null) {
    const entry = payload && payload[String(appid)];
    const data = entry && entry.success ? entry.data : null;
    if (!data) return null;

    const overview = data.price_overview;
    let price = null;
    let regular = null;
    let cut = 0;
    let currency = 'EUR';

    if (data.is_free) {
        price = 0;
        regular = 0;
    } else if (overview && Number.isFinite(Number(overview.final))) {
        price = Number(overview.final) / 100;
        regular = Number.isFinite(Number(overview.initial)) ? Number(overview.initial) / 100 : price;
        cut = Number(overview.discount_percent) || 0;
        currency = overview.currency || currency;
    } else {
        return null;
    }

    return {
        title: data.name || null,
        deal: {
            shop: 'Steam',
            price,
            currency,
            regular,
            cut,
            expiry: null,
            promoEnds: promoEnds || null,
            url: `https://store.steampowered.com/app/${encodeURIComponent(appid)}/`,
            source: 'steam'
        }
    };
}

async function fetchSteamDeal(appid) {
    if (!/^\d+$/.test(String(appid || ''))) return null;

    try {
        const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&l=french&cc=fr`;
        const detailsResponse = await fetch(detailsUrl);
        if (!detailsResponse.ok) return null;

        const payload = await detailsResponse.json();
        const initial = buildSteamDeal(appid, payload);
        if (!initial) return null;

        let promoEnds = null;
        if (initial.deal.cut > 0) {
            const storeUrl = `https://store.steampowered.com/app/${encodeURIComponent(appid)}/?l=french&cc=fr`;
            const storeResponse = await fetch(storeUrl, {
                headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' }
            });
            if (storeResponse.ok) promoEnds = extractSteamPromoText(await storeResponse.text());
        }

        return buildSteamDeal(appid, payload, promoEnds);
    } catch (error) {
        console.error('Erreur Steam dans le comparateur:', error);
        return null;
    }
}

function mergeDeals(itadDeals, steamResult, limit = 8) {
    const steamDeal = steamResult && steamResult.deal;
    const normalized = (Array.isArray(itadDeals) ? itadDeals : [])
        .filter(deal => !steamDeal || String(deal.shop || '').trim().toLowerCase() !== 'steam');

    if (steamDeal) normalized.push(steamDeal);
    normalized.sort((a, b) => Number(a.price) - Number(b.price));

    const top = normalized.slice(0, limit);
    if (steamDeal && !top.includes(steamDeal)) {
        top[Math.max(0, limit - 1)] = steamDeal;
        top.sort((a, b) => Number(a.price) - Number(b.price));
    }
    return top;
}

function sendSuccess(response, { lookup = null, entry = null, steamResult = null, title = '', itadUnavailable = false }) {
    response.setHeader('Cache-Control', CACHE_HEADER);
    return response.status(200).json({
        found: true,
        itadId: lookup && lookup.game ? lookup.game.id : null,
        title: (lookup && lookup.game && lookup.game.title) || (steamResult && steamResult.title) || title || null,
        itadUrl: lookup && lookup.game && lookup.game.slug
            ? `https://isthereanydeal.com/game/${lookup.game.slug}/info/`
            : null,
        historyLow: entry?.historyLow?.all?.amount ?? null,
        itadUnavailable,
        deals: mergeDeals(entry && entry.deals, steamResult)
    });
}

export default async function handler(request, response) {
    // Consomme ITAD_API_KEY : origine + rate-limit
    if (guard(request, response, { limit: 100, strict: true })) return;

    const { appid, title } = request.query;

    if (!appid && !title) {
        return response.status(400).json({ error: 'Un appid ou un titre est requis' });
    }

    const steamPromise = appid ? fetchSteamDeal(appid) : Promise.resolve(null);
    const apiKey = process.env.ITAD_API_KEY;
    if (!apiKey) {
        const steamResult = await steamPromise;
        if (steamResult) return sendSuccess(response, { steamResult, title, itadUnavailable: true });
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
        const steamResult = await steamPromise;
        if (!lookupRes.ok) {
            if (steamResult) return sendSuccess(response, { steamResult, title, itadUnavailable: true });
            return response.status(lookupRes.status).json({ error: 'Erreur de l\'API IsThereAnyDeal' });
        }

        const lookup = await lookupRes.json();
        if (!lookup.found || !lookup.game) {
            if (steamResult) return sendSuccess(response, { steamResult, title, itadUnavailable: true });
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
            if (steamResult) return sendSuccess(response, { lookup, steamResult, title, itadUnavailable: true });
            return response.status(priceRes.status).json({ error: 'Erreur de l\'API IsThereAnyDeal' });
        }

        const priceData = await priceRes.json();
        const rawEntry = Array.isArray(priceData) ? priceData[0] : null;
        const rawDeals = rawEntry && Array.isArray(rawEntry.deals) ? rawEntry.deals : [];
        const entry = {
            historyLow: rawEntry && rawEntry.historyLow,
            deals: rawDeals
                .map(deal => ({
                    shop: deal.shop?.name || '?',
                    price: deal.price?.amount ?? null,
                    currency: deal.price?.currency || 'EUR',
                    regular: deal.regular?.amount ?? null,
                    cut: deal.cut || 0,
                    expiry: deal.expiry || null,
                    promoEnds: null,
                    url: deal.url || null,
                    source: 'itad'
                }))
                .filter(deal => deal.price !== null)
        };

        return sendSuccess(response, { lookup, entry, steamResult, title });
    } catch (error) {
        console.error('Erreur interne du serveur:', error);
        const steamResult = await steamPromise;
        if (steamResult) return sendSuccess(response, { steamResult, title, itadUnavailable: true });
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
