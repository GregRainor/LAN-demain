// Bibliothèque Steam d'un joueur, pour les suggestions "jeux possédés par la majorité".
//
// Contrairement aux autres endpoints, celui-ci utilise vraiment STEAM_API_KEY
// (GetOwnedGames n'est pas public). Il accepte :
//   ?profile=<url de profil, vanity name ou steamid64>
//
// Limite connue : ne fonctionne que si le joueur a réglé "Détails du jeu" sur
// Public dans la confidentialité de son profil Steam. Sinon on renvoie
// privateProfile: true et l'app propose la saisie manuelle.

const CACHE_HEADER = 'public, s-maxage=3600, stale-while-revalidate=86400';

// Accepte une URL complète, un pseudo personnalisé ou un steamid64 brut
function extractIdentifier(input) {
    const value = String(input).trim();

    const profileMatch = value.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
    if (profileMatch) return { type: 'id', value: profileMatch[1] };

    const vanityMatch = value.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
    if (vanityMatch) return { type: 'vanity', value: vanityMatch[1] };

    if (/^\d{17}$/.test(value)) return { type: 'id', value };

    return { type: 'vanity', value };
}

async function resolveSteamId(identifier, apiKey) {
    if (identifier.type === 'id') return identifier.value;

    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(identifier.value)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.response?.success === 1 ? data.response.steamid : null;
}

// Le pseudo Steam du compte : c'est lui qui doit étiqueter la bibliothèque,
// pas le nom du joueur connecté : sinon la bibliothèque d'un ami s'affiche
// sous le nom de celui qui l'a ajoutée.
async function fetchProfile(steamId, apiKey) {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const player = data?.response?.players?.[0];
    if (!player) return null;
    return {
        personaName: player.personaname || null,
        avatar: player.avatarmedium || player.avatar || null,
        profileUrl: player.profileurl || null
    };
}

export default async function handler(request, response) {
    const { profile } = request.query;

    if (!profile) {
        return response.status(400).json({ error: 'Un profil Steam est requis' });
    }

    const apiKey = process.env.STEAM_API_KEY;
    if (!apiKey) {
        // Message explicite : sans clé, la fonctionnalité ne peut pas exister
        return response.status(503).json({
            error: 'STEAM_API_KEY absente des variables d\'environnement Vercel',
            missingKey: true
        });
    }

    try {
        const steamId = await resolveSteamId(extractIdentifier(profile), apiKey);
        if (!steamId) {
            return response.status(404).json({ error: 'Profil Steam introuvable' });
        }

        const libraryUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true`;
        const libRes = await fetch(libraryUrl);
        if (!libRes.ok) {
            return response.status(libRes.status).json({ error: 'Erreur de l\'API Steam' });
        }

        const libData = await libRes.json();
        const games = libData?.response?.games;
        // Surtout pas « profile » : c'est déjà le paramètre de la requête, et
        // le redéclarer ici le rendrait inaccessible plus haut dans ce bloc.
        const steamProfile = await fetchProfile(steamId, apiKey);

        // GetOwnedGames renvoie un objet vide quand le profil est privé
        if (!Array.isArray(games)) {
            return response.status(200).json({
                steamId,
                personaName: steamProfile?.personaName || null,
                privateProfile: true,
                games: []
            });
        }

        response.setHeader('Cache-Control', CACHE_HEADER);

        return response.status(200).json({
            steamId,
            personaName: steamProfile?.personaName || null,
            avatar: steamProfile?.avatar || null,
            profileUrl: steamProfile?.profileUrl || null,
            privateProfile: false,
            gameCount: games.length,
            games: games.map(g => ({
                appId: g.appid,
                name: g.name,
                playtimeMinutes: g.playtime_forever || 0
            }))
        });

    } catch (error) {
        console.error('Erreur interne du serveur:', error);
        return response.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
