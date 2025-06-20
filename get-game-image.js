export default async function handler(request, response) {
    // On récupère le nom du jeu depuis les paramètres de l'URL
    const gameName = request.query.name;
    // Vercel injecte la clé API stockée de manière sécurisée dans les variables d'environnement
    const STEAM_API_KEY = process.env.STEAM_API_KEY;

    if (!gameName) {
        return response.status(400).json({ error: 'Un nom de jeu est requis' });
    }
    
    // Si tu n'as pas de clé API, tu peux décommenter cette partie pour utiliser la base de données interne
    /*
    const PREDEFINED_GAMES = { 'counter-strike 2': '730', 'lethal company': '1966720', ... };
    const appId = PREDEFINED_GAMES[gameName.toLowerCase()];
    if (appId) {
        return response.status(200).json({ imageUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg` });
    } else {
        return response.status(404).json({ error: 'Jeu non trouvé dans la liste interne' });
    }
    */

    // Si tu as une clé API, utilise cette partie pour une recherche en direct
    if (!STEAM_API_KEY) {
         return response.status(500).json({ error: 'La clé API Steam n\'est pas configurée sur le serveur.' });
    }

    try {
        // L'API de recherche de Steam est plus efficace que de lister tous les jeux
        const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=french&cc=fr`;
        const steamResponse = await fetch(searchUrl);

        if (!steamResponse.ok) {
            return response.status(steamResponse.status).json({ error: 'Erreur de l\'API Steam' });
        }

        const data = await steamResponse.json();

        // On prend le premier résultat, qui est généralement le plus pertinent
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