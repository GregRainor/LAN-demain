const fs = require('fs');
const path = require('path');

const config = `
const firebaseConfig = {
  apiKey: "${process.env.FIREBASE_API_KEY || ''}",
  authDomain: "${process.env.FIREBASE_AUTH_DOMAIN || ''}",
  databaseURL: "${process.env.FIREBASE_DATABASE_URL || ''}",
  projectId: "${process.env.FIREBASE_PROJECT_ID || ''}",
  storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET || ''}",
  messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID || ''}",
  appId: "${process.env.FIREBASE_APP_ID || ''}"
};
const ADMIN_UID = "${process.env.ADMIN_UID || ''}";
`;

fs.writeFileSync('config.js', config);
console.log('config.js generated from environment variables.');

/* Le site est servi depuis la racine du dépôt (`outputDirectory: "."`), donc
   TOUT fichier présent ici devient une URL publique. On l'a vérifié en direct :
   /database.rules.json, /api/_guard.js et /SECURITY.md répondaient 200 en clair.
   Aucun secret ne fuyait — .env n'est pas versionné — mais ça offrait le modèle
   d'autorisation complet, l'ADMIN_UID et la logique de la garde d'origine,
   commentaires compris.

   On fait donc le ménage ici plutôt que dans un .vercelignore : ce script EST
   la commande de build, il ne peut pas s'exclure lui-même d'une liste
   d'ignorés, et Vercel ramasse le dossier une fois le build terminé.

   Deux fichiers ne peuvent PAS être effacés ici et sont donc traités par une
   redirection dans vercel.json : `package.json`, dont Vercel se sert après le
   build pour empaqueter les fonctions, et `api/_guard.js`, que les fonctions
   importent au démarrage.

   Ne jamais mettre ici un fichier dont l'application a besoin au chargement. */
const PRIVATE = [
    'database.rules.json',
    'config.example.js',
    'build-config.js',
    'AGENTS.md',
    'README.md',
    'SECURITY.md',
    'SECURITY-TO-CHECK.md',
    'security_check.md',
    'CARTES.md',
    'TCG-PLAN.md',
    'TITLES.md',
    'scripts',
    'design',
    'docs',
    '.codex-remote-attachments'
];

let removed = 0;
for (const entry of PRIVATE) {
    const target = path.join(__dirname, entry);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed++;
}
console.log(`${removed} fichier(s) de développement retiré(s) du déploiement.`);
