# Refonte de l'interface — sources de la planche

Ce dossier contient les **maquettes** de la refonte proposée pour la boutique,
la collection, les défis et les hauts faits. Ce n'est pas du code applicatif :
rien ici n'est chargé par `desktop.html` ni par `m.html`.

Chaque `*.dc.html` est une planche autonome, ouverte côte à côte sur une toile
Claude Design. Les valeurs (couleurs, polices, rayons, espacements) sont
reprises telles quelles de `style.css` et `mobile.css` — pas d'arrondi au
multiple de 4, pas de police tierce.

### Avant la LAN

| Fichier | Ce que ça montre |
| --- | --- |
| `Hall.dc.html` | Rien de prévu : le souvenir de la dernière, et la porte de la suivante |
| `Vote.dc.html` | Vote ouvert : le bulletin, le classement en direct à côté |
| `Attente.dc.html` | Entre le vote et la soirée : compte à rebours et liste à télécharger |
| `Phases.dc.html` | Le modèle : ce qui s'allume à chaque phase, et pourquoi |

### Pendant la LAN

| Fichier | Ce que ça montre |
| --- | --- |
| `Main.dc.html` | La boutique : bandeau joueur, rail à six entrées, catalogue en grille filtrée |
| `Collection.dc.html` | La collection : la planche du set en entier, les six panneaux devenus quatre onglets |
| `Defis.dc.html` | Les défis : les défis en cartes, mes réclamations en colonne |
| `Profil.dc.html` | Le profil : les 21 hauts faits, les titres, mes demandes |
| `Mobile.dc.html` | Le téléphone, aligné sur les mêmes six destinations |

### Le raisonnement

| Fichier | Ce que ça montre |
| --- | --- |
| `Systeme.dc.html` | Les quatre natures, 12 entrées → 6, le budget de défilement |
| `PisteB.dc.html` | Piste écartée : tout en tuiles sur un tableau unique |
| `PisteC.dc.html` | Piste écartée : une barre de commande, plus aucun menu |

`canvas.json` place les planches sur la toile et définit les trois pages.
`lan-demain-redesign.html` est la toile assemblée (fichier généré, publiée
comme Artifact) — on ne l'édite jamais à la main : on modifie les `*.dc.html`,
puis on ré-assemble.

## L'idée en une phrase

La boutique n'est pas chargée parce qu'elle contient trop de choses, mais
parce qu'elle en contient **quatre de natures différentes** empilées dans le
même tube : ce qui est à moi, ce que je fais, ce que je regarde, et ce que le
maître du jeu pilote. Séparées, chaque écran tient dans la fenêtre.

## Les phases

Les cinq états viennent de `updateVotingUIState()` dans `newScript.js` : rien
de prévu, vote ouvert, vote clos, `isLanActive`, `lanFinished`. La coquille
— bandeau, rail, tablée — ne change jamais d'un état à l'autre ; ce sont les
destinations qui s'ouvrent. Verrouillé, jamais caché, comme le fait déjà
`.m-tab.is-locked` dans `mobile.css`.

Deux règles en découlent. Le solde n'apparaît que pendant la soirée, parce
qu'il n'existe qu'à ce moment-là ; le niveau et les hauts faits sont partout,
parce qu'ils comptent les soirées. Et une phase ne montre qu'un seul écran :
l'admin voit la même page que les autres, plus son entrée dans le rail.
