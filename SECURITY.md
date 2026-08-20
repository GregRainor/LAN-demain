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

### 1. Le registre (`lan/economy/ledger`) — écriture unique

Chaque ligne est un mouvement signé : qui, combien, pourquoi, par qui.

- `!data.exists()` interdit à la fois la modification et la suppression : une ligne écrite
  ne se réécrit plus. Le registre s'ajoute, il ne se corrige pas.
- **Créditer** (`type` autre que `purchase`) reste réservé aux rôles `admin` et `gamemaster`.
  Un joueur ne peut donc enrichir personne, lui-même compris.
- **Se débiter**, en revanche, un joueur le peut — et lui seul, pour lui-même. Une ligne de
  type `purchase` doit porter `uid === auth.uid`, un `delta` strictement **négatif**, et ce
  delta doit être **exactement l'opposé du prix affiché en boutique** :

  ```
  newData.child('delta').val() === 0 - root.child('lan/economy/catalog')
      .child(newData.child('itemId').val()).child('price').val()
  ```

  C'est ce qui rend l'achat instantané sans ouvrir de brèche : la seule ligne qu'un joueur
  sait écrire est celle qui l'appauvrit, du montant exact que la boutique annonce. Il ne peut
  ni s'offrir un article à moitié prix, ni créditer un ami, ni toucher au registre d'autrui.
- Le registre est en lecture publique, volontairement : chacun voit qui a reçu quoi et
  pourquoi.

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

### 3. Les achats (`lan/economy/purchases`) — immédiats

Acheter débite tout de suite. Il n'y a **plus de validation par un maître du jeu** : entre
amis, faire attendre quelqu'un devant un bouton n'apportait rien que de l'attente.

Le débit et l'achat partent dans la **même écriture multi-chemins** (`db.ref().update({...})`),
donc Firebase les applique ensemble ou pas du tout. Personne ne peut être débité sans son
article, ni recevoir un article sans être débité.

- Le joueur ne peut créer un achat qu'à son propre nom (`uid === auth.uid`), et seulement
  avec le statut `granted`.
- Le **prix est verrouillé** sur celui du catalogue, à la fois sur l'achat et sur la ligne de
  registre correspondante (voir §1). Impossible de s'offrir un article à 500 en écrivant 5.
- Un achat écrit n'est plus modifiable par son auteur.

**Limite assumée** : les règles Firebase ne savent pas additionner un registre, donc rien
n'empêche techniquement un client bricolé de dépenser plus qu'il n'a et de passer en négatif.
Trois raisons de l'accepter : l'interface refuse déjà l'achat quand le solde ne suit pas ; un
solde négatif s'affiche à tout le monde dans les fortunes ; et le registre est public, donc la
dépense de trop porte un nom. La seule parade réelle serait un serveur, ce que ce projet n'a
volontairement pas.

**Limite assumée** : un maître du jeu peut se créditer lui-même. C'est volontaire, le rôle est
un rôle de confiance — mais chaque crédit laisse une ligne signée et publique au registre.

**Reste de l'ancien fonctionnement** : les demandes `pending` déposées avant ce changement
restent visibles et tranchables par un maître du jeu. Sa file disparaît d'elle-même dès
qu'elle est vide.

### 4. Le catalogue (`lan/economy/catalog`)

Écriture réservée aux `admin` / `gamemaster`. `price` doit être un nombre positif, `name` et
`price` sont obligatoires.

### Remise à zéro entre deux soirées

`startNewLan()` archive le classement des fortunes dans `lan/history`, puis efface `ledger`,
`ticks` et `purchases`. Le **catalogue survit** (comme la carte officielle des kocktails) :
c'est un acquis curé au fil des soirées. Une fortune, elle, se gagne dans une soirée et ne se
transporte pas.

