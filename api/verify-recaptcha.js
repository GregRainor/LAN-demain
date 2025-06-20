// api/verify-recaptcha.js
export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Méthode non autorisée' });
    }

    try {
        const { token } = request.body;
        
        // On récupère les variables d'environnement depuis Vercel
        const GOOGLE_CLOUD_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
        const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
        const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY; // Clé publique

        if (!token) {
            return response.status(400).json({ success: false, message: 'Jeton manquant.' });
        }
        if (!GOOGLE_CLOUD_API_KEY || !GOOGLE_CLOUD_PROJECT_ID || !RECAPTCHA_SITE_KEY) {
            return response.status(500).json({ success: false, message: 'Configuration du serveur incomplète. Vérifiez les variables d\'environnement sur Vercel (GOOGLE_CLOUD_API_KEY, GOOGLE_CLOUD_PROJECT_ID, NEXT_PUBLIC_RECAPTCHA_SITE_KEY).' });
        }
        
        const verificationUrl = `https://recaptchaenterprise.googleapis.com/v1/projects/${GOOGLE_CLOUD_PROJECT_ID}/assessments?key=${GOOGLE_CLOUD_API_KEY}`;

        const requestBody = {
            event: {
                token: token,
                siteKey: RECAPTCHA_SITE_KEY,
                expectedAction: 'LOGIN'
            }
        };

        const verificationResponse = await fetch(verificationUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        const verificationData = await verificationResponse.json();
        
        // On vérifie si Google a renvoyé une erreur
        if (verificationData.error) {
            console.error('Google reCAPTCHA API Error:', verificationData.error);
            return response.status(400).json({ success: false, message: 'Erreur de l\'API Google reCAPTCHA.' });
        }

        if (verificationData.tokenProperties && verificationData.tokenProperties.valid && verificationData.riskAnalysis.score > 0.3) { // Seuil abaissé pour les tests
            return response.status(200).json({ success: true, score: verificationData.riskAnalysis.score });
        } else {
            return response.status(400).json({ success: false, message: `Échec de la validation reCAPTCHA. Raison: ${verificationData.tokenProperties?.invalidReason || 'Score faible'}` });
        }

    } catch (error) {
        console.error('Erreur interne de la fonction serverless:', error);
        return response.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
    }
}