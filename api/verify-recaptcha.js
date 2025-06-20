export default async function handler(request, response) {
    // On s'attend à recevoir une requête POST avec un jeton
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Méthode non autorisée' });
    }

    try {
        const { token } = request.body;
        const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY; // Ta clé secrète

        if (!token) {
            return response.status(400).json({ success: false, message: 'Jeton manquant.' });
        }
        if (!RECAPTCHA_SECRET_KEY) {
            return response.status(500).json({ success: false, message: 'Clé secrète reCAPTCHA non configurée.' });
        }

        // On construit la requête vers l'API Google
        const verificationUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${RECAPTCHA_SECRET_KEY}&response=${token}`;

        const verificationResponse = await fetch(verificationUrl, { method: 'POST' });
        const verificationData = await verificationResponse.json();

        // Google nous renvoie un score de 0.0 (robot) à 1.0 (humain). On peut fixer un seuil.
        if (verificationData.success && verificationData.score > 0.5) {
            return response.status(200).json({ success: true, score: verificationData.score });
        } else {
            return response.status(400).json({ success: false, score: verificationData.score, message: 'Échec de la vérification reCAPTCHA.' });
        }

    } catch (error) {
        console.error('Erreur de vérification reCAPTCHA:', error);
        return response.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
    }
}