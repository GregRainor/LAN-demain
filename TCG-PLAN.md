# LAN Demain — le jeu de cartes

Plan de travail. À lire en entier avant d'écrire une ligne de code.
Ce document est autonome : il contient tout ce qu'il faut savoir du projet pour
démarrer cette fonctionnalité sans autre contexte.

---

## 0. Où on en est (août 2026)

**Les phases 1 à 3 sont construites et vérifiées sur les deux interfaces.**
Reste la finition (§7, phase 4) et les illustrations.

Ce qui a été fait :

- `core.js` — set frappé depuis les votes, tirage semé, rejeu de la collection
  et des échanges, doubles, complétion. Aucun DOM, aucun Firebase.
- `database.rules.json` — `lan/tcg` : set, paquets, échanges.
  **Les règles doivent être republiées à la main**, voir `SECURITY.md`.
- Bureau : `desktop.html` + `newScript.js` + `style.css`, onglet « Collection ».
- Téléphone : `m.html` + `mobile.js` + `mobile.css`, écran « Mes cartes »
  (dans « Plus »), plus un rappel sur l'écran d'accueil quand un booster attend.

Deux écarts par rapport au plan écrit plus bas, tous deux assumés :

1. **§5.1 — ni A ni B : le sceau serveur.** Pas de fonction serverless, pas de
   `firebase-admin`, pas de clé de compte de service. Le contenu d'un paquet
   n'est pas stocké : il se recalcule depuis `hash(packId | sealedAt | uid)`,
   où `sealedAt` est l'horodatage écrit par le **serveur** au moment de l'achat
   (les règles exigent `sealedAt === now`, et le nœud est en écriture unique).
   Imprévisible parce que personne ne connaît la milliseconde du serveur,
   vérifiable parce que tout le monde rejoue le même paquet, instantané parce
   qu'il n'y a personne à attendre. C'est le même principe que le registre de
   points, appliqué au hasard : ne rien stocker, tout rejouer.
   `$packId` **est** l'identifiant de la demande d'achat, donc un achat validé
   donne exactement un paquet — structurellement, pas par vérification.
2. **§5.2 — `offer` / `request` sont des chaînes, pas des listes.** Les règles
   Firebase ne savent pas comparer deux listes en une expression ; une chaîne
   d'identifiants séparés par des virgules, si. Sans cette égalité exigée à la
   résolution, celui qui accepte pourrait réécrire l'offre en sa faveur avant
   de signer. Le reste est conforme : le rejeu ignore, sans les refuser, les
   échanges dont une partie ne possédait pas sa mise.

Ajout non prévu, et qui s'est révélé être le cœur de la chose : **la provenance**.
Chaque carte porte qui l'a sortie du paquet, quand, et la suite des mains par
lesquelles elle est passée. Ça tombe gratuitement du modèle de rejeu, et c'est
ce qui transforme « une carte Valorant » en « la Valorant brillante que Bob a
sortie à 2 h ». La fiche d'une carte l'affiche.

Réponses aux questions ouvertes du §8 :

1. **Les cartes sont permanentes.** `startNewLan()` ne touche pas à `lan/tcg`.
   Chaque LAN frappe son set et l'ajoute à une collection qui grandit ; les
   paquets gardent leur `setId`, donc refrapper ne réécrit jamais le passé.
2. Distinction boutique / TCG : les cartes à collectionner sont au **format
   portrait** avec un cadre coloré par rareté, la boutique garde ses fiches
   d'article. À rejouer au moment du travail de design.
3. **Tout le monde peut échanger avec tout le monde**, dès qu'il a une carte.
4. **Les doubles ne servent qu'à l'échange**, comme recommandé.

---

## 1. L'idée, et ce qui la rend bonne

Un jeu de cartes à collectionner **dont le set est fabriqué par le vote**.

À chaque LAN, les jeux que les joueurs ont votés (`lan/votes` → `calculateScores()`
dans `core.js`) deviennent les cartes du set de cette soirée. On gagne des points
en jouant et en relevant des défis, on dépense ces points en **boosters**, on ouvre,
on collectionne, on échange.

