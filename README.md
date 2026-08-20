# LAN Demain 🚀

## Le Sélecteur de Jeux Ultime pour votre Prochaine LAN Party

**LAN Demain** est une application web complète conçue pour simplifier l'organisation de votre prochaine LAN. Fini les discussions interminables sur Discord ou les sondages qui n'en finissent plus ! Chaque participant vote pour ses jeux préférés, et l'application calcule et affiche en temps réel le classement des jeux les plus populaires, le tout dans un tableau de bord dynamique et sécurisé.

Ce projet est parti d'une simple idée de tableur Excel pour évoluer vers une application web full-stack moderne.

## ✨ Fonctionnalités

* **Système de Vote par Priorité :** Chaque joueur classe ses jeux par ordre de préférence (P1, P2, P3...), et un score est attribué à chaque jeu.
* **Tableau de Bord en Temps Réel :** Les votes, scores et classements sont mis à jour instantanément pour tous les utilisateurs connectés grâce à Firebase Realtime Database.
* **Date, Lieu & Compte à Rebours :** L'admin annonce quand et où se tient la LAN ; la date, l'adresse et le temps restant s'affichent sur l'écran de vote, l'écran d'attente et le programme. Un bouton « Ajouter à mon agenda » génère un fichier `.ics`.
* **Programme de la Soirée :** Un calendrier regroupe les événements par journée, dans l'ordre où ils se jouent (les shots de minuit restent en fin de soirée, pas au petit matin), avec un repère « maintenant » et la mise en avant du prochain événement.
* **Indicateurs de Performance (KPIs) :** Visualisez en un clin d'œil le jeu gagnant, le nombre de votants et le total des jeux proposés.
* **Visualisation Graphique :** Un graphique à barres animé affiche les scores des jeux les plus populaires.
* **Podium Stylisé :** Le top 3 des jeux est mis en évidence dans le classement et sur le graphique avec des médailles d'Or, d'Argent et de Bronze.
* **Authentification Sécurisée :** Connexion simple et rapide via un compte Google. Seuls les utilisateurs authentifiés peuvent participer.
* **Édition & Suppression des Votes :** Chaque utilisateur peut modifier ou supprimer son propre vote après l'avoir soumis.
* **Correction Intelligente des Typos :** L'application détecte les fautes de frappe (ex: "Valorent" vs "Valorant") et propose de fusionner les votes pour ne pas diviser les scores.
* **Miniatures de Jeux Automatiques :** Les images des jeux sont récupérées dynamiquement via l'API Steam pour une présentation plus vivante.
* **Architecture Sécurisée :** Les clés d'API secrètes sont protégées côté serveur grâce à des Fonctions Serverless sur Vercel.
* **Boutique & Points :** Une économie interne à la soirée. On gagne des points par la présence
  (une tranche toutes les dix minutes, plafonnée) et par les crédits d'un **maître du jeu**, qui
  récompense défis et exploits. On les dépense en privilèges, handicaps à jouer sur un autre
  joueur, et cosmétiques. Aucun solde n'est stocké : il se recalcule depuis un registre public
  en écriture unique, ce qui rend la triche structurellement impossible (voir [`SECURITY.md`](./SECURITY.md)).
  Les points ne servent jamais à payer à boire ou à manger : le bar reste gratuit.
