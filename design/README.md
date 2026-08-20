# Refonte de l'interface — sources de la planche

Ce dossier contient les **maquettes** de la refonte proposée pour la boutique,
la collection, les défis et les hauts faits. Ce n'est pas du code applicatif :
rien ici n'est chargé par `desktop.html` ni par `m.html`.

Chaque `*.dc.html` est une planche autonome, ouverte côte à côte sur une toile
Claude Design. Les valeurs (couleurs, polices, rayons, espacements) sont
reprises telles quelles de `style.css` et `mobile.css` — pas d'arrondi au
multiple de 4, pas de police tierce.

| Fichier | Ce que ça montre |
| --- | --- |
| `Main.dc.html` | La boutique : bandeau joueur, rail à six entrées, catalogue en grille filtrée |
| `Collection.dc.html` | La collection : la planche du set en entier, les six panneaux devenus quatre onglets |
| `Defis.dc.html` | Les défis : les défis en cartes, mes réclamations en colonne |
| `Profil.dc.html` | Le profil : les 21 hauts faits, les titres, mes demandes |
| `Mobile.dc.html` | Le téléphone, aligné sur les mêmes six destinations |
| `Systeme.dc.html` | Le raisonnement : les quatre natures, 12 entrées → 6, le budget de défilement |
| `PisteB.dc.html` | Piste écartée : tout en tuiles sur un tableau unique |
| `PisteC.dc.html` | Piste écartée : une barre de commande, plus aucun menu |

`canvas.json` place les planches sur la toile et définit les deux pages.
`lan-demain-redesign.html` est la toile assemblée (fichier généré, publiée
comme Artifact) — on ne l'édite jamais à la main : on modifie les `*.dc.html`,
puis on ré-assemble.

## L'idée en une phrase

La boutique n'est pas chargée parce qu'elle contient trop de choses, mais
parce qu'elle en contient **quatre de natures différentes** empilées dans le
même tube : ce qui est à moi, ce que je fais, ce que je regarde, et ce que le
maître du jeu pilote. Séparées, chaque écran tient dans la fenêtre.
