# Sécurité de LAN Demain

## Règles Firebase Realtime Database

Le fichier [`database.rules.json`](./database.rules.json) contient les règles de sécurité de la base.
Avant leur mise en place, tout utilisateur connecté avec un compte Google pouvait probablement
écrire **partout** : s'attribuer le rôle admin, supprimer les votes des autres, modifier les
réglages de la LAN, vider l'historique, etc.

### Ce que les règles garantissent

| Chemin | Lecture | Écriture |
|---|---|---|
| `status/$uid` (présence) | tout utilisateur connecté | uniquement soi-même |
| `lan/votes/$uid` | tout utilisateur connecté | soi-même, ou un admin (édition du vote d'un joueur, reset global) |
| `lan/settings` | tout utilisateur connecté | admins uniquement |
| `lan/roles` | tout utilisateur connecté | admins uniquement (personne ne peut s'auto-promouvoir) |
| `lan/history` | tout utilisateur connecté | admins uniquement |
| `lan/events/$id` | tout utilisateur connecté | création par soi-même, modif/suppression par le créateur ou un admin ; RSVP chacun pour soi |
| `lan/cocktails/masterList` | tout utilisateur connecté | admin ou mixologue |
| `lan/cocktails/oneshot/$id` | tout utilisateur connecté | création par soi-même, suppression par le créateur ou un admin |
| `lan/cocktails/orders/$id` | tout utilisateur connecté | commande par soi-même, "Servi" (suppression) par admin/mixologue ou l'auteur |
| `lan/notifications/$uid` | uniquement le destinataire | tout utilisateur connecté (nécessaire : les notifs (RSVP, shots, broadcasts) sont écrites côté client par l'expéditeur) |
| `lan/users/$uid` | tout utilisateur connecté | uniquement soi-même |
| `lan/steamLibraries/$steamId` | tout utilisateur connecté | tout utilisateur connecté (chacun peut ajouter la bibliothèque d'un ami, et la retirer en cas d'erreur) |
| `lan/tcg/sets` | tout utilisateur connecté | admin ou maître du jeu (composer le set depuis les votes) |
| `lan/tcg/packs/$packId` | tout utilisateur connecté | scellage par l'acheteur contre une demande validée, ouverture par le propriétaire ; jamais de modification ni de suppression |
| `lan/tcg/trades/$tradeId` | tout utilisateur connecté | création par l'émetteur, résolution par le destinataire ; contenu figé après création |

**Limite connue** : n'importe quel joueur connecté peut écrire une notification à n'importe qui
(c'est le fonctionnement actuel de l'app : broadcasts, shots et rappels sont envoyés côté client).
Entre amis c'est acceptable ; la vraie solution serait de passer les envois de notifications par
une fonction serverless. À traiter dans un futur audit.

**Note** : l'UID admin `ITe5VPuwewMzO7JnJA5oPWMdfvt2` est codé en dur dans les règles comme
garde-fou anti-lockout (même valeur que la variable d'environnement `ADMIN_UID` sur Vercel).
Si l'UID admin change, mettre à jour les deux.

> ⚠️ **Mise à jour requise** : la règle `lan/steamLibraries` a été ajoutée. Les
> bibliothèques Steam sont désormais indexées par compte Steam (et non par joueur
> connecté), pour qu'on puisse ajouter celle d'un ami sans écraser la sienne.
> Tant que les règles ne sont pas **republiées** avec la procédure ci-dessous, le
> panneau « Bibliothèques Steam » restera vide et la console affichera
> `permission_denied at /lan/steamLibraries`.


## L'économie de la soirée (`lan/economy`)

C'est la première fonctionnalité où écrire dans la base peut **enrichir** celui qui écrit.
Tout le reste de l'app est déclaratif — personne ne gagne rien à mentir sur son vote. Ici si,
et la conception en tient compte : **aucun solde n'est stocké**. Un solde se recalcule
toujours (`economyBalance()` dans `core.js`) à partir de deux sources, chacune protégée
différemment.

### 1. Le registre (`lan/economy/ledger`) — écriture unique, maîtres du jeu uniquement

Chaque ligne est un mouvement signé : qui, combien, pourquoi, par qui.

- `.write` exige le rôle `admin` ou `gamemaster` **et** `!data.exists()`.
- `!data.exists()` interdit à la fois la modification et la suppression : une ligne écrite
  ne se réécrit plus. Le registre s'ajoute, il ne se corrige pas.
- Un joueur ordinaire ne peut donc **jamais** créditer qui que ce soit, lui-même compris.
- Le registre est en lecture publique, volontairement : chacun voit qui a reçu quoi et
  pourquoi. La transparence fait ici le travail qu'un serveur ferait ailleurs.

### 2. Le compteur de présence (`lan/economy/ticks/{uid}`) — auto-écrit, mais bridé par les règles

C'est le gain passif. Le joueur incrémente lui-même son compteur, et les règles imposent le
rythme :

- `count` ne peut avancer que de **exactement 1** par écriture ;
- `lastTick` doit être **au moins 600 000 ms** après le précédent ;
- `lastTick` est écrit en `ServerValue.TIMESTAMP` et comparé à `now`, donc **l'horloge du
  client ne compte pas** — avancer sa montre ne donne rien ;
- `count` est plafonné à **60** (dix heures) ;
- l'écriture n'est autorisée que si `lan/settings/isLanActive === true` ;
- `$other: {".validate": false}` interdit tout autre champ sous le nœud.

Le compteur est indexé par **joueur**, pas par session : ouvrir le téléphone en plus du PC ne
double pas les gains, le second appareil se fait simplement refuser sa tranche.

Ces deux nombres (600000 et 60) sont aussi dans `core.js` (`ECONOMY`). Un fichier de règles ne
peut ni importer ni commenter : **ce sont les règles qui font foi**, `core.js` ne fait
qu'afficher. Changer l'un sans l'autre casse silencieusement le compteur.

### 3. Les demandes d'achat (`lan/economy/purchases`) — proposées, jamais auto-validées

Acheter ne débite pas. Le joueur dépose une demande `pending` ; un maître du jeu la valide,
et c'est **lui** qui écrit la ligne de débit au registre.

- Le joueur ne peut créer une demande qu'à son propre nom (`uid === auth.uid`) et seulement
  avec le statut `pending`.
- Le **prix est verrouillé** à la création sur celui du catalogue :
  `newData.child('price').val() === root.child('lan/economy/catalog').child(itemId).child('price').val()`.
  Impossible de s'offrir un article à 500 en écrivant 5.
- Une fois créée, la demande n'est plus modifiable par son auteur : il peut seulement la
  **retirer** tant qu'elle est `pending`. Seul un maître du jeu la tranche.

**Limite assumée** : les règles Firebase ne savent pas additionner un registre, donc elles ne
peuvent pas empêcher une demande qui dépasse le solde. C'est le maître du jeu qui tranche —
l'interface lui affiche le solde de l'acheteur au moment de valider, et l'avertit en rouge si
l'achat le ferait passer en négatif. C'est le garde-fou contre un client bricolé.

**Limite assumée** : un maître du jeu peut se créditer lui-même. C'est volontaire, le rôle est
un rôle de confiance — mais chaque crédit laisse une ligne signée et publique au registre.

### 4. Le catalogue (`lan/economy/catalog`)

Écriture réservée aux `admin` / `gamemaster`. `price` doit être un nombre positif, `name` et
`price` sont obligatoires.

### Remise à zéro entre deux soirées

`startNewLan()` archive le classement des fortunes dans `lan/history`, puis efface `ledger`,
`ticks` et `purchases`. Le **catalogue survit** (comme la carte officielle des kocktails) :
c'est un acquis curé au fil des soirées. Une fortune, elle, se gagne dans une soirée et ne se
transporte pas.

> ⚠️ **Mise à jour requise** : les règles `lan/economy` ci-dessus sont nouvelles.
> Tant qu'elles ne sont pas **republiées** avec la procédure ci-dessous, l'onglet
> Boutique restera vide et la console affichera `permission_denied at
> /lan/economy`. Le gain passif et les achats échoueront eux aussi, en silence.


## Les cartes de la soirée (`lan/tcg`)

Même principe que l'économie, poussé d'un cran : **rien de ce qui a de la valeur n'est
stocké**. Il n'existe aucun nœud `collection/{uid}`. La collection d'un joueur est **rejouée**
(`tcgReplay()` dans `core.js`) depuis les paquets ouverts et les échanges acceptés. Un
inventaire modifiable serait un inventaire qu'on se fabrique.

### 1. Le set (`lan/tcg/sets/$setId`, `lan/tcg/currentSet`)

Le set se compose à partir du classement des votes — les jeux demandés occupent le haut, et leur
rareté est leur score — complété par tous les jeux connus des bibliothèques Steam du groupe, qui
en forment le fond. Écriture réservée aux `admin` / `gamemaster`.

Raretés, proportions et composition du booster sont calquées sur **Riftbound** : cinq tiers
(prestige 15,3 %, épique 11,9 %, rare 23,8 %, peu commune 23,8 %, commune 25,2 %), et un booster
de 14 cartes — huit communes, trois peu communes, un emplacement rare, un emplacement flex
(épique une fois sur quatre, prestige une fois sur douze) et un emplacement brillant. Toute rare
et au-dessus sort brillante d'office, ce qui garantit trois brillantes par paquet.

On ne remplace jamais un set : on en compose un nouveau et `currentSet` pointe dessus. Les
paquets déjà ouverts gardent le `setId` sous lequel ils ont été tirés, donc leur contenu reste
rejouable à l'identique — sans quoi recomposer un set réécrirait la collection de tout le monde.
Le bouton de création refuse d'ailleurs quand un set existe déjà : il faut passer par « Recréer le
set », explicite.

La clé d'une carte est `cardKey()` : `normalizeGameName()` dont les caractères interdits dans
un chemin Firebase (`.` `$` `#` `[` `]` `/`) sont remplacés par `_`. Sans ça, un jeu comme
« S.T.A.L.K.E.R. » ferait échouer la composition du set sans le moindre message.

### 2. Le hasard des boosters (`lan/tcg/packs/$packId`) — le sceau serveur

C'est le seul endroit de l'app où un tirage aléatoire décide de quelque chose de convoité.
Si le client tirait, n'importe qui rejouerait le tirage jusqu'à la prestige. Les règles
Firebase savent valider une **forme**, jamais une **imprévisibilité**.

La réponse tient en une ligne : **le contenu d'un paquet n'est pas stocké, il se recalcule
depuis son sceau**, et le sceau est l'horodatage écrit par le serveur.

- `sealedAt` doit valoir `now` — c'est-à-dire `ServerValue.TIMESTAMP` résolu côté serveur.
  C'est la seule valeur de cette application que le client ne choisit pas.
- Le contenu est `drawPack(set, hash(packId | sealedAt | uid))` : déterministe, donc tous les
  clients recalculent le même paquet ; imprévisible, parce que personne ne connaît la
  milliseconde du serveur avant d'écrire.
- Le nœud est en **écriture unique** (`!data.exists()`) : on ne rescelle pas pour retenter sa
  chance. Un seul jet, et il est déjà joué au moment de l'achat.
- `$packId` **est** l'identifiant de la demande d'achat. Un achat validé donne donc exactement
  un paquet, structurellement : le chemin est déjà pris.
- Les règles vérifient que cette demande existe, qu'elle appartient à `auth.uid`, qu'elle est
  `granted`, et que l'article visé porte bien `kind: 'pack'`.
- La seule transition ensuite est `sealed → opened` par le propriétaire, avec `openedAt = now`
  et tous les autres champs inchangés. Un paquet ouvert ne se referme pas.
- Un `gamemaster` peut créer un paquet cadeau (récompense, test) pour n'importe qui. Même
  contrainte de sceau : il ne choisit pas plus le contenu que les autres.

Aucune fonction serverless, aucune clé de compte de service, aucune dépendance ajoutée.

### 3. Les échanges (`lan/tcg/trades/$tradeId`) — validés au rejeu, pas à l'écriture

Un échange déplace des cartes entre deux joueurs simultanément. Les règles Firebase ne savent
faire ni transaction multi-parties, ni rejouer un journal pour vérifier qui possède quoi.

Elles ne l'essaient donc pas. Ce qu'elles garantissent :

- création par l'émetteur seul (`fromUid === auth.uid`), vers quelqu'un d'autre, en `pending` ;
- acceptation ou refus par le destinataire seul, annulation par l'émetteur seul ;
- **le contenu est figé** : `offer` et `request` sont des chaînes d'identifiants séparés par
  des virgules, et la règle exige `newData.child('offer').val() === data.child('offer').val()`
  à la résolution. C'est la raison de ce format : une liste Firebase ne se compare pas en une
  expression, et sans cette égalité, celui qui accepte pourrait réécrire l'offre en sa faveur
  avant de signer.

Ce que les règles **ne** garantissent **pas** : que l'émetteur possédait vraiment ce qu'il
offre. Elles en sont incapables — et ça n'a aucune importance. `tcgReplay()` parcourt les
échanges dans l'ordre et **ignore purement et simplement** tout transfert dont une des deux
parties ne possédait pas sa mise à cet instant. Un échange malhonnête n'est pas rejeté, il est
**sans effet**, et le journal public l'affiche comme tel. Ce qui compte n'est pas ce qu'on
écrit, c'est l'interprétation — et l'interprétation est déterministe et partagée.

### 4. Ce qui survit à une nouvelle soirée

`startNewLan()` ne touche pas à `lan/tcg`. Les points repartent à zéro, les cartes non : une
collection qui se réinitialise ne se collectionne pas. Chaque LAN ajoute son set à une
collection qui grandit.

> ⚠️ **Mise à jour requise** : les règles `lan/tcg` ci-dessus sont nouvelles.
> Tant qu'elles ne sont pas **republiées** avec la procédure ci-dessous, l'écran
> Collection restera vide et la console affichera `permission_denied at
> /lan/tcg`. Composer le set, sceller un booster et proposer un échange
> échoueront tous, en silence.


### Comment les appliquer

1. Ouvrir la [console Firebase](https://console.firebase.google.com/) → projet **lan-party-planner-qqggx**.
2. Menu **Realtime Database** → onglet **Règles**.
3. Remplacer tout le contenu par celui de `database.rules.json`.
4. Cliquer **Publier**.
5. Vérifier ensuite sur le site : voter, créer un événement, commander un cocktail, et avec un
   compte **non-admin**, vérifier qu'on ne peut PAS s'attribuer un rôle (l'app doit afficher une
   erreur de permission si on essaie via la console du navigateur).

### Autres points de sécurité traités (mars 2026 → aujourd'hui)

- Clés Firebase retirées du repo : `config.js` est généré au build par `build-config.js`
  depuis les variables d'environnement Vercel. (La config web Firebase n'est pas un secret
  en soi, mais ça évite de la versionner.)
- Échappement HTML (`escapeHtml`) de tous les contenus saisis par les joueurs (noms de jeux,
  événements, cocktails, messages) avant insertion dans le DOM : anti-XSS.
- `api/verify-recaptcha.js` (code mort entièrement commenté) supprimé.
