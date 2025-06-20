// api/verify-recaptcha.js
// VERSION FINALE POUR RECAPTCHA ENTERPRISE

export default async function handler(request, response) {
    // On vérifie que la requête est bien une requête POST
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Méthode non autorisée' });
    }

    try {
        const { token } = request.body;
        
        // On récupère les variables d'environnement nécessaires depuis Vercel
        const GOOGLE_CLOUD_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
        const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
        // La clé de site publique est nécessaire pour la validation Enterprise
        const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;

        if (!token) {
            return response.status(400).json({ success: false, message: 'Jeton manquant.' });
        }
        // On vérifie que toutes les clés sont bien configurées sur Vercel
        if (!GOOGLE_CLOUD_API_KEY || !GOOGLE_CLOUD_PROJECT_ID || !RECAPTCHA_SITE_KEY) {
            // Si une clé manque, l'erreur 500 sera "Configuration du serveur incomplète."
            return response.status(500).json({ success: false, message: 'Configuration du serveur incomplète.' });
        }
        
        // C'est la bonne URL de l'API pour reCAPTCHA Enterprise
        const verificationUrl = `https://recaptchaenterprise.googleapis.com/v1/projects/${GOOGLE_CLOUD_PROJECT_ID}/assessments?key=${GOOGLE_CLOUD_API_KEY}`;

        // Le corps de la requête doit avoir un format spécifique pour Enterprise
        const requestBody = {
            event: {
                token: token,
                siteKey: RECAPTCHA_SITE_KEY,
                expectedAction: 'LOGIN' // Doit correspondre à l'action définie dans le front-end
            }
        };

        const verificationResponse = await fetch(verificationUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        const verificationData = await verificationResponse.json();

        // L'API Enterprise renvoie une analyse de risque avec un score
        if (verificationData.tokenProperties && verificationData.tokenProperties.valid) {
             if (verificationData.riskAnalysis.score > 0.5) {
                // Score élevé = probablement un humain
                return response.status(200).json({ success: true, score: verificationData.riskAnalysis.score });
             } else {
                // Score bas = probablement un robot
                return response.status(400).json({ success: false, score: verificationData.riskAnalysis.score, message: 'Activité suspecte détectée.' });
             }
        } else {
            // Le jeton lui-même est invalide pour une raison ou une autre
            return response.status(400).json({ success: false, message: `Échec de la validation du jeton : ${verificationData.tokenProperties?.invalidReason}` });
        }

    } catch (error) {
        console.error('Erreur de vérification reCAPTCHA:', error);
        return response.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
    }
}