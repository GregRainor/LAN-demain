# Titres et profils Signature

Le profil n'utilise que deux systèmes de noms :

1. le rang permanent donné automatiquement par le niveau d'XP ;
2. un titre permanent choisi librement parmi les hauts faits débloqués.

Les défis eux-mêmes et les prix comparatifs de fin de LAN ne personnalisent
jamais le profil. Seuls les titres ci-dessous possèdent une direction
artistique permanente.

## Rangs de niveau

Le rang n'est pas équipable. Il reste affiché sous le nom et le titre choisi.

1. Parfumé
2. Frais comme un gardon
3. Propre sur soi
4. Légèrement tiède
5. Moite
6. Suant
7. Point de bascule
8. Fermenté
9. Rance
10. Faisandé
11. Détectable depuis le couloir
12. Signalé par le voisinage
13. Zone de confinement
14. Périmètre évacué
15. Classé site pollué
16. Fermé au public par arrêté
17. Arme de dissuasion olfactive
18. Crime contre l'odorat
19. État de catastrophe naturelle
20. Incident diplomatique
21. Cas d'école en toxicologie
22. Convention de Genève, annexe VII

## Titres équipables

| Titre | Déblocage | Rareté | Matière |
|---|---|---|---|
| Le Client | 5 achats | Commune | Bronze |
| Le Pilier | 20 achats | Rare | Laiton |
| Le Dépensier | 500 zł dépensés | Peu commune | Cuivre |
| Le PIB de la LAN | 2 000 zł dépensés en une LAN | Signature | Platine |
| La CB en PLS | Finir une LAN après 1 000 zł dépensés avec moins de 20 zł | Épique | Carmin |
| La Crapule | Infliger un handicap | Peu commune | Grenat |
| Le Fléau du lobby | Infliger 5 handicaps en une LAN | Épique | Obsidienne |
| L'Ouvreur | Ouvrir 10 boosters | Peu commune | Indigo |
| Le Collectionneur | Posséder 50 cartes différentes | Rare | Saphir |
| L'Étincelant | Posséder 10 cartes brillantes | Épique | Prisme |
| Le Signataire | Obtenir une carte Signature | Signature | Or |
| Le Complétiste | Compléter un set | Signature | Émeraude |
| Le Négociant | Conclure 10 échanges | Rare | Sarcelle |
| L'Increvable | Atteindre le plafond de présence d'une LAN | Rare | Minuit |
| Le Meuble | Participer à 3 LAN | Commune | Chêne |
| Il habite ici | Participer à 7 LAN | Rare | Velours |
| Le bail est à son nom | Participer à 15 LAN | Signature | Ivoire |
| Le Revenant | Revenir après avoir manqué 3 LAN de suite | Épique | Braise |
| Le Couteau suisse | Valider un défi de chaque catégorie en une LAN | Épique | Spectre |
| Faker | Valider 15 défis en une LAN | Signature | Impérial |
| Seul contre tous | Faire gagner un jeu dont on était l'unique votant | Épique | Cobalt |
| Le Faiseur de roi | Voir son choix numéro un gagner 3 LAN | Signature | Royal |
| Le Cobaye originel | Avoir participé pendant la bêta | Rare | Prototype |

Les hauts faits d'introduction comme « Premier achat », « Premier paquet » et
« Premier échange » restent visibles dans la collection, mais ne débloquent
pas de titre.

### Titre de rôle

| Titre | Condition | Rareté | Matière |
|---|---|---|---|
| Administrator | Être administrateur de LAN-Demain | Signature | Polonia |

Administrator est le mot polonais naturel pour « administrateur ». Ce titre
ne rapporte pas d'XP et n'apparaît pas comme un haut fait : il constate le rôle
réel. Sa Signature reprend un blanc porcelaine et le carmin polonais, avec un
ruban bicolore abstrait. Les règles Firebase empêchent un joueur sans le rôle
admin de l'équiper.

## Familles d'animation

La matière détermine la palette ; la famille détermine la gestuelle. La rareté
ne fait qu'accélérer ou intensifier cette animation.

| Famille | Titres concernés | Mouvement |
|---|---|---|
| Commerce | achats et dépenses | balayage de caisse et grille de registre |
| Collection | boosters, cartes, échanges | reflet holographique et léger décalage de paquet |
| Coup bas | handicaps et compte vide | verrouillage de cible et trait sec |
| Ancienneté | présence et participation | orbites lentes et respiration du halo |
| Défis | polyvalence et Faker | impact bref puis étincelles |
| Votes | solitaire et faiseur de roi | rayonnement et couronne en suspension |
| Prototype | bêta | scan par paliers et micro-glitch |
| Polonia | Administrator | rubans blanc-carmin et éclat cérémoniel |

Toutes ces animations sont neutralisées par le réglage système
prefers-reduced-motion. Le texte ne participe jamais aux transformations les
plus vives : les noms, titres et descriptions restent lisibles et peuvent
occuper deux lignes sans se télescoper.

## Personnalisation

- Le bouton **Personnaliser** n'est visible que sur son propre profil.
- Le joueur peut équiper un titre débloqué ou revenir à son nom seul.
- Le titre équipe une palette, une matière, un motif et une intensité d'effet ;
  il n'y a pas de sélecteur de couleur libre.
- Le joueur choisit aussi trois hauts faits débloqués pour sa vitrine.
- Le choix est stocké dans `lan/users/{uid}` et survit aux clôtures de LAN.
- Les règles Firebase refusent un titre ou un trophée qui n'a pas été inscrit
  dans le journal permanent du joueur.

## Hors du système de personnalisation

- les noms et tuiles des défis de la LAN en cours ;
- les récompenses comparatives de clôture ;
- les prix humoristiques décernés manuellement ;
- les noms d'événements, de sets ou de cocktails ;
- les suggestions et créations temporaires de l'admin.
