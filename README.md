# REBOOT Web

Application web statique local-first pour suivre le budget hebdomadaire d'un foyer. L’APP compacte regroupe la semaine en cours, les mouvements, les charges et les réserves, dont une réserve Santé créée par défaut.

## Structure

- `web/` : application exécutable, calculateur, PWA et ressources servies par Nginx.
- `docs/` : PRD, documentation et notes de conception.
- `dev-server.mjs` : serveur web local de développement, sans Docker.
- `Dockerfile` : image Nginx statique.
- `docker-compose.yml` : environnement local de test.

## Développement local

Depuis la racine du projet :

```bash
node dev-server.mjs
```

Puis ouvrir : <http://127.0.0.1:4173/app.html>

Le serveur ne dépend pas de Docker et désactive le cache HTTP. Il utilise une origine différente de l'ancienne instance Docker (`localhost:8080`), ce qui évite de réutiliser son service worker ou son cache PWA. Pour choisir un autre port :

```bash
PORT=4174 node dev-server.mjs
```

Docker reste disponible uniquement pour vérifier l'image de production et exécuter les tests navigateur.

## Déploiement Docker / Unraid

L’image ne contient qu’un Nginx qui sert les fichiers statiques : il n’y a ni Node.js en production ni base de données serveur.

Pour un essai local :

```bash
docker compose up -d --build
```

L’application est alors disponible sur `http://IP_DU_SERVEUR:8080/app.html`. Sur Unraid, importez ce dossier comme projet Compose, gardez le port hôte `8080` (ou adaptez-le dans `docker-compose.yml`), puis créez un Proxy Host Nginx Proxy Manager vers `reboot-web:80` si les deux conteneurs partagent le même réseau Docker, ou vers `IP_UNRAID:8080` sinon. Le certificat Let's Encrypt et le nom de domaine restent gérés par le proxy ; REBOOT n'a pas besoin de connaître le domaine.

La première ouverture sur un nouveau domaine crée un coffre local indépendant : les données ne migrent donc pas automatiquement entre `localhost`, l'adresse IP et le domaine final. Le menu **Sauvegardes** sépare la création et la restauration. Une archive peut être simple ou protégée par un code personnel.

## Tests navigateur dans Docker

Les tests utilisent un navigateur Playwright neuf, sans cache ni service worker persistant :

```bash
docker compose --profile test up --build --abort-on-container-exit --exit-code-from reboot-tests
```

Pour forcer une instance entièrement neuve après une modification :

```bash
docker compose down --remove-orphans
docker compose --profile test up --build --force-recreate --abort-on-container-exit --exit-code-from reboot-tests
```

Ils vérifient la première configuration, les réserves annuelles et temporaires, les corrections et l'historique, le lien calculateur/suivi sans double déduction, les sauvegardes chiffrées, le réimport CSV et le contrôle bancaire local.

Docker ne sert que `web/`. Aucun backend applicatif n'est présent.

## Google Drive (optionnel, connexion utilisateur)

La page **Google Drive** explique d’abord que le budget reste local. L’utilisateur peut ensuite créer une synchronisation simple ou protégée, sans backend. Une fois la synchronisation configurée, l’écran affiche son état et propose explicitement d’envoyer les changements locaux ou de récupérer ceux du Drive. Le Client ID OAuth du site est configuré une fois dans `web/google-config.js` : les visiteurs n’ont rien à renseigner, ils se connectent simplement à leur compte Google. Avant de publier, activez **Google Drive API** et ajoutez l’origine JavaScript exacte du site, par exemple `https://budget.exemple.fr`, dans Google Cloud. Le scope demandé est limité à `https://www.googleapis.com/auth/drive.file` : l’application ne manipule que le fichier qu’elle crée.

Le Client ID est public par nature : il peut être livré dans Git et dans le navigateur. En revanche, le code secret OAuth ne doit jamais être ajouté au dépôt ni à l’application. Le jeton d’accès Google est temporaire. L’utilisateur choisit entre une copie simple, lisible dans son Drive, ou une copie chiffrée dans son navigateur avec un code personnel téléchargeable. REBOOT utilise le modèle de jeton OAuth et un upload multipart, comme décrit dans les guides Google sur le [modèle de jeton OAuth](https://developers.google.com/identity/oauth2/web/guides/use-token-model) et l’[envoi de fichier Drive](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

Chaque utilisateur connecte son propre compte Google et obtient son propre fichier chiffré. Pour retrouver son budget sur un autre appareil, il se reconnecte à ce même compte et reprend son code de chiffrement. Lors d’un envoi, REBOOT récupère et fusionne les dépenses, remboursements, réserves, opérations bancaires et historique avant de réécrire l’archive chiffrée. En cas d’édition concurrente du calculateur structurel, la version la plus récemment modifiée est conservée. Le partage d’un budget entre deux comptes Google distincts demandera ensuite l’ajout du sélecteur Google Drive, afin de conserver le périmètre d’accès minimal `drive.file`.

## Données et confidentialité

La logique métier s'exécute dans le navigateur. Les données sont conservées dans IndexedDB et chiffrées avec Web Crypto. Les CSV sont lus localement. Google Drive est appelé directement par le navigateur après chiffrement ; aucun serveur REBOOT ne reçoit de données financières.

## Vérifications rapides

```bash
node --check web/app.js
node --check web/sw.js
node --check web/secure-storage.js
node --check web/archive.js
node --check web/drive.js
docker compose config --quiet
```
