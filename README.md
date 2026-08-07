# REBOOT Web

Application web statique local-first pour suivre le budget hebdomadaire d'un foyer.

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

Ils vérifient la première configuration, la sauvegarde locale après rechargement, la déduction d'une réserve, la consigne de virement et la fermeture d'une popup vide.

Docker ne sert que `web/`. Aucun backend applicatif n'est présent.

## Données et confidentialité

La logique métier s'exécute dans le navigateur. Les données sont conservées dans IndexedDB et chiffrées avec Web Crypto. Les CSV sont lus localement. Google Drive, lorsqu'il sera activé, sera appelé directement par le navigateur après chiffrement ; aucun serveur REBOOT ne recevra de données financières.

## Vérifications rapides

```bash
node --check web/app.js
node --check web/sw.js
node --check web/secure-storage.js
docker compose config --quiet
```
