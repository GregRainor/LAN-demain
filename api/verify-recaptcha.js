// api/verify-recaptcha.js
// VERSION FINALE SIMPLIFIÉE

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Méthode non autorisée' });
    }

    try {
        // On récupère le jeton ET la clé de site publique depuis la requête du client
        const { token, siteKey } = request.body;
        
        // On récupère les DEUX SEULES variables secrètes nécessaires depuis Vercel
        const GOOGLE_CLOUD_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
        const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;

        if (!token || !siteKey) {
            return response.status(400).json({ success: false, message: 'Jeton ou clé de site manquant.' });
        }
        if (!GOOGLE_CLOUD_API_KEY || !GOOGLE_CLOUD_PROJECT_ID) {
            // L'erreur que tu vois est probablement générée ici.
            return response.status(500).json({ success: false, message: 'Configuration du serveur incomplète. Vérifiez les variables d\'environnement sur Vercel.' });
        }
        
        const verificationUrl = `https://recaptchaenterprise.googleapis.com/v1/projects/${GOOGLE_CLOUD_PROJECT_ID}/assessments?key=${GOOGLE_CLOUD_API_KEY}`;

        const requestBody = {
            event: {
                token: token,
                siteKey: siteKey, // On utilise la clé passée depuis le front-end
                expectedAction: 'LOGIN'
            }
        };

        const verificationResponse = await fetch(verificationUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        const verificationData = await verificationResponse.json();

        if (verificationData.tokenProperties && verificationData.tokenProperties.valid && verificationData.riskAnalysis.score > 0.5) {
            return response.status(200).json({ success: true, score: verificationData.riskAnalysis.score });
        } else {
            return response.status(400).json({ success: false, message: `Échec de la validation reCAPTCHA. Raison: ${verificationData.tokenProperties?.invalidReason || 'Score faible'}` });
        }

    } catch (error) {
        console.error('Erreur de vérification reCAPTCHA:', error);
        return response.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
    }
}