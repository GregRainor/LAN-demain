// Illustration d'une carte Signature, dessinée par Nano Banana Pro
// (Gemini 3 Pro Image).
//
// Les cartes ordinaires portent la jaquette Steam du jeu, déduite de son appId.
// Les huit cartes du sommet du set — celles que tout le groupe possède et
// réclame — méritent mieux : une illustration faite pour elles, dans l'identité
// de l'application (noir et or, cadre net, ambiance de LAN nocturne).
//
// La fonction renvoie l'image en base64 ; c'est le client du maître du jeu qui
// l'enregistre dans `lan/cardArt/{gameKey}`. On ne stocke rien ici : une
// fonction serverless n'a pas d'état, et l'écriture doit rester signée par
// quelqu'un.
//
// Limite assumée, cohérente avec le reste de api/ : la clé est protégée par un
// contrôle d'origine et un rate-limit par IP, pas par une authentification.
// C'est le même compromis que STEAM_API_KEY (voir _guard.js), mais l'enjeu est
// plus élevé ici puisque chaque appel coûte. D'où un plafond volontairement
// bas : générer huit cartes prend huit appels, personne n'en a besoin de plus.

import { guard } from './_guard.js';

const MODEL = 'gemini-3-pro-image';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// L'illustration doit ressembler à une carte de la maison, pas à une image de
// stock. On décrit donc l'identité visuelle plutôt que le jeu : le nom du jeu
// donne le sujet, le reste donne le style.
function buildPrompt(gameName) {
    return [
        `Key art for a premium collectible trading card celebrating the video game "${gameName}".`,
        'Cinematic wide composition, single striking focal subject drawn from the game\'s world,',
        'dramatic rim lighting against a deep near-black background, embers and volumetric haze.',
        'Restrained palette: blacks, warm gold highlights, one accent colour taken from the game.',
        'Painterly digital illustration, high detail, elegant and understated — not cluttered.',
        'Absolutely no text, no logos, no watermarks, no user interface, no card frame or border.'
    ].join(' ');
}

export default async function handler(request, response) {
    // Chaque appel coûte : plafond serré, bien plus bas que les proxys de lecture.
    if (guard(request, response, { limit: 12 })) return;

    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Méthode non autorisée' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        // Sans clé, l'application doit continuer de tourner : les cartes
        // Signature gardent simplement leur jaquette Steam.
        return response.status(503).json({ error: 'Génération d\'illustrations non configurée' });
    }

    const gameName = String((request.body && request.body.name) || '').trim();
    if (!gameName || gameName.length > 200) {
        return response.status(400).json({ error: 'Nom de jeu manquant ou trop long' });
    }

    try {
        const upstream = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'x-goog-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: MODEL,
                input: [{ type: 'text', text: buildPrompt(gameName) }],
                // 16:9 : la fenêtre d'illustration d'une carte est en paysage,
                // comme une jaquette Steam. 1K suffit largement pour 240 px de
                // large, et c'est la moitié du prix de la 4K.
                response_format: {
                    type: 'image',
                    mime_type: 'image/jpeg',
                    aspect_ratio: '16:9',
                    image_size: '1K'
                }
            })
        });

        if (!upstream.ok) {
            const detail = await upstream.text().catch(() => '');
            console.error('Nano Banana Pro a refusé :', upstream.status, detail.slice(0, 300));
            return response.status(502).json({ error: 'Le générateur d\'images a refusé la demande' });
        }

        const data = await upstream.json();
        // La réponse expose l'image à deux endroits : le raccourci output_image,
        // et le détail des étapes. On accepte les deux, l'un des deux peut
        // manquer selon le modèle.
        const direct = data && data.output_image;
        const fromSteps = (((data && data.steps) || [])
            .flatMap(step => (step && step.content) || [])
            .find(part => part && part.type === 'image')) || null;
        const image = (direct && direct.data) ? direct : fromSteps;

        if (!image || !image.data) {
            console.error('Réponse sans image :', JSON.stringify(data).slice(0, 300));
            return response.status(502).json({ error: 'Aucune image dans la réponse' });
        }

        // Une illustration ne change plus : le CDN peut la garder longtemps.
        response.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
        return response.status(200).json({
            dataUrl: `data:${image.mime_type || 'image/jpeg'};base64,${image.data}`,
            model: MODEL
        });
    } catch (error) {
        console.error('Erreur de génération :', error);
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
