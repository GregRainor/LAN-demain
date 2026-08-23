# Contrat de navigation et de surfaces mobiles

Ce document fixe les invariants de la coque téléphone de LAN Demain. Il sert de garde-fou aux prochaines refontes : l'interface peut changer d'apparence, pas devenir une impasse selon la phase de la LAN.

## Phases et destinations

La fonction `phase()` est l'unique source de vérité pour l'accès aux écrans.

| Phase | Racine de repli | Destinations propres à la phase |
| --- | --- | --- |
| `waiting` | `soiree` | aucune |
| `vote` | `soiree` | `vote` |
| `lan` | `soiree` | `boutique`, `miam`, `sondages`, `evenements`, `kocktails` |
| `finished` | `bilan` | `bilan` |

`jeux`, `plus`, `cartes`, `biblio`, `historique`, `defis`, `hauts-faits` et `admin` restent consultables selon leurs propres permissions. Les écritures sensibles conservent leurs contrôles métier et Firebase.

## Invariants de navigation

1. Toute destination portant `data-goto` passe par `screenAvailable()`.
2. Une destination indisponible est visuellement verrouillée, porte `aria-disabled="true"` et, si c'est un bouton, reçoit réellement `disabled`.
3. Un clic refusé ne modifie jamais `currentScreen` ni l'historique.
4. Une ancienne entrée de l'historique devenue invalide est remplacée par la racine de repli de la phase. Elle ne doit jamais laisser l'application avec aucun écran actif.
5. Si la phase change en temps réel pendant la consultation d'un écran désormais interdit, `renderLocks()` répare immédiatement l'écran courant et l'entrée d'historique.
6. Les onglets sont des racines (`replaceState`) ; les écrans secondaires s'empilent (`pushState`) et le bouton Retour du téléphone doit les dépiler normalement.

## Contrat des feuilles glissantes

- Le panneau borne la hauteur à la fenêtre et masque uniquement ce qui dépasse de son cadre. Une Signature reçoit `m-sheet--profile` et une hauteur explicite de `90dvh` : cette contrainte est nécessaire pour que le corps flex puisse réellement rétrécir.
- Le corps `.m-sheet__body` est le seul propriétaire du défilement vertical : `flex: 1 1 auto`, `min-height: 0`, `overflow-y: auto` et `touch-action: pan-y` vont ensemble.
- La racine `.m-prof` ne doit jamais rétrécir (`flex: 0 0 auto`). Son `overflow: hidden` sert seulement à contenir les motifs Signature ; si elle rétrécit, il coupe silencieusement les trophées.
- Une fiche Signature longue doit être testée avec une vitrine, la personnalisation ouverte et la liste complète de hauts faits.
- Chaque ouverture remet le corps en haut. La zone sûre inférieure doit rester visible au-dessus de la barre système du téléphone.

## Contrat de l'en-tête

Les boutons ronds de l'en-tête ont une boîte tactile de 44 px. Le pictogramme de notification est un SVG `display: block` dans un bouton sans padding ni hauteur de ligne implicite ; cela évite le décalage optique introduit par les styles natifs des boutons.

## Matrice de vérification avant publication

- Largeurs : 320, 360, 390 et 430 px.
- Phases : attente, vote ouvert sans LAN active, LAN active, LAN terminée.
- Parcours : onglet racine → écran secondaire → Retour ; changement de phase sur un écran secondaire ; retour navigateur vers une destination devenue verrouillée.
- Feuilles : profil sans titre, Signature longue, Polonia, atelier de personnalisation, notifications longues.
- En-tête : cloche sans badge, avec un chiffre et avec deux chiffres.
- Lancer `node scripts/verify-mobile.js`, puis vérifier la version réellement servie par Vercel. Une publication Vercel ne publie pas les règles Firebase.

## Publication et retour arrière

Avant chaque correctif mobile en production, poser un tag `rollback-before-...` sur la révision actuellement en ligne. Le commit de correction ne doit contenir ni données Firebase, ni pièces jointes, ni mockups exploratoires. Les propositions de design restent hors du dépôt tant qu'elles ne sont pas validées.
