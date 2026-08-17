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