Ce n'est pas « un TCG sur les jeux vidéo » — ça, c'est oubliable. C'est **le set de
la LAN de janvier**, celui où Bob a sorti le Valorant brillant. Un souvenir de
soirée qui se collectionne. Toute décision de conception doit servir ça.

Conséquence directe : **la rareté vient du score de vote**, elle n'est pas inventée.
Le jeu que tout le monde voulait est la légendaire du set. La rareté raconte
quelque chose de vrai sur la soirée.

---

## 2. LA décision à prendre avant tout le reste

« TCG » cache deux produits très différents :

| | Jeu de **collection** | Jeu **jouable** |
|---|---|---|
| Boucle | ouvrir, collectionner, échanger, compléter | construire un deck, s'affronter, gagner |
| À concevoir | raretés, taux de drop, échange | règles, coûts, équilibrage, conditions de victoire |
| À construire | ouverture, collection, échange | + moteur de tour, état de partie temps réel, appariement |
| Effort | ~3× la boutique | ~10× la boutique |

**Recommandation : construire le jeu de collection, et s'arrêter là pour l'instant.**

Trois raisons, pas une :

1. **Le plaisir est dans l'ouverture du booster**, pas dans la partie. C'est vrai de
   tous les jeux de cartes numériques — l'ouverture est le moment.
2. **On ne peut pas équilibrer un jeu dont les cartes n'existent pas encore.** Les
   cartes doivent tourner une soirée ou deux avant qu'on sache ce qui est fort.
3. **En LAN, on joue déjà à des jeux.** Un second jeu complet entre en concurrence
   avec la soirée elle-même. Une collection, elle, tourne en fond tout le week-end
   sans réclamer d'attention.

Si le jouable arrive un jour, il arrivera par-dessus une collection qui existe et
que les gens ont déjà envie de posséder. Ne pas préconstruire pour ça.

---

## 3. Ce qui existe déjà dans ce repo (contexte indispensable)

**Architecture.** HTML/CSS/JS vanilla, pas de framework, pas de build à part
`build-config.js` qui génère `config.js` depuis les variables d'environnement
Vercel. Deux interfaces autonomes qui ne partagent aucun code d'affichage :

- `desktop.html` + `newScript.js` (~5900 lignes) + `style.css` — bureau
- `m.html` + `mobile.js` (~3000 lignes) + `mobile.css` — téléphone
- `core.js` — **toute la logique partagée**, sans DOM ni Firebase. C'est la garantie
  qu'un score calculé sur téléphone est identique à celui du PC. Toute règle de
  comptage se met là, et nulle part ailleurs.

**Base.** Firebase Realtime Database, écriture directe depuis le client. Les règles
(`database.rules.json`) sont la seule barrière. Auth Google. Rôles dans `lan/roles` :
`admin`, `mixologist`, `gamemaster`.

**Serverless.** Dossier `api/` sur Vercel, uniquement des proxys en lecture
aujourd'hui (Steam, Wikipédia, deals). `api/steam-library.js` montre le motif :
clé secrète en variable d'environnement, jamais côté client. **Aucune fonction
n'écrit dans Firebase pour l'instant** — voir §5.1.

**L'économie de points existe déjà** (construite juste avant ce plan) :

- `lan/economy/ledger/{id}` — registre en **écriture unique**, réservé aux
  `admin`/`gamemaster`. Aucun solde n'est stocké : `economyBalance()` dans `core.js`
  le recalcule à chaque fois.
- `lan/economy/ticks/{uid}` — gain passif auto-écrit mais **bridé par les règles**
  (une tranche par 10 min via `ServerValue.TIMESTAMP` comparé à `now`, plafond 60,
  seulement LAN active).
- `lan/economy/purchases/{id}` — le joueur dépose une demande `pending`, un
  maître du jeu tranche, et c'est **la validation** qui écrit le débit au registre.
