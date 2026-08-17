# Sécurité : points à vérifier

Checklist de revue pour un audit de sécurité de **LAN Demain**.
Chaque point est une hypothèse à *vérifier*, pas un fait établi.

- **Statut** : rédigé le 17 août 2026, avant tout audit.
- **Portée** : `desktop.html`, `newScript.js`, `style.css`, `m.html`, `mobile.js`, `mobile.css`, `core.js`, `api/*.js`, `database.rules.json`.
- **Contexte** : application entre amis (~10 joueurs), auth Google, Firebase Realtime
  Database attaquée directement depuis le navigateur, hébergement Vercel.
- **Convention** : cocher `[x]` une fois vérifié, et noter la conclusion sous le point.

Le modèle de menace réaliste ici n'est pas l'attaquant anonyme : les règles Firebase
exigent `auth != null` partout. C'est **un ami connecté qui fait une bêtise**, ou un
compte Google compromis. Les points ci-dessous sont classés dans cet esprit.

---

## 1. Écritures ouvertes à tout utilisateur connecté

Deux chemins acceptent l'écriture de n'importe quel compte authentifié. C'est
délibéré (l'app écrit côté client), mais à confirmer comme acceptable.

- [ ] **`lan/notifications/$uid` : écriture par tous.**
  Nécessaire : broadcasts, rappels, « shot ! » et notifications de cocktail prêt sont
  envoyés depuis le navigateur de l'expéditeur vers la file d'un autre joueur.
  *À vérifier* : un joueur peut-il spammer, usurper l'identité de l'admin dans un
  message, ou saturer la base ? Y a-t-il une limite de taille/volume ?
  *Piste* : déplacer l'envoi dans une fonction serverless et repasser en `.write: false`.

- [ ] **`lan/steamLibraries/$steamId` : écriture et suppression par tous.**
  Introduit pour qu'on puisse ajouter *et retirer* la bibliothèque d'un ami.
  Conséquence : n'importe quel joueur connecté peut supprimer la bibliothèque de
  n'importe qui, ou en injecter une fausse.
  *À vérifier* : faut-il restreindre la suppression à `addedBy` ou aux admins ?

- [ ] **Validation des données écrites.** Les règles contrôlent *qui* écrit, pas *quoi*.
  Aucune contrainte `.validate` : types, longueurs, champs attendus.
  *À vérifier* : un client modifié peut-il écrire un vote de 10 Mo, un titre
  d'événement de 100 000 caractères, ou des clés arbitraires sous `lan/` ?

## 2. XSS : couverture de l'échappement

Un helper `escapeHtml` existe et est utilisé à ~24 endroits, mais la couverture
n'a jamais été auditée exhaustivement.

- [ ] **Recenser tous les `innerHTML`** dans `newScript.js` et vérifier que chaque
  valeur d'origine utilisateur passe par `escapeHtml`.
  Champs concernés : noms de jeux, titres/descriptions/règles d'événements, noms et
  recettes de cocktails, messages de broadcast, pseudos, noms de LAN.
  *Note* : plusieurs rendus sont passés à `textContent` (sûr par construction) lors
  du travail de design : distinguer les deux.

- [ ] **Données venant d'API tierces.** Steam, Wikipédia et IsThereAnyDeal renvoient
  du texte affiché tel quel (`shortDescription`, `personaName`, noms de boutiques,
  résumé Wikipédia). Ce sont des sources externes, pas de confiance.
  *À vérifier* : sont-elles insérées via `textContent` ou `innerHTML` ?

- [ ] **`personaName` Steam.** Un pseudo Steam peut contenir des chevrons. Il est
  stocké en base puis affiché dans le panneau des bibliothèques et les onglets.

- [ ] **URLs injectées dans `href`.** Liens Steam, Instant Gaming, IsThereAnyDeal,
  Wikipédia, et `deal.url` renvoyé par ITAD. *À vérifier* : un `javascript:` peut-il
  arriver jusqu'à un `href` ?

## 3. Contrôle d'accès et rôles

- [ ] **UID admin en dur.** `ITe5VPuwewMzO7JnJA5oPWMdfvt2` est codé dans
  `database.rules.json` comme garde-fou anti-lockout, en doublon de la variable
  Vercel `ADMIN_UID`. *À vérifier* : est-ce toujours souhaité, et les deux
  valeurs sont-elles cohérentes ?

- [ ] **Escalade de privilèges.** `lan/roles` n'est écrivable que par un admin, donc
  personne ne devrait pouvoir s'auto-promouvoir. *À vérifier* en pratique, depuis la
  console d'un compte non-admin.

- [ ] **Contrôles côté client uniquement.** L'UI masque les actions admin via
  `window.currentUserIsAdmin`. *À vérifier* : chaque action ainsi masquée est-elle
  **aussi** refusée par les règles Firebase ? (bouton renommer un jeu, supprimer un
  cocktail de la carte, réinitialiser les votes, ouvrir la LAN, attribuer un rôle).

- [ ] **Renommage global d'un jeu.** Un admin réécrit les votes de *tous* les joueurs
  via un `update()` multi-chemins. *À vérifier* : les règles empêchent-elles un
  non-admin d'en faire autant ?

## 4. Endpoints serverless (`api/`)

- [ ] **Aucune authentification.** Les cinq endpoints sont publics et sans limite de
  débit. *À vérifier* : un tiers peut-il les utiliser comme proxy gratuit vers Steam
  et ITAD, et faire consommer votre quota de clé API ?

- [ ] **`STEAM_API_KEY` et `ITAD_API_KEY`.** Confirmer qu'elles ne sont utilisées que
  côté serveur et n'apparaissent dans aucune réponse ni dans le bundle client.

- [ ] **SSRF / injection de paramètres.** `game-details`, `game-deals`,
  `steam-library` et `game-wiki` construisent des URL à partir de l'entrée
  utilisateur. Elle est passée dans `encodeURIComponent`, mais `extractIdentifier`
  fait du parsing d'URL par regex : *à vérifier* qu'aucune entrée ne permet
  d'atteindre un autre hôte.

- [ ] **Fuite d'information par les erreurs.** Les `catch` renvoient un message
  générique mais journalisent l'erreur. *À vérifier* : rien de sensible dans les
  réponses.

## 5. Vie privée

- [ ] **Bibliothèques Steam.** L'app stocke la liste complète des jeux et le temps de
  jeu de chaque personne ajoutée, lisible par tout joueur connecté. La personne
  concernée n'a pas forcément consenti : n'importe qui peut ajouter son profil.
  *À vérifier* : est-ce acceptable dans ce cercle ? Faut-il un moyen de se retirer ?

- [ ] **`steamId` et données de présence.** `lan/status` expose qui est en ligne,
  avec nom et avatar Google.

## 6. Dépendances et chargement

- [ ] **Scripts tiers sans SRI.** Firebase v8.10.1 depuis `gstatic.com` et
  `hls.js@1.5.17` depuis `jsdelivr`, tous deux sans `integrity`.
  *À vérifier* : ajouter des hashes SRI, ou héberger localement.

- [ ] **Firebase SDK v8.** Version ancienne (API namespacée). *À vérifier* :
  vulnérabilités connues sur 8.10.1.

- [ ] **Absence de CSP.** Aucune `Content-Security-Policy` n'est définie dans
  `vercel.json`. Ce serait la meilleure défense en profondeur contre les XSS
  ci-dessus.

- [ ] **Clés Firebase dans `config.js`.** Générées au build depuis les variables
  Vercel. La config web Firebase n'est pas un secret en soi, mais confirmer
  qu'aucune clé serveur ne s'y est glissée.

## 7. Points déjà traités (à re-vérifier, pas à supposer acquis)

- [ ] Règles Firebase publiées et effectives : un test anonyme renvoyait bien
  `401 Permission denied` en lecture comme en écriture.
- [ ] `api/verify-recaptcha.js` (code mort entièrement commenté) supprimé.
- [ ] Secrets sortis du dépôt, `config.js` généré au build.

---

## Notes pour l'auditeur

Deux limites connues du travail effectué jusqu'ici, à garder en tête :

1. **Aucun outillage de vérification local.** Pas de Node sur la machine, pas de
   tests. Les modifications ont été validées par relecture, équilibrage des
   accolades, puis test du résultat déployé. Un bug de portée (`const profile`
   masquant le paramètre `profile`) est ainsi passé en production et renvoyait
   HTTP 500 sur chaque requête. **Supposer que le code n'a pas été analysé
   statiquement.**

2. **Un bug de CSS a masqué un filtre non fonctionnel pendant plusieurs jours** :
   la classe était bien appliquée, mais l'ordre des règles annulait `display: none`.
   La vérification portait sur la présence de la classe, pas sur l'effet réel.
   **Vérifier les effets observables, pas les états intermédiaires.**