> ⚠️ **Mise à jour requise** : les règles `lan/economy` ont changé (achat immédiat : un
> joueur écrit désormais sa propre ligne de débit, validée sur le prix du catalogue). Tant
> qu'elles ne sont pas **republiées**, tout achat échouera avec `permission_denied at
> /lan/economy/ledger` — et l'échec est silencieux côté joueur.


## Les cartes de la soirée (`lan/tcg`)

Même principe que l'économie, poussé d'un cran : **rien de ce qui a de la valeur n'est
stocké**. Il n'existe aucun nœud `collection/{uid}`. La collection d'un joueur est **rejouée**
(`tcgReplay()` dans `core.js`) depuis les paquets ouverts et les échanges acceptés. Un
inventaire modifiable serait un inventaire qu'on se fabrique.

### 1. Le set (`lan/tcg/sets/$setId`, `lan/tcg/currentSet`)

Le set est un **relevé du groupe**, pas une invention. Chaque jeu des bibliothèques Steam devient
une carte, et sa rareté vient de deux choses qui s'additionnent : **combien de joueurs le
possèdent** (le terrain commun) et **ce que le vote en a dit** (l'envie). Un jeu que personne
d'autre n'a est banal — il y en a des centaines. Un jeu que tout le monde possède est rare, et
c'est en plus celui auquel on peut jouer ce soir sans que personne aille l'acheter. La rareté
raconte donc quelque chose de vrai, et la fiche d'une carte l'explique en une phrase.

**Un jeu sans illustration n'entre pas dans le set.** La jaquette Steam se déduit
de l'`appId`, sans le moindre appel réseau : un jeu qui n'en a pas (une entrée
Game Pass, un nom que Steam ne reconnaît pas) ferait une silhouette grise, et
une carte grise n'a aucune raison d'exister. Les jeux votés à la main sont
résolus une fois à la création du set — ce sont les plus réclamés, il serait
absurde qu'ils soient justement ceux qui manquent.

Écriture réservée aux `admin` / `gamemaster`.

Les **deux raretés de chasse sont réservées** aux cartes qui les méritent : partagée par au moins
deux joueurs, ou réclamée au vote. Un jeu que personne ne partage et que personne n'a demandé n'y
entre pas, même s'il reste de la place. La réserve s'arrête à « épique » : le booster garantit un
emplacement rare, et une rareté réduite à deux cartes servirait éternellement les mêmes.

Les **parts du set** (prestige 2 %, épique 4 %, rare 10 %, peu commune 24 %, commune 60 %) sont le
seul écart à Riftbound. Chez eux les parts sont presque plates parce qu'un set y est dessiné et
que les prestiges sont des versions alternatives ; ici c'est un relevé, où une quinzaine de jeux à
peine sont réellement partagés. Garder 15 % de prestige remplirait la rareté la plus haute au
hasard.

La **composition du booster**, elle, est exactement celle de Riftbound : 14 cartes — huit communes,
trois peu communes, un emplacement rare, un emplacement flex (épique une fois sur quatre, prestige
une fois sur douze) et un emplacement brillant. Toute rare et au-dessus sort brillante d'office, ce
qui garantit trois brillantes par paquet.

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

> ⚠️ **À REPUBLIER** : la carte du set porte désormais `owners` (combien de
> bibliothèques possédaient le jeu) et `appId` (sa jaquette Steam), et un nœud
> `lan/cardArt` reçoit les illustrations générées. Le nœud `cards/$game_key`
> refuse tout champ non listé : **tant que les règles ne sont pas republiées, la
> création du set échoue en entier**, avec un `permission_denied` et rien à
> l'écran.

## Les illustrations générées (`lan/cardArt`)

Les huit cartes Signature — le sommet du set — reçoivent une illustration
dessinée pour elles par Nano Banana Pro (`api/generate-card-art.js`). Trois
choix à connaître :

- **La clé vit dans `GEMINI_API_KEY`**, côté Vercel, jamais côté client. La
  fonction est protégée comme les autres proxys : contrôle d'origine et
  rate-limit par IP (`_guard.js`), avec un plafond bien plus bas — douze appels
  par minute, quand générer un set complet en demande huit. **Limite assumée**,
  identique à celle de `STEAM_API_KEY` mais avec un enjeu supérieur puisque
  chaque appel coûte : l'origine est spoofable en curl. Si la facture devait
  devenir un sujet, la vraie réponse est de vérifier le jeton Firebase du
  demandeur dans la fonction.
- **Les images sont stockées en base64 sous `lan/cardArt/{gameKey}`**, écriture
  réservée aux `admin` / `gamemaster`. Ce nœud est volontairement **à côté** de
  `lan/tcg` et non dedans : `lan/tcg` est suivi en permanence par tous les
  clients, et y mettre des images ferait transiter plusieurs mégaoctets à chaque
  connexion. Les clients lisent `lan/cardArt/{gameKey}` à la demande, carte par
  carte, et retiennent.
- **Une illustration est attachée au jeu, pas au set.** Recréer un set ne
  regénère donc que ce qui manque : une Signature déjà dessinée lors d'une
  soirée précédente est réutilisée telle quelle.
- **Rien n'est généré sans qu'on le demande.** La création d'un set ouvre le
  choix des illustrations ; on importe les siennes, et le bouton « Générer les
  manquantes » ne s'occupe que de ce qui reste. Une image importée n'est jamais
  écrasée par une génération. Les images importées sont redimensionnées à
  1024 px de large avant l'envoi : une photo de téléphone dépasserait sinon la
  limite de 4 Mo du nœud.

### Une collection est un brouillon jusqu'à la clôture de la soirée

C'est la règle qui gouverne tout le cycle de vie des cartes.

**Tant que la LAN n'est pas terminée**, recomposer un set (`discardCards()`)
efface **tous** les anciens sets, **tous** les paquets et **tous** les échanges.
Pas seulement ceux du set remplacé : n'effacer que le set courant laissait dans
les collections les cartes venues d'un set plus ancien, et le « nouveau départ »
n'en était pas un. C'est volontairement radical — pendant la mise au point, on
recompose le set autant de fois qu'il le faut, et chaque fois tout le monde
repart à zéro. La confirmation annonce le nombre exact de cartes et de boosters
détruits. Le ménage n'a lieu qu'**après** l'écriture du nouveau set : si elle
échoue, rien n'a été détruit.

**Une fois la LAN close** (`lanFinished`), les collections sont archivées : le
bouton « Recréer le set » disparaît, et l'appel est refusé même forcé. Il faut
rouvrir la soirée pour recomposer. `startNewLan()` archive au passage le
palmarès des collections dans `lan/history` (`tcgStandings` : le nom du set et,
par joueur, ce qu'il en avait) — ni les paquets ni les images, les uns se
rejouent et les autres pèsent trop.

Les illustrations (`lan/cardArt`) survivent à tout : elles sont attachées au jeu
et non au set, et les regénérer coûterait pour rien.

Sans clé configurée, la fonction répond 503 et les Signature gardent simplement
leur jaquette Steam. Rien d'autre ne change.

> ⚠️ **Mise à jour requise** : les règles `lan/tcg` ci-dessus sont nouvelles.
> Tant qu'elles ne sont pas **republiées** avec la procédure ci-dessous, l'écran
> Collection restera vide et la console affichera `permission_denied at
> /lan/tcg`. Composer le set, sceller un booster et proposer un échange
> échoueront tous, en silence.


## L'expérience et les hauts faits (`lan/xp`)

Les points (`lan/economy`) mesurent **une** soirée : ils se dépensent et repartent à zéro à
chaque clôture. L'expérience mesure **les** soirées : elle ne se dépense pas, et
`startNewLan()` ne la touche pas. C'est toute la différence, et c'est ce qui fait qu'un
vétéran de dix LAN reste devant sans que le nouveau soit largué.

### Un seul nœud, en écriture unique

```
lan/xp/awards/{awardId} = { uid, delta, type, reason, refId, by, ts }
```

- `.write` exige le rôle `admin` ou `gamemaster` **et** `!data.exists()` : une récompense
  écrite ne se réécrit pas et ne s'efface pas.
- `.validate` impose `delta >= 0` — l'expérience ne se retire jamais — et `ts <= now`.
- Aucun total n'est stocké : `xpTotal()` et `xpLevel()` dans `core.js` les recalculent, comme
  `economyBalance()` le fait pour les points.

### Les clés sont déterministes, et c'est ce qui rend l'attribution automatique sûre

- un jalon : `{uid}__ach__{achId}`
- une présence à une soirée : `{uid}__lan__{lanId}`
- un titre de soirée : `{uid}__title__{lanId}__{titleId}`

Deux maîtres du jeu en ligne écrivent donc **le même nœud** plutôt que deux récompenses. Le
doublon est impossible par construction, pas par vérification.

### Pourquoi les jalons doivent être inscrits, et pas seulement calculés

Un jalon comme « cinq achats » se calcule depuis `lan/economy` — qui est effacé à chaque
clôture. Sans trace écrite, un haut fait gagné ce soir se **reverrouillerait** à la prochaine
LAN. C'est la récompense au journal qui fait foi : le calcul sert seulement à décider quand
l'inscrire.

L'inscription est faite par les clients des maîtres du jeu (`grantPendingAchievements`),
exactement comme la validation des achats. Un joueur seul verra ses hauts faits « atteints »
sans être inscrits jusqu'à ce qu'un maître du jeu se connecte — c'est une dépendance assumée,
la même que pour la boutique.

**Limite assumée** : un maître du jeu peut s'inscrire une récompense qu'il n'a pas méritée, en
écrivant la clé à la main. C'est volontaire — le rôle est un rôle de confiance — et chaque
récompense porte `by`, donc reste attribuable.

### Les titres de soirée

Les jalons sont absolus (« cinq achats ») ; les titres sont comparatifs (« le plus gros
acheteur »). Un comparatif n'a de sens qu'une fois la soirée finie : `awardLanExperience()`
les décerne à la clôture, **avant** l'effacement — les compteurs qui les produisent n'existent
plus une ligne plus bas — et les archive dans `lan/history`.

> ⚠️ **Mise à jour requise** : les règles `lan/xp` sont nouvelles. Tant qu'elles ne sont pas
> **republiées** avec la procédure ci-dessous, la barre d'expérience restera à zéro, aucun
> haut fait ne s'inscrira, et la console affichera `permission_denied at /lan/xp`. Le reste de
> l'application continue de fonctionner : l'échec est silencieux côté joueur.


## Les défis et la boîte à idées (`lan/challenges`, `lan/claims`, `lan/suggestions`)

Un haut fait se **calcule** ; un défi se **raconte**. « Trente pompes », « une bière à 9 h du
matin » : aucune donnée de l'application ne pourra jamais les vérifier. C'est donc un humain
qui tranche — et c'est aussi ce qui rend la validation vivante plutôt qu'automatique.

C'est en outre la seule source d'expérience **répétable**. Les hauts faits sont une cagnotte
qu'on vide une fois ; sans les défis, les niveaux se figeaient vers 6 ou 7.

### Le principe qui gouverne tout

**Un joueur sait écrire un débit, jamais un crédit.** Il peut se débiter du prix exact d'un
article de la boutique (voir §1 de l'économie), mais toute ligne de registre POSITIVE reste
réservée aux `admin` / `gamemaster`. Réclamer un défi n'écrit donc rien de valeur : ça dépose
une demande. C'est la validation qui paie, et elle est faite par quelqu'un d'autre.

### `lan/challenges` — le catalogue

- Un `admin` / `gamemaster` crée, modifie et retire librement.
- Un joueur peut créer une entrée **uniquement** avec `status: 'proposed'` et
  `createdBy === auth.uid`, et la retirer tant qu'elle est proposée. Il ne peut pas l'ouvrir
  lui-même : passer à `status: 'open'` demande le rôle.
- Les propositions sont **plafonnées par les règles** à 300 zł et 200 XP. Sans ça on se
  proposerait un défi à dix mille — l'admin le verrait, mais autant que la base refuse.
- `title` est obligatoire et limité à 120 caractères ; `zl` et `xp` doivent être des nombres
  positifs.

### `lan/claims` — les réclamations

- Un joueur crée la sienne avec `status: 'pending'` et `uid === auth.uid`, et peut la retirer
  tant qu'elle est en attente.
- Seul un `admin` / `gamemaster` la résout.
- Le montant est **figé dans la réclamation** au moment où elle est déposée : si l'admin
  change le prix du défi demain, ce qui a été promis reste promis.
- `note` est limitée à 500 caractères, `ts` doit être passé.

**La validation est une écriture multi-chemins** : le sort de la réclamation, la ligne de
registre et la récompense d'expérience partent ensemble. Firebase applique tout ou rien —
impossible d'être payé sans que la réclamation soit close, ou l'inverse.

La clé de la récompense d'XP est déterministe : `{uid}__claim__{claimId}`. Deux admins qui
valident en même temps écrivent le même nœud plutôt que deux récompenses — un défi ne paie
jamais deux fois, structurellement.

### `lan/suggestions` — la boîte à idées

Un champ libre vers l'admin, et **une** réponse. Ce n'est pas un chat : deux tours suffisent
à « j'aimerais qu'on ajoute X », et un vrai fil demanderait des non-lus, des notifications et
de la modération pour un besoin qui tient en deux phrases.

- Un joueur crée la sienne (`uid === auth.uid`) et peut la supprimer.
- Seul un `admin` / `gamemaster` répond ou supprime celle d'un autre.
- Le texte est limité à 1000 caractères.
- **Lecture publique**, comme le registre : une idée lue par les autres a une chance d'être
  appuyée.

> ⚠️ **Mise à jour requise** : ces trois nœuds sont nouveaux. Tant que les règles ne sont pas
> **republiées**, l'écran Défis restera vide et la console affichera `permission_denied at
> /lan/challenges`. Réclamer, proposer et suggérer échoueront tous, en silence.

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
