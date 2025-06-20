export default async function handler(request, response) {
    const gameName = request.query.name;
    const STEAM_API_KEY = process.env.STEAM_API_KEY;

    if (!gameName) {
        return response.status(400).json({ error: 'Un nom de jeu est requis' });
    }

    if (!STEAM_API_KEY) {
         return response.status(500).json({ error: 'La clé API Steam n\'est pas configurée sur le serveur.' });
    }

    try {
        const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=french&cc=fr`;
        const steamResponse = await fetch(searchUrl);

        if (!steamResponse.ok) {
            return response.status(steamResponse.status).json({ error: 'Erreur de l\'API Steam' });
        }

        const data = await steamResponse.json();

        if (data.total > 0 && data.items.length > 0) {
            const appId = data.items[0].id;
            const imageUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
            return response.status(200).json({ imageUrl });
        } else {
            return response.status(404).json({ error: 'Jeu non trouvé sur Steam' });
        }

    } catch (error) {
        console.error('Erreur interne du serveur:', error);
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}