- `lan/economy/catalog/{id}` — la boutique, tenue par les maîtres du jeu.

**Le principe qui gouverne tout ça, et qui gouvernera le TCG :** aucun état de
valeur n'est stocké tel quel. Il est **rejoué depuis un journal en écriture unique**.
C'est ce qui rend la triche structurellement impossible sans serveur.

**Autres faits utiles.**

- `api/get-game-image.js` résout un nom de jeu → image Steam, avec cache
  localStorage côté client. **Chaque carte a donc une illustration dès le premier
  jour**, avant tout travail d'illustration.
- `normalizeGameName()` dans `core.js` — la clé canonique d'un jeu. À réutiliser
  comme identifiant de carte.
- `lan/history` archive chaque soirée (`topGames`, `votes`, `economyStandings`).
- Les phases de soirée : `isVotingOpen` → `isLanActive` → `lanFinished`. Sur
  téléphone, `LAN_SCREENS` dans `mobile.js` verrouille les écrans hors phase.
- CSP dans `vercel.json` : `img-src 'self' data: https:` — **large, aucune
  modification nécessaire pour les illustrations**. Attention en revanche à
  `script-src` si un nouveau domaine apparaît (voir `SECURITY.md`).

**Contraintes de la machine et du projet.**

- **Pas de `node`, pas de `python`, pas de `bun` sur la machine de dev.** On ne peut
  rien exécuter localement. Vérifier une interface se fait avec un serveur statique
  PowerShell (`System.Net.HttpListener`) plus une copie jetable de la page dont les
  `<script>` Firebase sont remplacés par un stub qui expose `__emit(path, value)`.
  Les captures d'écran ne fonctionnent pas — vérifier numériquement
  (`getBoundingClientRect`, `getComputedStyle`).
- **Pousser sur `main` déploie en production.** Il n'y a pas de préproduction.
- **Ne jamais supprimer la base Firebase.** Elle contient les vraies données des
  amis de Grégory, rien d'autre ne les sauvegarde. Toute opération destructive sur
  un chemin Firebase se confirme avant.
- Les commentaires du code sont en français et expliquent **pourquoi**, pas quoi.
  S'y conformer.
- Le `cat > fichier <<'EOF'` du shell **abîme les backticks JS et les `\\`**. Pour
  du JS avec des littéraux de gabarit, écrire le fichier avec l'outil d'écriture,
  jamais par heredoc.

---

## 4. Le modèle de données

```
lan/tcg/
  set/{gameKey}            La carte-type de CE set. Régénérée à l'ouverture de la LAN.
    name, rarity, score, art, generatedAt

  packs/{packId}           Un booster acheté. Scellé jusqu'à l'ouverture.
    uid, status: 'sealed' | 'opened', cards: [...], boughtAt, openedAt, refId

  trades/{tradeId}         Journal des échanges, en écriture unique.
    fromUid, toUid, offer: [...], request: [...],
    status: 'pending' | 'accepted' | 'declined' | 'cancelled', ts
```

**Il n'y a pas de nœud `collection/{uid}`.** La collection d'un joueur est
**rejouée** dans `core.js` depuis les paquets ouverts et les échanges acceptés.
Même principe que le solde de points. C'est non négociable : un inventaire
modifiable est un inventaire que le joueur peut se fabriquer.

Une carte possédée est identifiée par `{gameKey, foil, instance}` où `instance`
distingue les doublons. Les doublons **ne se transforment pas en poussière** : ce
sont eux qui alimentent l'échange. Sans doublons, personne n'a rien à troquer.

---

## 5. Les trois problèmes durs

### 5.1 Le hasard des boosters — le seul point qui demande un serveur

Si le client tire les cartes, n'importe qui rejoue le tirage jusqu'à la légendaire.
Les règles Firebase savent valider une **forme**, jamais une **imprévisibilité**.