* **Les Cartes de la Soirée :** Un jeu de collection **dont le set est un relevé du groupe**.
  Chaque jeu des bibliothèques Steam devient une carte, et sa rareté vient de deux choses qui
  s'additionnent : **combien de joueurs le possèdent** et **ce que le vote en a dit**. Un jeu que
  personne d'autre n'a est banal — il y en a des centaines. Un jeu que tout le monde possède est
  rare, et c'est celui auquel on peut jouer ce soir sans que personne aille l'acheter. La rareté
  raconte donc quelque chose de vrai, et la fiche d'une carte l'explique : « Tout le monde l'a
  (6 bibliothèques sur 6) ». Les deux raretés de chasse sont réservées aux jeux réellement
  partagés ou réclamés : rien n'y entre au hasard.
  Les huit cartes du sommet sont des **Signature** : elles reçoivent une illustration dessinée pour
  elles par Nano Banana Pro à la création du set, et sortent une ouverture sur quarante-trois. Un
  jeu dont on ne sait pas montrer l'illustration n'entre pas dans le set du tout.
  La composition du booster est calquée sur **Riftbound** (le JCC League of Legends) : 14 cartes —
  huit communes, trois peu communes, un emplacement rare, un flex qui donne une épique une fois sur
  quatre, un emplacement brillant — et trois brillantes garanties à chaque ouverture. On déchire le
  paquet au doigt, les cartes se retournent une à une dans un éclat coloré par leur rareté (les
  deux plus hautes secouent l'écran), la planche s'étale, puis les quatorze se rassemblent quand on
  les range. Le brillant est un traitement holographique qui suit la souris sur PC et l'inclinaison
  du téléphone sur mobile. Chaque carte garde sa **provenance** — qui l'a sortie du paquet, quand,
  et par combien de mains elle est passée : c'est un souvenir de soirée, pas une ligne
  d'inventaire. Les points repartent à zéro entre deux LAN, les cartes non.
* **Un Hasard Sans Serveur :** le contenu d'un booster n'est stocké nulle part — il se recalcule à
  partir de son *sceau*, l'horodatage écrit par le serveur Firebase au moment de l'achat. C'est la
  seule valeur de l'application que le client ne choisit pas : le tirage est donc imprévisible
  (personne ne connaît la milliseconde du serveur) et vérifiable par tout le monde (chacun rejoue
  le même paquet). Aucune fonction serverless de tirage, aucune dépendance.
* **Design Responsive :** L'interface est utilisable aussi bien sur ordinateur que sur mobile.

## 🛠️ Stack Technique

* **Frontend :** HTML5, CSS3, JavaScript (Vanilla JS, ES6+)
* **Backend & Base de Données :** Firebase (Authentication, Realtime Database)
* **Hébergement & Fonctions Serverless :** Vercel
* **APIs Externes :** Google reCAPTCHA Enterprise API, Steam API

## ⚙️ Guide d'Installation et de Déploiement

Voici les étapes pour déployer votre propre instance de "LAN Demain".

### Étape 1 : Prérequis

* Un **compte Google** pour accéder à Firebase et Google Cloud.
* Un **compte GitHub** pour héberger le code et le lier à Vercel.
* Une **Clé d'API Steam** (recommandé pour les images de jeux). Vous pouvez l'obtenir [ici](https://steamcommunity.com/dev/apikey).

### Étape 2 : Configuration de Firebase

1.  Créez un nouveau projet sur la [console Firebase](https://console.firebase.google.com/).
2.  Ajoutez une application web à votre projet (allez dans les paramètres du projet ⚙️ > "Mes applications"). Copiez l'objet de configuration `firebaseConfig` qui vous est fourni.
3.  Dans le menu **Authentication**, allez dans l'onglet "Sign-in method" et activez le fournisseur **Google**.
4.  Dans le menu **Realtime Database**, créez une base de données. Une fois créée, allez dans l'onglet **"Rules"** et collez le contenu du fichier [`database.rules.json`](./database.rules.json) (voir [`SECURITY.md`](./SECURITY.md) pour le détail de ce que chaque règle protège).
5.  Publiez les règles.

### Étape 3 : Configuration de Google Cloud & reCAPTCHA

1.  Allez sur la [console Google Cloud](https://console.cloud.google.com/) et sélectionnez le même projet que celui de Firebase.
2.  **Activer l'API reCAPTCHA Enterprise :** Dans le menu de recherche, tapez et activez "reCAPTCHA Enterprise API".
3.  **Créer une clé reCAPTCHA :** Une fois l'API activée, créez une clé. Choisissez "Site Web", donnez-lui un nom, et ajoutez votre futur domaine Vercel (ex: `mon-projet.vercel.app`) dans la liste des domaines. Copiez la **Clé du site** (commence par `6L...`).
4.  **Configurer l'écran de consentement :** Allez dans **APIs et services > Écran de consentement OAuth**. Assurez-vous que le type d'utilisateur est "Externe". Dans la section "Utilisateurs test", ajoutez les adresses e-mail des comptes Google qui auront le droit de se connecter.
5.  **Créer une Clé d'API :** Allez dans **APIs et services > Identifiants**. Cliquez sur "+ CRÉER DES IDENTIFIANTS" > "Clé d'API". Copiez cette clé. Pour plus de sécurité, cliquez sur la clé créée et limitez son usage à l'API "reCAPTCHA Enterprise API".

### Étape 4 : Configuration du Projet Local

1.  Créez un dossier pour votre projet (ex: `lan-demain`).
2.  À l'intérieur, créez la structure de fichiers suivante :
    ```
    lan-demain/
    ├── api/
    │   ├── get-game-image.js
    │   └── verify-recaptcha.js
    ├── .gitignore
    ├── core.js         logique partagée par les deux interfaces
    ├── desktop.html    interface bureau
    ├── newScript.js
    ├── style.css
    ├── m.html          interface téléphone
    ├── mobile.js
    ├── mobile.css
    └── vercel.json     aiguillage bureau / téléphone
    ```
3.  Collez le code fourni pour chaque fichier à son emplacement respectif.
4.  Dans `config.js`, remplacez les placeholders de la `firebaseConfig` par votre propre configuration obtenue à l'étape 2. En production, ce fichier est généré par `build-config.js` à partir des variables d'environnement.

### Étape 5 : Déploiement sur Vercel

1.  Créez un nouveau repository sur GitHub et poussez-y le contenu de votre dossier de projet.
2.  Créez un compte sur [Vercel](https://vercel.com/) et liez-le à votre compte GitHub.
3.  Importez votre repository GitHub sur Vercel. Vercel détectera automatiquement la structure et proposera de déployer.
4.  **Avant de déployer**, allez dans les paramètres du projet sur Vercel : **Settings > Environment Variables**. Créez les variables suivantes :
    * `GOOGLE_CLOUD_API_KEY` : La clé d'API créée à l'étape 3.
    * `GOOGLE_CLOUD_PROJECT_ID` : L'identifiant de votre projet Google Cloud (ex: `lan-party-planner-qqggx`).
    * `STEAM_API_KEY` : Votre clé d'API Steam personnelle.
    * `GEMINI_API_KEY` : (optionnel) clé Google AI Studio, pour faire dessiner les illustrations
      des cartes Signature par Nano Banana Pro. Sans elle, ces cartes gardent leur jaquette Steam.
5.  Lancez le déploiement. Une fois terminé, votre application sera en ligne !

## 📖 Comment Utiliser l'Application

1.  Rendez-vous sur l'URL de votre application fournie par Vercel.
2.  Cliquez sur **"Se connecter avec Google"**.
3.  Une fois connecté, votre vote est chargé (si vous avez déjà voté). Vous pouvez ajouter ou supprimer des jeux dans chaque catégorie de priorité.
4.  Cliquez sur **"Soumettre mon Vote"** pour enregistrer vos choix.
5.  Pour éditer le vote d'un autre joueur (si vous êtes admin), sélectionnez son nom dans le menu déroulant.
6.  Profitez des résultats qui se mettent à jour en temps réel !

## 🙏 Remerciements

Un immense merci pour cette collaboration ! Ce fut un plaisir de construire cet outil de A à Z et de le voir évoluer d'une simple idée à une application web complète et robuste.

Profitez bien de votre LAN !
