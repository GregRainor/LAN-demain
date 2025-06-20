// api/verify-recaptcha.js
/*
export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Méthode non autorisée' });
    }

    try {
        // MODIFIÉ : Lit le token ET la siteKey depuis le corps de la requête
        const { token, siteKey } = request.body;
        
        // Récupère les variables d'environnement nécessaires depuis Vercel
        const GOOGLE_CLOUD_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
        const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;

        // VÉRIFICATION 1 : S'assure que le token et la siteKey sont bien présents
        if (!token || !siteKey) {
            return response.status(400).json({ success: false, message: 'Jeton ou clé de site manquant.' });
        }
        
        // VÉRIFICATION 2 : S'assure que le serveur est bien configuré
        if (!GOOGLE_CLOUD_API_KEY || !GOOGLE_CLOUD_PROJECT_ID) {
            return response.status(500).json({ success: false, message: 'Configuration du serveur incomplète. Vérifiez les variables d\'environnement sur Vercel (GOOGLE_CLOUD_API_KEY, GOOGLE_CLOUD_PROJECT_ID).' });
        }
        
        const verificationUrl = `https://recaptchaenterprise.googleapis.com/v1/projects/${GOOGLE_CLOUD_PROJECT_ID}/assessments?key=${GOOGLE_CLOUD_API_KEY}`;

        const requestBody = {
            event: {
                token: token,
                // MODIFIÉ : Utilise la siteKey reçue du client
                siteKey: siteKey,
                expectedAction: 'LOGIN'
            }
        };

        const verificationResponse = await fetch(verificationUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        const verificationData = await verificationResponse.json();
        
        // Gère les erreurs renvoyées par l'API Google
        if (verificationData.error) {
            console.error('Google reCAPTCHA API Error:', verificationData.error);
            return response.status(400).json({ success: false, message: 'Erreur de l\'API Google reCAPTCHA.' });
        }

        // Valide le token et vérifie le score
        if (verificationData.tokenProperties && verificationData.tokenProperties.valid && verificationData.riskAnalysis.score > 0.5) {
            return response.status(200).json({ success: true, score: verificationData.riskAnalysis.score });
        } else {
            return response.status(400).json({ success: false, message: `Échec de la validation reCAPTCHA. Raison: ${verificationData.tokenProperties?.invalidReason || 'Score faible'}` });
        }

    } catch (error) {
        console.error('Erreur interne de la fonction serverless:', error);
        return response.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
    }
}
*/