**Option A — le maître du jeu scelle (aucune infrastructure nouvelle).**
L'achat d'un booster passe par la file de validation qui existe déjà ; à la
validation, le client du maître du jeu tire les cartes et écrit le paquet scellé.
Le joueur ne fait que jouer l'animation de révélation.
*Pour :* zéro infrastructure, réutilise exactement le mécanisme des achats.
*Contre :* il faut un maître du jeu en ligne, et l'ouverture n'est pas instantanée.

**Option B — une fonction serverless tire (recommandée).**
`api/open-pack.js` sur Vercel, avec un compte de service Firebase Admin :
vérifie le jeton d'identité du joueur, vérifie qu'il possède bien un paquet scellé
non ouvert, tire, écrit le résultat, marque le paquet ouvert.
*Pour :* instantané, incontournable, la bonne réponse.
*Contre :* première écriture serveur du projet. Il faut ajouter `firebase-admin`
aux dépendances (`package.json` n'en a aucune aujourd'hui) et une clé de compte
de service en variable d'environnement Vercel.

**Recommandation : aller directement à B.** L'ouverture du booster *est* le
produit ; la faire attendre un humain la tue. Garder A en tête comme repli si la
clé de compte de service pose problème.

### 5.2 L'échange — résolu sans serveur, par le rejeu

Un échange déplace des cartes entre deux joueurs simultanément. Les règles Firebase
ne savent pas faire de transaction multi-parties, et ne savent pas rejouer un
journal pour vérifier qui possède quoi.

**La solution : ne rien empêcher à l'écriture, tout valider au rejeu.**

- A crée `trades/{id}` avec `fromUid === auth.uid` et `status: 'pending'`. Le nœud
  est ensuite immuable sauf son statut.
- B accepte en écrivant `status: 'accepted'` — la règle exige
  `auth.uid === data.child('toUid').val()` et que le statut précédent soit `pending`.
  Deux signatures, une seule écriture décisive.
- A peut annuler tant que c'est `pending` ; B peut refuser.

Les règles **ne vérifient pas** que A possédait vraiment les cartes offertes — elles
en sont incapables. Ça n'a aucune importance : la fonction de rejeu dans `core.js`
parcourt les échanges dans l'ordre et **ignore purement et simplement** tout
transfert dont l'émetteur ne possédait pas la carte à cet instant. Un échange
malhonnête n'est pas rejeté, il est **sans effet**. Ce qui compte n'est pas ce qu'on
écrit, c'est l'interprétation — et l'interprétation est déterministe et partagée.

Ajouter, comme pour le registre de points, que **le journal des échanges est
public**. Entre amis, la transparence fait le reste du travail.

### 5.3 Les illustrations

Trois niveaux, dans cet ordre :

1. **Jour 1 : l'image Steam.** `api/get-game-image.js` existe et marche. Toutes les
   cartes ont une illustration immédiatement, sans rien dessiner.
2. **Ensuite : les illustrations nano-banana-pro**, carte par carte, en remplacement.
   Le set se bonifie sans jamais être bloqué.
3. **Le brillant (foil)** n'est pas une image mais **un traitement CSS** : dégradé
   holographique animé, et sur téléphone une réaction à `deviceorientation`. Une
   carte brillante doit donner envie de bouger le téléphone pour la regarder.

**Où vivent les images :** dans le repo, sous `cards/<gameKey>.webp`, servies par
Vercel. Pas dans la Realtime Database — du base64 y ferait gonfler la synchro de
tous les clients. Le nom de fichier suit `normalizeGameName()`. Repli automatique
sur l'image Steam quand le fichier n'existe pas.

---

## 6. Raretés, boosters, taux

**Les raretés viennent du score de vote**, calculées à l'ouverture de la LAN :

| Rareté | Part du set | Sens |
|---|---|---|
| Légendaire | ~10 % | Les jeux qui ont gagné le vote |
| Rare | ~25 % | Le haut du classement |
| Peu commune | ~30 % | Le milieu |
| Commune | le reste | Les jeux cités une fois |

Le brillant est un **tirage indépendant** (~5 %) : n'importe quelle carte peut
sortir brillante, même une commune. C'est ce qui rend chaque ouverture tendue.

**Booster : 5 cartes**, au moins une peu commune ou mieux, et un compteur de
consolation qui garantit une légendaire toutes les N ouvertures sans.

**Attention à la taille du set.** Dix joueurs votent peut-être 20 à 40 jeux
distincts. C'est petit — donc complétable en une soirée, ce qui est bien, mais les
boosters s'épuisent vite. Prévoir dès le début que les doublons soient nombreux et
**assumés** : ce sont eux qui font vivre l'échange.

---

## 7. Découpage

**Phase 1 — le set et la collection.** Générer le set depuis les votes à l'ouverture
de la LAN. Écran collection : la grille du set, cartes possédées en couleur,
manquantes en silhouette, compteur de complétion. Les raretés se lisent. Pas encore
de booster : le maître du jeu peut créditer des cartes à la main pour tester.
*Livrable jouable :* on voit son set, on voit ce qui manque.

**Phase 2 — les boosters.** Le booster devient un article de la boutique (il existe
déjà, `lan/economy/catalog`). Achat → paquet scellé → ouverture → **animation de
révélation**, carte par carte, le brillant en dernier. C'est le cœur du produit,
c'est là qu'il faut mettre le soin. Fonction serverless de tirage (§5.1).
*Livrable jouable :* la boucle complète gagner → dépenser → ouvrir.

**Phase 3 — l'échange.** Proposition, acceptation à deux signatures, rejeu dans
`core.js`, journal public. Écran « proposer un échange » avec les doublons mis en
avant.
*Livrable jouable :* le jeu devient social.

**Phase 4 — la finition.** Foil réactif à l'orientation du téléphone, classement de
complétion, archivage du set dans `lan/history` à la fin de la soirée (un set par
LAN, qui reste consultable), illustrations personnalisées.

Chaque phase se termine par : règles Firebase republiées, vérification avec le
harnais, et une passe bureau **et** téléphone. Ne pas laisser une interface en
retard sur l'autre — la dette double à chaque fois.

---

## 8. Questions ouvertes pour Grégory

1. **Les cartes survivent-elles à la LAN ?** Les points, non — ils repartent à zéro
   à chaque soirée (`startNewLan`). Une collection qui se réinitialise n'a aucun
   sens : je pars du principe que **les cartes sont permanentes** et que chaque LAN
   ajoute son set à une collection qui grandit. À confirmer, c'est structurant.
2. **Deux systèmes de cartes en même temps ?** La boutique adopte la direction C —
   des cartes avec rareté. Le TCG aussi. Risque de confusion. Deux pistes : soit on
   les distingue par la forme (boutique = cartes d'action au format paysage, TCG =
   collectibles au format portrait), soit on assume un seul univers de cartes avec
   des cadres différents. Mon avis : **les distinguer par la forme**, et garder le
   même vocabulaire visuel.
3. **Qui peut échanger avec qui ?** Tout le monde, ou seulement les joueurs présents
   à la soirée en cours ?
4. **Les doublons servent-ils à autre chose qu'à l'échange ?** (fusion en brillant,
   conversion en points…) Mon avis : pas au début. Ça retire du carburant à
   l'échange.

---

## 9. Non négociable

- Aucun état de valeur stocké : collection et soldes se **rejouent** depuis des
  journaux en écriture unique.
- Toute la logique de comptage et de rejeu dans `core.js`, jamais dupliquée entre
  `newScript.js` et `mobile.js`.
- Les règles Firebase se republient à la main dans la console après chaque
  changement de `database.rules.json` — sinon la fonctionnalité échoue **en
  silence** (`permission_denied`). Documenter la mise à jour dans `SECURITY.md`
  comme pour l'économie.
- Pousser sur `main` déploie. Ne jamais supprimer de données Firebase sans
  confirmation explicite.
